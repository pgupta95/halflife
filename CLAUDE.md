# Driftwood / halflife

Semantic drift observability. Take a grounded physics question, ask a model to
write a similar one, feed it back, repeat. Rank models by how many generations
their questions survive before they stop being answerable.

## Documents

| File | Role |
|---|---|
| `driftwood-architecture-v0.2.md` | The spec. Authoritative on **what** we measure. Schema, evaluation axes, death rule, API surface, Track 2. Do not edit without a reason — it is a considered document |
| `driftwood-execution-gcp-v0.1.md` | The build plan. Authoritative on **how** we build it: stack, costs, and seven spec issues (§3) that must be applied to the schema |

Read both before touching code. §3 of the execution plan is the delta between
the spec's SQL and the migrations we actually write.

## Decisions locked

- **Target:** local Mac + GCP project `halflife-506215`, region `us-central1`.
- **Models:** Vertex AI only, mixed tiers — Gemini (Pro + Flash) + Claude via
  Model Garden + Llama/Mistral/Qwen/DeepSeek via MaaS. Roster is config-driven;
  exact IDs still need confirming against `infra/preflight.sh` output.
- **Infra:** local-first. Postgres in Docker, compute on the Mac, one GCS bucket
  for backups. **No Cloud SQL, no service accounts, no Secret Manager until week
  6**, when Slack forces a public endpoint. A full sweep is 110 MB.
- **Current milestone:** week 1, then review. Build the schema, the gateway, and
  one hand-run chain at depth 5 — then stop so the mutate prompt gets human eyes.

## Cost model, in one line

Mutating 1,250 questions on a mid-shelf model costs **$0.62**. Everything else
in the evaluator is deterministic math except referent resolution, which is the
only model spend and swings a sweep between $3 and $28 depending on the
unique-entity cache-hit rate. **Measuring that rate is the pilot's main job.**

Do not add LLM calls where math will do. The spec's §2 decision — death axis is
"objective and countable" — is a cost decision as much as a science one.

## Spec issues to apply (execution plan §3)

Working through these is week 1's schema task:

1. **§3.1** `runs.temperature` nullable + add `reasoning_config JSONB`. Current
   Claude models reject `temperature` outright, so sampling config cannot be
   fixed across the roster — it gets recorded and published as a confound.
2. **§3.2** Answers are **lazy** — generated when a question enters a season, not
   for all 12,500. Saves $212/sweep of discarded work.
3. **§3.3** `death_generation` = the **first** generation of the failing streak.
   Lock before calibration; it shifts every Kaplan-Meier median.
4. **§3.4** `drift_* = 1 - cosine_similarity`. Put it in a schema comment.
5. **§3.5** Evaluate generation 0. Seed groundedness < 1.0 means the resolver is
   broken, not that the chain drifted.
6. **§3.6** `known_quantities.normalized_key` + move the unique constraint there.
   **Worth ~$170/sweep** — the highest-leverage change in the build.
7. **§3.7** Add `answers.answer_prompt_id`.
8. **§3.8** Evaluation is **off the critical path** (chains run past death, so
   nothing in the mutate loop reads an evaluation). ChainRunner writes
   `questions` only; the evaluator is a separate pass over completed runs. This
   makes recalibration cost zero model calls.

Also: add a `resolution_deferred` state so a budget-capped referent lookup is
never recorded as a fabrication — that would corrupt `death_generation`.

## Setup

```bash
gcloud auth login
./infra/preflight.sh 2>&1 | tee preflight.txt   # read-only; confirms model roster
./infra/bootstrap-gcp.sh                        # 2 APIs + 1 bucket
gcloud auth application-default login           # Vertex auth

docker compose up -d                            # postgres:16 + pgvector
pnpm install && pnpm db:migrate
```

## Conventions

- **TypeScript, Node 22, pnpm workspaces.** No Turborepo — one developer, one machine.
- **Structured output everywhere.** Zod schemas in `packages/shared`, enforced at
  the gateway boundary. The mutate response carries the question,
  `named_quantities`, **and** the `{quantity_a, relation, quantity_b}` triple —
  the triple comes free with the call, so axis 3 needs no separate model call.
- **Disable thinking where the provider allows it.** It bills as output and
  triples the mutate line. It is also a confound: a thinking model and a
  non-thinking model are not doing the same task.
- **Per-model concurrency caps** live in `models.metadata.max_concurrency`.
  Vertex quotas are per-model; one global cap will throttle or 429.
- **Idempotency is load-bearing.** `UNIQUE (run_id, gen_index)` makes every
  generation append safe to retry — that is what lets a laptop sleep mid-sweep.
- **`known_quantities` has no TTL, ever.** Cross-sweep caching is what keeps
  resolution cheap.

## Open items

- Run `infra/preflight.sh` and pin the roster to real Vertex model IDs.
- Confirm Gemini/MaaS per-token rates and the grounding price per request —
  the three inputs the cost model still takes from documentation.
- Decide pilot vs full sweep at the week 3 gate (cost is not the deciding factor
  at ~$42; threshold calibration and quota discovery are).
