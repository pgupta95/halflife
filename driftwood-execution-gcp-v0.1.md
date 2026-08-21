# Driftwood: Execution Plan (Mac + GCP + Vertex)

**Doc type:** Execution plan v0.1
**Pairs with:** `driftwood-architecture-v0.2.md` (the architecture spec is unchanged and remains authoritative on *what* we are measuring)
**Purpose:** Re-target the v0.2 stack onto a local Mac dev machine, GCP for storage, and Vertex AI for all model calls. Flags the spec decisions that this re-targeting invalidates.

---

## 1. Stack delta

| Layer | v0.2 spec | This build | Why |
|---|---|---|---|
| Language | TypeScript (Node 22), pnpm + Turborepo | **unchanged** | |
| Database | Neon/Supabase Postgres 16 + pgvector | **Cloud SQL for Postgres 16 + pgvector**, reached via Cloud SQL Auth Proxy on the Mac | "Data in GCP." pgvector is a supported extension. Single zonal instance, no HA — this is a benchmark, not a service |
| Blob storage | *(none)* | **GCS bucket** `gs://<proj>-driftwood-raw` — raw provider responses as per-run JSONL, plus nightly `pg_dump` | Keeps `raw_response` JSONB from bloating a small instance; gives a re-derivable archive if the DB is ever rebuilt |
| Durable execution | Inngest v1 → Temporal | **`graphile-worker`** (Postgres-backed queue, in-process on the Mac) | Inngest needs a public webhook URL to drive a laptop. A Postgres queue gives retries, backoff, and per-queue concurrency caps with zero extra infra, and the state lives in the same DB as the results. `UNIQUE (run_id, gen_index)` already makes every step idempotent — that's the hard part, and the spec already solved it |
| LLM gateway | OpenRouter / LiteLLM | **Vertex AI**, behind our own thin `ModelGateway` interface | See §2 — the gateway is not optional here, because Vertex speaks three different request shapes |
| Embeddings | *(unspecified, VECTOR(1536))* | **Vertex `gemini-embedding-001`, `output_dimensionality: 1536`** | Matroyshka truncation to exactly 1536 means the spec's `VECTOR(1536)` column needs no change |
| Search-grounded resolver | "search-grounded model call" | **Gemini on Vertex with Google Search grounding** | Native on Vertex, and cheaper than Claude's server-side web search. Note: Claude-on-Vertex only offers the basic `web_search_20250305` variant, and no web *fetch* at all |
| LLM tracing | Langfuse self-hosted | **deferred.** `raw_response` in Postgres + JSONL in GCS | Another container to babysit on a laptop for observability we can get from the DB in week 1. Revisit if debugging gets painful |
| Cache | Upstash Redis | **deferred.** `known_quantities` table + in-process LRU | The only hot cache we need is referent resolution, which must be durable anyway — so it belongs in Postgres, not Redis |
| Survival stats | `lifelines` Python sidecar | **unchanged** — FastAPI on `127.0.0.1`, `uv`-managed | |
| API / Frontend | Fastify / Next.js 15 on Vercel | **unchanged code, runs locally.** Cloud Run is the documented later path | |
| Slack | Bolt HTTP mode | **deferred to week 6.** Needs a public URL → Cloud Run then, not the Mac | |
| Secrets | *(unspecified)* | **GCP Secret Manager**, ADC for Vertex (`gcloud auth application-default login`) | No API keys on disk; Vertex auth is ADC-based by design |

**Nothing in the v0.2 schema needs to change to run on Cloud SQL.** It is stock Postgres 16 + pgvector + pgcrypto. The migration files transfer as written.

---

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

## 4. Cost model for the first sweep

5 seeds × 10 models × 5 replicates × 50 generations = 12,500 mutate calls,
spread across 10 models = **1,250 calls per model**. Most of the roster is
Flash/Haiku/MaaS tier, so pricing the sweep at frontier rates overstates it
several-fold.

### 4.1 Mutate calls

