# Driftwood: Execution Plan (Mac + GCP + Vertex)

**Doc type:** Execution plan v0.1
**Pairs with:** `driftwood-architecture-v0.2.md` (the architecture spec is unchanged and remains authoritative on *what* we are measuring)
**Purpose:** Re-target the v0.2 stack onto a local Mac dev machine, GCP for storage, and Vertex AI for all model calls. Flags the spec decisions that this re-targeting invalidates.

---

## 1. Stack delta

A full 10-model sweep is **110 MB on disk** — 77 MB of that is embeddings. This
is a single-user benchmark that runs on one laptop and produces less data than a
phone camera roll. The infrastructure is sized accordingly.

| Layer | v0.2 spec | This build | Why |
|---|---|---|---|
| Language | TypeScript (Node 22), pnpm + Turborepo | **pnpm workspaces, no Turborepo** | Turbo's remote caching earns its keep in CI across a team. One developer, one machine, seven packages — `pnpm -r` is enough |
| Database | Neon/Supabase Postgres 16 + pgvector | **Local Postgres 16 + pgvector in Docker** (`pgvector/pgvector:pg16`) | Same engine, same extension, same migrations. Free, and no network round trip on the per-generation query the ChainRunner runs 12,500 times. Lifts to Cloud SQL with `pg_dump`/`pg_restore` when week 6 needs it |
| Backups | *(none)* | **GCS bucket, versioned.** `pg_dump` after each sweep | The chains are the irreplaceable artifact — re-running costs money *and* returns different data, because the models underneath have moved. 110 MB is ~$0.002/month. This is the "data in GCP" requirement, satisfied for a fifth of a cent |
| Durable execution | Inngest v1 → Temporal | **`graphile-worker`** | Needs no public webhook URL to drive a laptop, and `UNIQUE (run_id, gen_index)` already makes every step idempotent |
| LLM gateway | OpenRouter / LiteLLM | **Vertex AI** behind a thin `ModelGateway` | The one genuinely cloud dependency. ADC auth, no infra to create |
| Embeddings | *(VECTOR(1536))* | **Vertex `gemini-embedding-001`, `output_dimensionality: 1536`** | Matches the spec's column exactly |
| Search-grounded resolver | "search-grounded model call" | **Gemini + Google Search grounding** | Native on Vertex; the only model spend in the evaluator (§4.1) |
| Survival stats | `lifelines` Python sidecar | **Kaplan-Meier in SQL** | The spec offers both. At 250 chains, KM with Greenwood CIs is ~40 lines of SQL against a table we already have — versus adding Python, `uv`, FastAPI, and a second process to the stack. Revisit if we need competing-risks models |
| API / Frontend | Fastify / Next.js 15 on Vercel | **unchanged code, runs locally** | |
| Cache | Upstash Redis | **dropped** | The only hot cache is referent resolution, which must be durable — so it is a Postgres table, not Redis |
| LLM tracing | Langfuse self-hosted | **dropped** | `raw_response` is already in Postgres |
| Secrets | *(unspecified)* | **`.env`, until week 6** | Vertex uses ADC. Local Postgres has a local password. There are no secrets until Slack tokens arrive |
| Service accounts / IAM | *(unspecified)* | **none, until week 6** | ADC with your user credentials covers Vertex. A service account is for unattended cloud compute, which does not exist yet |
| Hosting | Vercel + Fly.io | **the Mac** | |
| Slack | Bolt HTTP mode | **week 6** | Genuinely needs always-on and a public URL — see below |

**Nothing in the v0.2 schema changes.** Stock Postgres 16 + pgvector + pgcrypto,
identical locally and on Cloud SQL.

### What the whole stack is

```
Node 22 + pnpm          one repo
Docker                  one container: postgres:16 + pgvector
Vertex AI               ADC, no infra
GCS                     one bucket, ~$0.002/mo
```

### When cloud infra becomes necessary

Exactly one trigger: **Slack needs a public HTTPS endpoint and an always-on cron**,
so week 6 lifts the API to Cloud Run and the database to Cloud SQL. That is also
the point where the project has proven itself worth ~$25/month. Until then,
paying $38 in Cloud SQL charges across the build to hold the results of a $42
sweep is the wrong shape.

