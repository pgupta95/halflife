# Infra

Local-Mac development against GCP. See `../driftwood-execution-gcp-v0.1.md` for
why the stack looks like this.

## Prerequisites

```bash
brew install --cask google-cloud-sdk docker
brew install node pnpm
```

Postgres runs in Docker — no local server install.

## One-time setup

Project `halflife-506215`, region `us-central1` (cheapest US pricing tier that
still carries the full Vertex model roster).

```bash
gcloud auth login
./infra/preflight.sh 2>&1 | tee preflight.txt   # read-only, confirms the roster
./infra/bootstrap-gcp.sh                        # 2 APIs + 1 bucket
gcloud auth application-default login           # how Vertex authenticates

docker compose up -d                            # postgres:16 + pgvector
pnpm install && pnpm db:migrate
```

`bootstrap-gcp.sh` is idempotent; re-run it freely.

## What is actually deployed

Nothing. Compute is the Mac, Postgres is a local container, and the only cloud
resources are the Vertex API (usage-billed) and one GCS bucket. A full 10-model
sweep is 110 MB, which costs about $0.002/month to keep.

This changes in week 6, when Slack forces a public HTTPS endpoint and an
always-on cron — Postgres lifts to Cloud SQL and the API to Cloud Run.

## Backups

The chains are the irreplaceable artifact: re-running a sweep costs money *and*
returns different data, because the models underneath have moved. Back up after
each sweep, not on a nightly timer — a sweep is one afternoon.

```bash
pnpm backup      # pg_dump | gzip | gcloud storage cp gs://halflife-506215-driftwood/
```

The bucket has object versioning on, so a bad restore is recoverable.

## Running a sweep

Mac sleep interrupts in-flight generations. `graphile-worker` retries them on
wake and `UNIQUE (run_id, gen_index)` makes the retry a no-op if the generation
already landed — but a sweep finishes faster if the machine stays awake:

```bash
caffeinate -is pnpm sweep --seeds=5 --models=all --replicates=5
```

## Gotchas

- **ADC tokens expire.** Re-run `gcloud auth application-default login` when the
  worker starts reporting auth errors. It should fail loudly rather than marking
  runs `failed`. This is the only credential path in the build.
- **Model Garden models need per-model enablement** in the console before their
  first call, and several need a quota increase request.
- **Per-model concurrency caps** live in `models.metadata.max_concurrency`, not
  in a global setting. Vertex quotas are per-model; one global cap will either
  throttle the fast models or 429 the slow ones.
