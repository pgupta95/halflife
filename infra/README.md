# Infra

Local-Mac development against GCP. See `../driftwood-execution-gcp-v0.1.md` for
why the stack looks like this.

## Prerequisites

```bash
brew install --cask google-cloud-sdk
brew install cloud-sql-proxy postgresql@16   # psql client only; the server is Cloud SQL
brew install node pnpm uv                    # uv manages the Python stats sidecar
```

## One-time setup

Project `halflife-506215`, region `us-central1` (cheapest US pricing tier that
still carries the full Vertex model roster; `us-east1`/`us-west1` price the same
but have narrower Model Garden coverage).

```bash
gcloud auth login
./preflight.sh 2>&1 | tee preflight.txt   # read-only, confirms the roster first
./bootstrap-gcp.sh
gcloud auth application-default login        # ADC — this is how Vertex authenticates
```

`bootstrap-gcp.sh` is idempotent; re-run it freely.

## Cloud SQL Auth Proxy as a launchd agent

So the DB connection survives a reboot without a manual step. Write
`~/Library/LaunchAgents/com.driftwood.sqlproxy.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.driftwood.sqlproxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/cloud-sql-proxy</string>
    <string><!-- PROJECT:REGION:driftwood-pg --></string>
    <string>--port=5432</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/tmp/driftwood-sqlproxy.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.driftwood.sqlproxy.plist
```

## Running a sweep

Mac sleep interrupts in-flight generations. `graphile-worker` retries them on
wake and `UNIQUE (run_id, gen_index)` makes the retry a no-op if the generation
already landed — but a sweep still finishes faster if the machine stays awake:

```bash
caffeinate -is pnpm sweep --seeds=5 --models=all --replicates=5
```

## Gotchas

- **ADC tokens expire.** Re-run `gcloud auth application-default login` when the
  worker starts reporting auth errors. It should fail loudly rather than marking
  runs `failed`.
- **Model Garden models need per-model enablement** in the console before their
  first call, and several need a quota increase request.
- **Per-model concurrency caps** live in `models.metadata.max_concurrency`, not
  in a global setting. Vertex quotas are per-model; one global cap will either
  throttle the fast models or 429 the slow ones.