## 2. The Vertex gateway

Vertex is not one API. The roster spans three request shapes, and the `ModelGateway` interface has to normalise all three down to `(context_window, schema) -> {question, named_quantities[]}`:

| Family | Access path | Client | Structured output |
|---|---|---|---|
| Gemini | Vertex 1P | `@google-cloud/vertexai` | `responseSchema` (OpenAPI subset) |
| Claude | Vertex Model Garden (partner) | `@anthropic-ai/vertex-sdk` → `new AnthropicVertex({projectId, region})`; bare model IDs, ADC auth, no Anthropic key | `output_config.format` via `zodOutputFormat` — GA on Vertex |
| Llama / Mistral / Qwen / DeepSeek | Vertex MaaS | OpenAI-compatible endpoint | JSON mode support **varies by model**; some need a tool-call shim |

Consequences worth knowing before week 1:

- **Every Model Garden model needs per-model enablement** in the GCP console before its first call, and several need a quota increase request. Budget a day of clicking, not an hour.
- **Vertex enforces per-model QPM/TPM quotas.** 250 chains in parallel will throttle hard. The worker needs a **per-model concurrency cap** read from the `models` table (`metadata.max_concurrency`), not one global cap. This is the difference between "one afternoon" and "three days of 429s."
- **No Message Batches for Claude on Vertex.** The 50% batch discount does not exist on this path. Gemini has its own Batch Prediction API (also ~50% off) — worth using for the *evaluation* pass, which is latency-insensitive, even though the mutate pass must stay synchronous (each generation depends on the last).
- **No Models API on Vertex** — the `models` table is hand-maintained. That is fine; the spec wants pinned versions anyway.

---

## 3. Spec issues found while re-targeting

Ordered by how much they cost if we discover them in week 4 instead of week 0.

### 3.1 `runs.temperature` is not enforceable across the roster — **blocking for the leaderboard's validity**

Risk §11 says "fix temperature across the leaderboard or report it as a dimension. Never mix." We cannot fix it.

Current-generation Claude models (Opus 5, Sonnet 5, Opus 4.8/4.7, Fable 5) **removed sampling parameters** — sending `temperature` returns a 400. Gemini still accepts `temperature` (range 0–2). Llama/Mistral via MaaS accept it. So the roster splits into "temperature is a knob" and "temperature does not exist," and no setting makes them comparable.

The same applies to reasoning: Claude Opus 5 runs adaptive thinking *by default*; Gemini has an independent thinking-budget config; most MaaS models have neither. A thinking model and a non-thinking model are not doing the same task when asked to mutate a question.

**Recommendation.** Stop treating sampling config as a controlled variable and start treating it as recorded metadata:
- Make `runs.temperature` nullable; `NULL` means "provider default, not settable."
- Add `runs.reasoning_config JSONB` recording exactly what was sent (`{effort: "low"}`, `{thinkingBudget: 0}`, `{}`).
- Set Claude models to `output_config: {effort: "low"}` with adaptive thinking left on — do **not** disable thinking on Opus 5; it has documented failure modes where tool calls leak into visible text.
- Report sampling/reasoning config as a column on the published leaderboard, next to `censored_chains`. It is a confound we disclose, not one we eliminate.

This is honest and it is still a publishable benchmark. Claiming a fixed temperature we did not fix would not be.

### 3.2 Answers should be lazy — **~$212 per sweep, for nothing**

The pipeline as drawn generates an answer for every question (`PG --> ANS` for all 12,500). But §2 locks "grading target = the generated question only," and answers never touch the leaderboard. They exist for Track 2, which consumes **one question per day**.

Answering all 12,500 at Opus-tier rates costs roughly $212/sweep and is thrown away.
Unlike the mutate calls, answers all go to one static answerer, so there is no
spread across tiers to soften it — this single line is larger than the rest of
the sweep combined.

**Recommendation.** Generate answers on demand — when a question is queued into a season, and on re-roll. The `answers` table already models this correctly (one-to-many off `questions`, `attempt` column); only the trigger needs to move. Cuts total sweep cost by roughly 80%, and is the
largest single saving available anywhere in the build. §4.3 covers whether the
remaining one-per-day answer should come from the API or a Pro subscription.

