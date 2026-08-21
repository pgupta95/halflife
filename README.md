# Driftwood / halflife

**Semantic drift observability for LLMs.** Measures how long a model's iteratively-generated questions survive before they collapse into attractors, lose structure, or degenerate into copies.

## What it does

1. Start with a grounded physics question (the seed)
2. Ask a model to write a similar question
3. Feed the new question back as context
4. Repeat until the chain dies
5. Rank models by survival time (death generation)

**Death criteria (Round 2 - deterministic):**
- `structure_lost`: Question becomes unparseable
- `template_lock`: Relation repetition (5 of last 6) OR template dominance (60%+ of last 10)
- `dimension_collapse`: Dimension entropy < 0.8 bits over last 10 generations
- `degenerate_loop`: *(deprecated)* Near-identical copies (never observed)
- `attractor_state`: *(deprecated)* Embedding-based (replaced by template_lock)

## Project Status

**✅ Round 2 In Progress** - Deterministic template detection:
- Local Postgres + pgvector (Docker)
- Vertex AI gateway (Gemini 2.5 Flash)
- **NEW**: Deterministic template lock detection (relation repeat, template dominance, dimension entropy)
- **NEW**: Relation normalization to controlled vocabulary
- Template signature tracking (md5 of dimension_a || relation || dimension_b)
- First run findings: **100% grounded, 0% fabricated** - model drifts to tedium, not nonsense

**Round 1 Finding:** Gemini 2.5 Flash fell into template lock ("how many X fill Y") - groundedness never failed.

**Cost: ~$0.027 per run** (51 questions, generate + full evaluation)

## Quick Start

### Prerequisites
- Node 22+
- Docker (or Colima on macOS)
- GCP account with Vertex AI enabled
- `gcloud` CLI authenticated

### Setup

```bash
# 1. GCP setup
gcloud auth login
gcloud auth application-default login
./infra/preflight.sh 2>&1 | tee preflight.txt
./infra/bootstrap-gcp.sh

# 2. Database
docker compose up -d  # or: colima start && docker compose up -d
pnpm install
pnpm db:migrate

# 3. Seed initial data
./packages/db/node_modules/.bin/tsx packages/db/src/seed-data.ts
```

### Run an Experiment

```bash
# Generate 50 questions with binary search death detection
./scripts/test-chain.ts

# Analyze for attractor states (uses existing drift data)
./scripts/analyze-attractor-from-db.ts

# Calculate costs
./scripts/calculate-costs.ts
```

## Architecture

See the design docs for full details:
- `driftwood-architecture-v0.2.md` - What we measure (schema, death rules, evaluation axes)
- `driftwood-execution-gcp-v0.1.md` - How we build it (stack, costs, §3 spec fixes)

### Key Design Decisions

**Stack:**
- TypeScript, Node 22, pnpm workspaces
- Postgres 16 + pgvector (local Docker)
- Vertex AI only (Gemini, Claude Model Garden, MaaS)
- Local-first: no Cloud SQL, no service accounts until week 6

**Death Detection:**
- Drift = 1 - cosine_similarity (§3.4)
- Evaluate generation 0 (seed groundedness check, §3.5)
- Death generation = first of failing streak (§3.3)
- Evaluation is off critical path (§3.8)

**Cost Optimization:**
- Lazy answer generation - only when questions enter a season (§3.2)
- `known_quantities.normalized_key` for cache hits (§3.6, saves ~$170/sweep)
- Binary search to find death point (avoids evaluating all 50 gens)

## Database Schema

Core tables:
- `runs` - Experiment runs (model, seed, temperature, death_generation)
- `questions` - Generated questions (gen_index, drift metrics, token usage)
- `question_evaluations` - Drift + structure analysis
- `death_events` - When/why chains died (cause, evidence)
- `known_quantities` - Cached referent resolutions (cross-sweep)

Drift tracking (§3 fixes applied):
- Nullable `temperature` + `reasoning_config` JSONB (§3.1)
- `drift_from_seed` and `drift_from_parent` on every question
- Attractor detection via sliding window analysis

## Current Results

**First Run: Gemini 2.5 Flash**
- Seed: "How many MacBook Airs could you charge with a Porsche Taycan battery?"
- Death: Generation 17
- Cause: `attractor_state`
- Pattern: Converged to "How many [small things] to fill [large container]?" template
- Cost: $0.027 (51 questions generated + evaluated)

**Drift Analysis:**
- Mean drift at death: 0.4436
- StdDev at death: 0.0688
- Drift from seed remained stable (0.50-0.63)
- Drift from parent showed low variance (attractor indicator)

## Scripts

**Production:**
- `scripts/test-chain.ts` - Binary search experiment runner
- `scripts/analyze-attractor-from-db.ts` - Detect attractors from existing drift data
- `scripts/calculate-costs.ts` - Cost analysis for runs

**Archive** (in `scripts/archive/`):
- Development/testing scripts from initial setup
- Model discovery and API testing scripts
- Legacy evaluation scripts (before attractor detection)

## Development Conventions

- **Structured output everywhere** - Zod schemas enforced at gateway
- **Disable thinking** where possible (it triples mutate cost)
- **Idempotency is load-bearing** - `UNIQUE (run_id, gen_index)` makes retries safe
- **Per-model concurrency caps** - Vertex quotas are per-model
- **No TTL on `known_quantities`** - Cross-sweep caching is essential
- **Never commit secrets** - `.env` in `.gitignore`

## Next Steps

- [ ] Run on more models (Claude, Llama, Mistral via Model Garden/MaaS)
- [ ] Calibrate attractor threshold (current: mean < 0.45, stddev < 0.10)
- [ ] Tune mutate prompt to avoid "fill" attractor
- [ ] Implement referent resolution for groundedness checks
- [ ] Set up Track 2 (drip mode) for continuous monitoring

## Documentation

- `CLAUDE.md` - Project handoff document for Claude Code CLI
- `driftwood-architecture-v0.2.md` - Authoritative spec (DO NOT EDIT without reason)
- `driftwood-execution-gcp-v0.1.md` - Build plan with §3 spec deltas
- `packages/db/migrations/` - Database migration history

## License

See LICENSE file.