| Scenario | in / out tokens | Sweep cost |
|---|---|---|
| Generous (5-question window, verbose template) | 700 / 250 | $30.07 |
| **Target: terse template, thinking off** | **400 / 150** | **$17.74** |
| Target template, thinking left on | 400 / 500 | $45.09 |
| Floor (200 words in / 30 words out) | 270 / 40 | $7.19 |

**400 in / 150 out is the number to design for.** The floor is not reachable
because two things get billed that are not prose: the output schema counts as
input (~100 tokens), and `named_quantities` — three entries of `{label, value,
unit}` — is most of the output JSON, not the 30-word question.

**Thinking tokens are the real variable, and they are invisible.** Claude Opus 5
runs adaptive thinking by default; Gemini's thinking budget is on by default.
Thinking bills as output, and leaving it on roughly triples the output line
($17.74 → $45.09). Disable it wherever the provider allows:

- Gemini Flash tier: `thinkingConfig: {thinkingBudget: 0}`
- Claude: `thinking: {type: "disabled"}` is accepted at effort `high` or below.
  The documented failure mode (tool calls leaking into visible text) is specific
  to tool use; we use structured output, so the exposure is lower — but verify on
  the pilot before trusting it across a sweep.
- Gemini Pro tier: cannot be fully disabled on all versions.
- MaaS open-weight: mostly no thinking to disable.

This is a §3.1 decision as much as a cost one. A thinking model and a
non-thinking model are not performing the same task when asked to mutate a
question, so disabling it where possible makes the comparison *more* honest, not
just cheaper — and where it cannot be disabled, that goes in `reasoning_config`
and gets published as a confound.

**Prompt caching does not apply here.** The stable prefix (template + schema) is
~250 tokens, below the ~1024-token minimum cacheable prefix. So shrinking the
prompt carries no hidden cache penalty — it is a straight win.

**Watch for question growth.** These estimates assume ~25-word questions. Degrading
questions tend to get *longer* — more qualifiers, more invented entities — so a
5-question window at generation 45 may be several times a window at generation 5.
The schema already records `prompt_tokens` / `completion_tokens` per generation;
the pilot gives the real curve, and the estimate should be refit against it rather
than trusted.

### 4.2 Evaluator — now the dominant line

**This is the cost centre, not mutation.** Referent resolution falls through
`known_quantities` (free) → Wikidata SPARQL (free) → grounded search
(~$35 per 1,000 requests). At ~3 referents per question, a sweep raises 37,500
referent instances, and everything depends on how many collapse to the same cache key:

| Cache behaviour | Grounded calls | Cost |
|---|---|---|
| Good — normalised keys, §3.6 applied (3% unique) | 675 | **$23.63** |
| Poor — raw `entity_label` matching (25% unique) | 5,625 | **$196.88** |

**The §3.6 normalisation fix is worth ~$170 per sweep** — more than every other
line combined. It is the single highest-leverage optimisation left, and it is a
schema change plus a normalisation function, not a research problem.

**If you cap the resolver budget, do not let a skipped lookup count as a
fabrication.** A cost-capped lookup that gets recorded as `fabricated` kills the
chain early and corrupts the death generation — exactly the failure risk §11
warns about. Needs a third state (`resolution_deferred`) that is excluded from
the `groundedness` denominator rather than counted against it.

### 4.3 Answers, embeddings, standing cost

| Line | Cost | Notes |
|---|---|---|
| Answers — eager, all 12,500 | *$212.50* | *As the v0.2 pipeline is drawn. All discarded — see §3.2* |
| **Answers — lazy, 1/day via API** | **$6.21/yr** | Track 2 consumes one question per day |
| Answers — lazy, via Pro subscription | $0 | Saves $6.21/yr; costs the automation — see below |
| Embeddings | < $1 | 12.5k × ~50 tokens, `gemini-embedding-001` |
| Cloud SQL + GCS, standing | ~$25–40/mo | `db-g1-small`; try `db-f1-micro` (~$8/mo) first |