### 3.3 Death generation is ambiguous under two-generation persistence

"Fire a death event at the first generation N where `groundedness < 0.5` for two consecutive generations." If gens 12 and 13 both fail, is `death_generation` 12 or 13?

It matters: Kaplan-Meier medians shift by a full generation, and the whole leaderboard is a ranking of that number.

**Recommendation.** `death_generation` = **the first generation of the failing streak** (12). It's the generation the chain actually stopped being answerable; the second is confirmation, not death. Record the confirming generation in `death_events.evidence`. Lock this before calibration, since the hand-labelled window will be fit against it.

### 3.4 `drift_from_parent < 0.02` has no stated definition

Cosine *distance* (`1 - cos_sim`) and cosine *similarity* are both plausible readings, and 0.02 is a sane threshold under exactly one of them. Assuming distance: `drift = 1 - cosine_similarity`, so `< 0.02` means "≥ 0.98 similar to its parent for four straight generations" = attractor. That reading matches the Perez et al. framing in §10.

**Recommendation.** Define `drift_* = 1 - cosine_similarity` in the evaluator, and name the columns' semantics in a schema comment so nobody re-derives it the other way in month three.

### 3.5 Generation 0 needs an evaluation row

The seed is `gen_index = 0`, and `drift_from_seed` is measured against it. Nothing in the spec says the seed itself gets a `question_evaluation`. It should: it establishes the baseline (`groundedness` should be 1.0 on a grounded seed — if it isn't, the resolver is broken *before* any drift happened), and it's the cheapest possible resolver-precision canary.

**Recommendation.** Evaluate gen 0. Treat "seed groundedness < 1.0" as a build-time assertion on the resolver, not a death signal.

### 3.6 `known_quantities` will fragment on free-text labels

`UNIQUE (entity_label, unit)` where `entity_label` comes verbatim from model output. "Porsche Taycan battery capacity", "Taycan battery", "battery capacity of a Porsche Taycan" are three rows for one fact — so the cache under-hits, the search fallback fires more often, and the fallback is the expensive call.

**Recommendation.** Add `normalized_key TEXT` (lowercased, stop-worded, `wikidata_qid`-preferred when resolved) and move the unique constraint there, keeping `entity_label` as the display value. Given §10's warning about strong entity attractors (blue whales, Olympic pools), cache hit rate is a first-order cost driver.

### 3.7 Reproducibility gap: no `answer_prompt_id`

`runs.mutate_prompt_id` pins the mutate template. `answers` has no equivalent pointer into `prompt_templates`, so an answer cannot be re-derived from the record. Symmetric with a risk §11 already cares about.

**Recommendation.** Add `answers.answer_prompt_id UUID REFERENCES prompt_templates(id)`.

---

### 3.8 Evaluation is not on the critical path — batch it

The v0.2 sequence diagram runs the evaluator inline, one generation at a time,
with the death detector feeding back into the ChainRunner. But §5 locks **"keep
running past death — continue to `max_generations` and persist everything."**

If the chain never terminates early, the chain never needs the evaluation. Nothing
in the mutate loop reads a `question_evaluation`. The feedback edge in the diagram
carries no decision.

**Recommendation.** Split the pipeline in two:

1. **ChainRunner** — synchronous, generation by generation, because gen N needs
   gens N-5..N-1. Writes `questions` only. Per-model concurrency caps.
2. **Evaluator** — a separate job over completed runs. Resolves referents,
   runs the dimensional and structural checks, embeds, scores drift, fires death
   events retrospectively.

Three things fall out: the evaluator becomes trivially parallel and restartable
independent of the chains; re-running a new `evaluator_version` over stored chains
costs no model calls at all, which is exactly what calibration needs; and the
evaluator's own model calls become batchable (see §4.4).

The one check that must stay inline is `format_failure` — two consecutive
structured-output parse failures. That needs no model call, just a failed parse.

---

## 4. Cost model

### 4.1 What actually needs a model call

Auditing this against the spec, the evaluator is **already almost entirely
deterministic** — the §2 decision to make the death axis "objective and countable"
did most of this work already. Only one line is a model call:

| Evaluator step | Mechanism | Cost |
|---|---|---|
| Axis 2 — dimensional well-formedness | `js-quantities` dimensional analysis | **$0** — pure math |
| Axis 3 — structural preservation | **Comes free with the mutate call.** The mutate response is already structured output carrying `named_quantities`; extend the schema to return `{quantity_a, relation, quantity_b}` and the triple arrives with the question. A failure to produce it *is* the structure-lost signal | **$0** — no separate call |
| Drift from seed / parent | Cosine over stored embeddings | **~$0** — embeddings are ~$0.01/sweep |
| Degenerate-loop detection | Threshold over drift series | **$0** — pure math |
| Death rule | Boolean logic over the above | **$0** — pure math |
| Answer verification (publish gate) | `mathjs` recompute + unit check | **$0** — pure math, and already spec'd this way |
| Axis 1 — referent resolution | `known_quantities` → Wikidata SPARQL → **grounded search** | **the only model spend** |

Axis 3 was costed as a separate extraction call in earlier drafts of this doc.
It is not one. That was my error.

So the entire evaluator reduces to a single question: *how often does a referent
miss both the cache and Wikidata?*

### 4.2 One mid-shelf model, measured

Baseline: **one Gemini Flash-tier model** ($0.30 / $2.50 per Mtok), 5 seeds ×
5 replicates × 50 generations = **1,250 mutate calls**, thinking disabled,
400 in / 150 out.

| Line | Volume | Cost |
|---|---|---|
| Mutate input | 0.500 Mtok | $0.15 |
| Mutate output | 0.188 Mtok | $0.47 |
| **Mutate total** | 1,250 calls | **$0.62** |
| Embeddings | 0.063 Mtok | $0.01 |
| Dimensional / structural / drift / death | — | $0.00 |
| Referent resolution | see below | $2.36 – $27.56 |

**Generating 1,250 question mutations costs 62 cents.** You were right that this
should be cheap; it is. Every remaining dollar is referent resolution.

### 4.3 The only real variable

3 referents × 1,250 questions = 3,750 lookups per sweep. Wikidata resolves perhaps
40% of the uniques for free. Grounded search runs ~$35/1k. Everything hinges on
what fraction of those 3,750 are *distinct entities after normalisation*:

| Unique-entity rate | Grounded calls | Cost | Sweep total |
|---|---|---|---|
| 3% | 68 | $2.36 | **$2.99** |
| 5% | 112 | $3.94 | **$4.57** |
| 10% (central) | 225 | $7.88 | **$8.50** |
| 20% | 450 | $15.75 | **$16.38** |
| 35% | 788 | $27.56 | **$28.19** |

**This rate is the single number worth measuring, and nobody can predict it.**
§10 predicts strong entity attractors (blue whales, Olympic pools,
Hiroshima-equivalents), which pushes it low; drifting questions inventing novel
constants pushes it high. Measuring it is the pilot's most valuable output —
more than the drift curves.

Two things move it, both cheap:
- **§3.6 normalised cache keys.** Collapsing "Porsche Taycan battery capacity" /
  "Taycan battery" / "battery of a Taycan" into one row is the difference between
  the top and bottom of that table.
- **Cache across sweeps, permanently.** `known_quantities` has no TTL and should
  not get one. Sweep 2 pays only for entities sweep 1 never saw, so the marginal
  cost of re-running a sweep trends toward the mutate line alone (~$0.62).

### 4.4 Batching — not yet

Gemini Batch Prediction is ~50% off and, per §3.8, the evaluator is off the
critical path so it is eligible. But at a $2–8 evaluator line, batching saves
$1–4 and buys polling, job management, and partial-failure handling.

**Verdict: skip it.** Revisit when the evaluator line clears ~$50/sweep — which
means a 10-model roster *and* a unique-entity rate at the bad end of §4.3. Note it
in the code as the intended escape hatch, don't build it.

Embeddings are also batchable at 50% off. That saves half a cent. No.

### 4.5 Projection to the full roster

Scaling the measured single-model baseline. Mutate scales linearly per model with
tier; referent resolution scales **sub**-linearly, because models converge on the
same attractor entities and share one cache.

| Configuration | Mutate | Resolution | Total |
|---|---|---|---|
| 1 mid-shelf model (measured above) | $0.62 | ~$7.88 | **~$8.50** |
| 3 models — pilot roster | ~$3 | ~$12 | **~$15** |
| 10 models — full roster | ~$18 | ~$24 | **~$42** |
| 10 models, re-sweep on a warm cache | ~$18 | ~$3 | **~$21** |

Standing infrastructure: **~$0.002/mo** — one GCS bucket holding 110 MB of
backups. Postgres is a local Docker container; compute is the Mac.

**Confidence.** Mutate arithmetic is solid. The Flash-tier and grounding rates
should be confirmed against the live pricing page — see §4.6. The unique-entity
rate is a genuine unknown and the pilot exists largely to pin it.

### 4.6 What is still unverified

Three inputs in this model are from documentation rather than from your project,
and all three are checkable in about ten minutes with `infra/preflight.sh`:

1. **Exact model IDs available in the region.** The roster here is tier-based;
   Vertex model IDs and their regional availability change.
2. **Live per-token rates** for the Gemini tier and MaaS models.
3. **Grounding price per request**, which drives the dominant line.

## 5. Repo layout

```
halflife/
├── apps/
│   ├── api/            Fastify — /v1 (public) + /internal
│   ├── web/            Next.js 15 dashboard
│   └── worker/         graphile-worker: ChainRunner, evaluator, answerer
├── packages/
│   ├── db/             Drizzle schema + migrations (v0.2 SQL, verbatim + §3 fixes)
│   ├── gateway/        ModelGateway — Vertex Gemini / Claude / MaaS adapters
│   ├── eval/           referent resolver, dimensional check, drift, Kaplan-Meier SQL
│   └── shared/         zod schemas, types
└── infra/
    ├── bootstrap-gcp.sh    enable 2 APIs, create 1 bucket
    ├── preflight.sh        read-only project/roster check
    └── README.md

docker-compose.yml          the entire data tier
```

---

## 6. Revised build order

Weeks 1–6 track the spec's §9. Changes are marked ▲.

1. **Week 1 — foundation.** ▲ `docker compose up`, GCS bucket, Vertex enablement — that is the whole bootstrap. Schema + migrations including the §3 fixes. `ModelGateway` with all three Vertex adapters behind one Zod-enforced interface. ▲ Enable and smoke-test every roster model — this is where Model Garden enablement and quota requests surface. Run one chain by hand at depth 5 and read the output.
2. **Week 2 — the long pole.** Referent resolver: `known_quantities` (with §3.6 normalisation), Wikidata SPARQL, Gemini-grounded fallback with write-back. Budget three weeks, per the spec.
3. **Week 3 — measurement.** Dimensional + structural checks, death detector (with §3.3 locked), ChainRunner on `graphile-worker` with per-model concurrency caps. ▲ **Pilot sweep** (2×3×2). Hand-label 50 chains, calibrate, run the seed-sufficiency test. Full sweep only once thresholds are fit.
4. **Week 4 — serving.** ▲ Kaplan-Meier in SQL, leaderboard MV, public read API, dashboard with drift chart + KM curves.
5. **Week 5 — Track 2 prep.** ▲ Lazy static answerer, math verification gate, human approval queue.
6. **Week 6 — the drip.** ▲ **The one week that needs cloud infra.** Lift Postgres to Cloud SQL (`pg_dump`/`pg_restore`) and the API to Cloud Run, because Slack needs a public HTTPS endpoint and an always-on cron. Add the service account and Secret Manager here, where they first earn their place. Slack app, seasons, cron drip, Block Kit.

---

## 7. Operational notes for a laptop

- **Mac sleep kills in-flight work.** `graphile-worker` retries the interrupted generation on wake — safe, because `UNIQUE (run_id, gen_index)` makes the append idempotent. Run long sweeps with `caffeinate -is pnpm sweep`.
- **Cloud SQL Auth Proxy** as a `launchd` agent, so the DB connection survives a reboot without a manual step.
- **ADC tokens expire.** `gcloud auth application-default login` needs re-running periodically; the worker should fail loudly on an auth error rather than marking runs `failed`.
- **Cost guard.** A `max_cost_usd` breach halts the batch and leaves runs resumable — never let a runaway loop discover the budget for us.
