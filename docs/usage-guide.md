# Usage Guide

Quick reference for running Driftwood experiments.

## Prerequisites

- Node 22+
- Docker running (or Colima on macOS)
- GCP project with Vertex AI API enabled
- Authenticated `gcloud` CLI

## Initial Setup (One-time)

### 1. GCP Authentication

```bash
# Authenticate your user account
gcloud auth login

# Set up application default credentials for Vertex AI
gcloud auth application-default login

# Verify your project
gcloud config get-value project
# Should output: halflife-506215 (or your project ID)
```

### 2. Enable APIs and Create Bucket

```bash
# Check which models are available
./infra/preflight.sh 2>&1 | tee preflight.txt

# Enable required APIs and create GCS bucket
./infra/bootstrap-gcp.sh
```

### 3. Database Setup

```bash
# Start Postgres (Docker)
docker compose up -d

# Or on macOS with Colima:
colima start
docker compose up -d

# Install dependencies
pnpm install

# Run migrations
pnpm db:migrate

# Seed initial data (seeds, prompts, model config)
./packages/db/node_modules/.bin/tsx packages/db/src/seed-data.ts
```

## Running an Experiment

### Basic Experiment: Test a Single Model

```bash
# Run 50 generations with Gemini 2.5 Flash
./scripts/test-chain.ts
```

This will:
1. Create a new run in the database
2. Generate questions iteratively (binary search for death detection)
3. Save all questions, token usage, and costs
4. Output results to console

**Expected output:**
```
🚀 Starting Driftwood Binary Search Experiment

📝 Seed: How many MacBook Airs could you fully charge...
🤖 Model: Gemini 2.5 Flash

Gen 0: How many MacBook Airs could you...
Gen 1: How many average adult African elephants...
...
✅ Gen 5 is alive, continuing...
...
```

### Analyze for Attractor States

After generating questions, detect if the chain fell into a semantic attractor:

```bash
./scripts/analyze-attractor-from-db.ts
```

**Expected output:**
```
Gen 17-24: mean=0.4436, stdDev=0.0688

💀 ATTRACTOR STATE DETECTED at gen 17!
   Mean drift: 0.4436, StdDev: 0.0688

Dead question (gen 17):
  "How many average raindrops would it take to fill..."
```

### Calculate Costs

```bash
./scripts/calculate-costs.ts
```

**Expected output:**
```
GENERATION COSTS (Gemini 2.5 Flash)
Questions generated: 51
Total tokens: 27,500
Generation cost: $0.0250

EVALUATION COSTS
Embeddings: $0.000051
Structure extraction: $0.002104

GRAND TOTAL: $0.027155
```

## Database Queries

### Check Recent Runs

```bash
# Using the db client directly
./packages/db/node_modules/.bin/tsx -e "
import { db } from './packages/db/src/client.js';
import { runs } from './packages/db/src/schema.js';
import { desc } from 'drizzle-orm';

const recentRuns = await db.select().from(runs).orderBy(desc(runs.createdAt)).limit(5);
console.table(recentRuns);
process.exit(0);
"
```

### View Questions for a Run

Create a script `scripts/view-run.ts`:

```typescript
#!/usr/bin/env tsx
import { db } from './packages/db/src/client.js';
import { runs, questions } from './packages/db/src/schema.js';
import { eq, desc, asc } from 'drizzle-orm';

const [latestRun] = await db.select().from(runs).orderBy(desc(runs.createdAt)).limit(1);
const allQuestions = await db.select().from(questions)
  .where(eq(questions.runId, latestRun.id))
  .orderBy(asc(questions.genIndex));

console.log(`Run ${latestRun.id}`);
console.log(`Status: ${latestRun.status}, Death: ${latestRun.deathGeneration ?? 'N/A'}\n`);

for (const q of allQuestions) {
  console.log(`Gen ${q.genIndex}: ${q.questionText}`);
}
```

## Configuration

### Change the Model

Edit `scripts/test-chain.ts`:

```typescript
const model = await getModel('gemini-2.5-flash'); // Change this
```

