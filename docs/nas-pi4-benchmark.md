# NAS vs Pi 4 runtime benchmark runbook

Use this runbook before moving a public MCP endpoint from a Pi 4 to a NAS. The goal is to compare the same codemem workload on both hosts, then pick the host with the best latency, native dependency reliability, and operational shape.

## Recommendation

Prefer Docker Compose / Container Station on the NAS if it can run a normal Compose project with bind mounts. Compared with installing directly on the NAS OS, Compose gives us:

- pinned Node and npm runtime behavior;
- a durable `/data` mount for SQLite, config, and keys;
- repeatable restarts;
- easier rollback to a known image or package version.

Run directly on the NAS only if Container Station cannot provide a stable local volume or if native sqlite-vec optional packages fail inside the container.

## What to compare

Run the same database and same commands on both hosts.

| Area | Why it matters | Command family |
|------|----------------|----------------|
| sqlite-vec availability | Pi/Linux ARM installs can miss the platform package; NAS CPU arch may differ. | `codemem sync status --json`, `codemem pack ... --json` |
| semantic retrieval latency | Public MCP calls spend time building packs. | `codemem pack ... --json` |
| embedding/backfill throughput | Embedding generation and vector inserts are expensive on small ARM hosts. | `codemem embed --all-projects --json` |
| MCP HTTP latency | This is the user-facing claude.ai connector path. | HTTP `POST /mcp` or local `codemem mcp http` smoke |
| operational stability | SQLite needs persistent local storage, not a remote/network mount. | restart + `codemem stats` + `codemem sync status` |

## Prepare identical inputs

1. Upgrade both hosts to the same published version:

   ```fish
   npm install -g --include=optional codemem@0.32.1
   codemem version
   ```

2. Stop codemem services on both hosts before copying databases.

3. Copy the same SQLite database to both hosts, for example:

   ```fish
   mkdir -p /data/codemem
   # Copy mem.sqlite to /data/codemem/mem.sqlite using scp, rsync, or Container Station file tooling.
   ```

4. Use local persistent storage on each host. Do not benchmark from a flaky SMB/NFS mount; that mostly benchmarks sadness.

## NAS Compose template

Create a Compose project in Container Station with a persistent host directory mounted at `/data/codemem`:

```yaml
services:
  codemem-mcp:
    image: node:24-bookworm-slim
    working_dir: /app
    command:
      - sh
      - -lc
      - |
        corepack enable
        npm install -g --include=optional codemem@0.32.1
        exec codemem mcp http --host 0.0.0.0 --port 38889 --db-path /data/mem.sqlite
    environment:
      CODEMEM_MCP_HTTP_PUBLIC_URL: ${CODEMEM_MCP_HTTP_PUBLIC_URL:-}
      CODEMEM_MCP_OIDC_ISSUER_URL: ${CODEMEM_MCP_OIDC_ISSUER_URL:-}
      CODEMEM_MCP_OIDC_CLIENT_ID: ${CODEMEM_MCP_OIDC_CLIENT_ID:-}
      CODEMEM_MCP_OIDC_CLIENT_SECRET: ${CODEMEM_MCP_OIDC_CLIENT_SECRET:-}
      CODEMEM_MCP_OAUTH_ALLOWED_EMAIL: ${CODEMEM_MCP_OAUTH_ALLOWED_EMAIL:-}
      CODEMEM_MCP_HTTP_UNSAFE_PUBLIC: "1"
    ports:
      - "127.0.0.1:38889:38889"
    volumes:
      - /data/codemem:/data
    restart: unless-stopped
```

The container binds `0.0.0.0` so Docker can forward to it, but the host publish is loopback-only. For initial benchmarking, omit the public OAuth variables and keep the service reachable only from the NAS itself. Add public ingress only after the NAS wins the local comparison and OAuth variables are configured. Do not publish unauthenticated `codemem mcp http` on a LAN or public interface.