**On using a Pro subscription for the daily answer.** The saving is $6.21/year.
Against that: `daily_drops.answer_id` must be populated for the cron to fire, so a
subscription puts a human paste step on the daily critical path, and there is no
`raw_response`, no token counts, and no pinned model version behind it. Since
answers sit outside the leaderboard and already pass a human approval gate, that
loss of provenance is acceptable — but the automation loss is not worth $6.
**Recommendation: API for the scheduled drip; subscription as the manual path for
re-rolls while iterating on answer quality by hand.**

### 4.4 Revised total

| | Per sweep |
|---|---|
| Mutate (thinking off) | $17.74 |
| Evaluator (good cache) | $23.63 |
| Embeddings | ~$1 |
| Answers (lazy) | ~$0 |
| **Total** | **~$43** |

Evaluator cache behaviour is the whole ballgame: at a poor hit rate the same
sweep is ~$215.

`runs.config` carries `max_cost_usd`, enforced per batch per risk §11; the worker
halts the batch on breach.

**Confidence.** Claude per-token rates are published and solid (Vertex partner
pricing differs from first-party — confirm). The Gemini and MaaS rates and the
$35/1k grounding rate are the shakiest inputs and are worth checking against the
Vertex pricing page. The cache hit rate is unknowable until the resolver runs on
real chains, which is the strongest argument for the pilot.

**On phasing.** At ~$43 a sweep, cost is not a reason to pilot first. What survives:
death thresholds are guesses until 50 chains are hand-labelled and re-running
against a corrected threshold wastes days; the resolver cache hit rate — the one
input that swings the total 5× — can only be measured on real chains; and a pilot
surfaces Vertex per-model quota walls before they strand a full sweep. A pilot of
2 seeds × 3 models × 2 replicates (~600 calls, well under $5) buys all three.

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
│   ├── eval/           referent resolver, dimensional check, triple extraction, drift
│   └── shared/         zod schemas, types
├── services/
│   └── stats/          Python + lifelines, FastAPI on 127.0.0.1
└── infra/
    ├── bootstrap-gcp.sh
    └── README.md
```

---

## 6. Revised build order

Weeks 1–6 track the spec's §9. Changes are marked ▲.

1. **Week 1 — foundation.** ▲ GCP bootstrap (project, Cloud SQL, GCS, Secret Manager, Vertex enablement). Schema + migrations including the §3 fixes. `ModelGateway` with all three Vertex adapters behind one Zod-enforced interface. ▲ Enable and smoke-test every roster model — this is where Model Garden enablement and quota requests surface. Run one chain by hand at depth 5 and read the output.
2. **Week 2 — the long pole.** Referent resolver: `known_quantities` (with §3.6 normalisation), Wikidata SPARQL, Gemini-grounded fallback with write-back. Budget three weeks, per the spec.
3. **Week 3 — measurement.** Dimensional + structural checks, death detector (with §3.3 locked), ChainRunner on `graphile-worker` with per-model concurrency caps. ▲ **Pilot sweep** (2×3×2). Hand-label 50 chains, calibrate, run the seed-sufficiency test. Full sweep only once thresholds are fit.
4. **Week 4 — serving.** Stats sidecar, leaderboard MV, public read API, dashboard with drift chart + KM curves.
5. **Week 5 — Track 2 prep.** ▲ Lazy static answerer, math verification gate, human approval queue.
6. **Week 6 — the drip.** ▲ Deploy API to Cloud Run (Slack needs a public URL). Slack app, seasons, cron drip, Block Kit.

---

## 7. Operational notes for a laptop

- **Mac sleep kills in-flight work.** `graphile-worker` retries the interrupted generation on wake — safe, because `UNIQUE (run_id, gen_index)` makes the append idempotent. Run long sweeps with `caffeinate -is pnpm sweep`.
- **Cloud SQL Auth Proxy** as a `launchd` agent, so the DB connection survives a reboot without a manual step.
- **ADC tokens expire.** `gcloud auth application-default login` needs re-running periodically; the worker should fail loudly on an auth error rather than marking runs `failed`.
- **Cost guard.** A `max_cost_usd` breach halts the batch and leaves runs resumable — never let a runaway loop discover the budget for us.