Available models (add more via `packages/db/src/seed-data.ts`):
- `gemini-2.5-flash`
- (More models coming: Claude, Llama, Mistral)

### Change the Seed Question

Edit `scripts/test-chain.ts`:

```typescript
const seed = await getSeed('taycan-macbook'); // Change this
```

Available seeds in database:
- `taycan-macbook`: "How many MacBook Airs could you charge..."
- `gas-tank-laptop`: "How many gas tank fill-ups equals laptop battery..."
- `cyclists-house`: "How many Tour de France cyclists to heat a house..."
- `wikipedia-aloud`: "How long to read Wikipedia aloud..."
- `breath-flight`: "How many breaths during transpacific flight..."

Add more seeds via `packages/db/src/seed-data.ts`.

### Adjust Experiment Parameters

In `scripts/test-chain.ts`, modify the `createRun` call:

```typescript
const run = await createRun(seed.id, model.id, mutateTemplate.id);
// Defaults:
// - track: 'experiment'
// - contextDepth: 5 (last 5 questions in context)
// - maxGenerations: 50
// - temperature: null (model default)
```

### Tune Attractor Detection

Edit thresholds in `scripts/analyze-attractor-from-db.ts`:

```typescript
if (stats.mean < 0.45 && stats.stdDev < 0.10) {  // Adjust these
  // Attractor detected
}
```

**Guidelines:**
- Lower mean threshold → more sensitive (earlier detection)
- Lower stddev threshold → stricter (requires tighter clustering)
- Larger window size → more conservative (fewer false positives)

## Common Tasks

### Reset Database

```bash
# Stop postgres
docker compose down

# Remove volume (DESTROYS ALL DATA)
docker volume rm halflife_postgres-data

# Restart and remigrate
docker compose up -d
pnpm db:migrate
./packages/db/node_modules/.bin/tsx packages/db/src/seed-data.ts
```

### Check Database Connection

```bash
# Should connect without errors
docker exec -it halflife-postgres-1 psql -U driftwood -d driftwood -c '\dt'
```

### View Logs

```bash
# Postgres logs
docker compose logs postgres

# Experiment output (if you tee'd it)
cat scripts/archive/*.log
```

## Troubleshooting

### "Command not found: tsx"

Use the full path:

```bash
./packages/db/node_modules/.bin/tsx <script-name>.ts
```

### "Unable to submit request... outputDimensionality"

Embedding dimension error. Check `packages/gateway/src/embeddings.ts`:

```typescript
parameters: {
  outputDimensionality: 768  // Must be ≤ 768 for text-embedding-004
}
```

### "Publisher model... was not found"

Model not available in your region/project. Run preflight to check:

```bash
./infra/preflight.sh
```

Update `packages/db/src/seed-data.ts` to use an available model.

### GCP Authentication Expired

```bash
gcloud auth application-default login
```

### Docker Not Running

```bash
# On macOS with Colima:
colima start

# Standard Docker:
open -a Docker  # or start Docker Desktop manually
```

## Cost Management

**Estimated costs:**
- 50 questions (Gemini 2.5 Flash): ~$0.025
- Full drift evaluation: ~$0.002
- **Total per experiment: ~$0.027**

**Cost per 1,000 questions:** ~$0.54

To minimize costs:
1. Use binary search (already implemented in `test-chain.ts`)
2. Stop after detecting death (manually or modify script)
3. Reuse drift data when re-analyzing (use `analyze-attractor-from-db.ts`)
4. Cache embeddings (TODO: not yet implemented)

## Next Steps

After running your first experiment:

1. **Analyze results**: Check death generation, review questions in attractor window
2. **Compare models**: Run the same seed on different models
3. **Tune prompts**: Edit `packages/db/src/seed-data.ts` to improve mutate prompt
4. **Add seeds**: Create new seed questions to test different domains
5. **Implement referent resolution**: Add groundedness checking (requires entity resolver)

## Additional Resources

- Architecture: `driftwood-architecture-v0.2.md`
- Attractor detection: `docs/attractor-state-detection.md`
- Schema reference: `packages/db/src/schema.ts`
- Example run logs: `scripts/archive/*.log`