## Runtime benchmark helper

The repo includes a small command harness:

```fish
pnpm run benchmark:runtime -- --help
```

It measures any command repeatedly and emits JSON with host metadata plus p50/p95 wall-clock latency.

Use the same labels and repeat counts on both hosts.

### Baseline metadata

```fish
uname -m
node --version
codemem version
codemem stats --db-path /data/codemem/mem.sqlite --json
codemem sync status --db-path /data/codemem/mem.sqlite --json
```

Confirm `sync status` reports semantic index state. If sqlite-vec fails, fix optional deps before comparing performance:

```fish
npm install -g --include=optional codemem@0.32.1
```

### Pack/retrieval latency

Pick 3-5 representative queries. Run each on both hosts:

```fish
pnpm run benchmark:runtime -- \
  --label pack-release-context \
  --repeat 25 \
  --warmup 3 \
  --out results-pack-release-context.json \
  -- codemem pack "release context and MCP HTTP OAuth fixes" --all-projects --json --db-path /data/codemem/mem.sqlite
```

If you are running outside a git checkout, use the script directly after copying it:

```fish
node benchmark-runtime.mjs --label pack-release-context --repeat 25 --warmup 3 -- codemem pack "release context and MCP HTTP OAuth fixes" --all-projects --json --db-path /data/codemem/mem.sqlite
```

### Embedding/backfill throughput

Embedding mutates the database, so run it against a fresh copy on each host.

```fish
cp /data/codemem/mem.sqlite /data/codemem/embed-bench.sqlite
pnpm run benchmark:runtime -- \
  --label embed-all-projects \
  --repeat 1 \
  --warmup 0 \
  --out results-embed-all-projects.json \
  -- codemem embed --all-projects --json --db-path /data/codemem/embed-bench.sqlite
```

Record the JSON result from `codemem embed` separately if you want vectors-per-second. The runtime helper measures wall time; `codemem embed` reports checked/embedded/inserted/skipped counts.

### MCP HTTP latency

For local unauthenticated smoke latency, start the service without `--public-url` and measure a basic initialize request from the same host or LAN.

```fish
codemem mcp http --host 127.0.0.1 --port 38889 --db-path /data/codemem/mem.sqlite
```

Then in another terminal:

```fish
pnpm run benchmark:runtime -- \
  --label mcp-initialize-local \
  --repeat 25 \
  --warmup 3 \
  --out results-mcp-initialize-local.json \
  -- node --input-type=module -e 'const res = await fetch("http://127.0.0.1:38889/mcp", { method: "POST", headers: { accept: "application/json, text/event-stream", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bench", version: "0.0.0" } } }) }); if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${await res.text()}`); await res.text();'
```

For public OAuth latency, benchmark after connector setup with a real bearer token. Keep those token values out of committed files and logs.

The benchmark helper records the command argv in its JSON output. Do not put bearer tokens directly in command arguments for result files you might share; pass them through environment variables or redact the `command` field before sharing.

## Results table

Fill this in after both hosts run the same commands.

| Metric | Pi 4 | NAS | Winner | Notes |
|--------|------|-----|--------|-------|
| sqlite-vec loads | | | | |
| `pack` p50 / p95 | | | | |
| `embed` wall time | | | | |
| vectors/sec | | | | |
| MCP initialize p50 / p95 | | | | |
| CPU/memory during sustained run | | | | |

## Move/no-move rule

Move the public endpoint to the NAS when all are true:

- sqlite-vec loads without fallback;
- pack p95 is materially better than Pi 4;
- embedding/backfill either completes faster or no longer stalls normal use;
- Compose restart preserves the same DB/config/key material;
- local MCP smoke is clean before adding public ingress;
- public ingress preserves Host and proxy headers for the OAuth flow.

Keep the Pi 4 as-is if the NAS container cannot load sqlite-vec for its CPU architecture or if Container Station storage adds worse SQLite latency than the Pi's local disk.
