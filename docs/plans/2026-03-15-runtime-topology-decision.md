# Runtime Topology Decision

**Status:** Decision — unified viewer+sync process, MCP as separate process, embeddings in worker thread  
**Date:** 2026-03-15

## Context

codemem runs as multiple Python processes today. The TS port must decide how these components relate at runtime in a Node.js environment where `better-sqlite3` is synchronous and the event loop is single-threaded.

The components:

| Component | Current runtime | I/O model |
|---|---|---|
| CLI commands | One-shot process | Open store, run, exit |
| Viewer server | HTTP on port 38888 | Request/response, new store per request |
| MCP server | stdio process (spawned by OpenCode) | Thread-local store pool |
| Sync daemon | Separate process with HTTP server + interval loop | Store per tick |
| Plugin ingest | Shells out to `codemem ingest` | One-shot stdin→process |

### Key constraints

1. **MCP server uses stdio.** It is spawned by OpenCode/Claude as a child process. It cannot share a process with anything else. This is non-negotiable.
2. **`better-sqlite3` is synchronous.** All DB calls block the thread. In a single Node process, there is no connection contention (only one call runs at a time). Across processes, WAL mode handles concurrency.
3. **onnxruntime-node is CPU-heavy and crash-prone.** It had a mutex crash at process exit. Embedding generation blocks the thread for 10-50ms per item. Batch embedding (hundreds of items) blocks for seconds.
4. **The sync daemon tick is I/O-bound.** It makes HTTP requests to peers and does SQLite reads/writes — exactly what Node's event loop handles well.

## Options Considered

### Option A: Everything in separate processes (Python model)

Viewer, MCP, sync daemon, and CLI each run as separate Node processes.

**Pros:**
- Crash isolation — one component dying doesn't affect others
- Matches the Python architecture (less conceptual change)

**Cons:**
- More moving parts (3 long-running processes to manage)
- Each process loads its own `better-sqlite3` connection, sqlite-vec extension, and Node runtime
- Debugging requires attaching to multiple processes
- Process lifecycle management (pidfiles, service files) is more complex
- WAL write contention between viewer and sync daemon is possible (though rare)

### Option B: Unified viewer+sync process, MCP separate (chosen)

The viewer HTTP server and sync daemon run in one Node process. The MCP server is its own process (forced by stdio). CLI commands are one-shot processes.

**Pros:**
- One long-running process to manage (plus MCP, which is managed by OpenCode)
- Viewer and sync share a single `better-sqlite3` connection — zero WAL contention between them
- Single process to debug, monitor, and restart
- Sync daemon is just `setInterval` + an HTTP route handler — trivial to host on the same event loop
- sqlite-vec loaded once, not twice

**Cons:**
- If the sync daemon crashes (unhandled exception in a tick), it could take down the viewer
- The viewer's event loop handles both HTTP requests and sync ticks — a slow sync tick could delay HTTP responses

**Mitigations:**
- Sync tick errors are caught and logged (current Python code does this via try/except per tick). Same pattern in Node: wrap `setInterval` callback in try/catch.
- Sync ticks are I/O-bound (HTTP + SQLite), not CPU-bound. They yield to the event loop naturally. A tick that takes 500ms of wall time spends most of that waiting on network I/O.

### Option C: Everything in one process (viewer+sync+MCP)

Not possible. MCP uses stdio, which requires its own process.

### Option D: Worker threads for sync daemon

Run the sync daemon in a `worker_thread` within the viewer process.

**Pros:**
- Sync tick can't block the viewer's event loop even if it does CPU work

**Cons:**
- `better-sqlite3` connections can't be shared across worker threads (same-thread constraint)
- Two connections in one process = self-contention through WAL
- Worker thread adds complexity with no real benefit — sync ticks are I/O-bound, not CPU-bound
- Harder to debug

## Decision

### Process model

```
┌──────────────────────────────────┐     ┌─────────────────────┐
│ Viewer + Sync Process            │     │ MCP Process          │
│                                  │     │ (spawned by OpenCode)│
│  ┌──────────┐  ┌──────────────┐  │     │                     │
│  │ HTTP     │  │ Sync daemon  │  │     │  stdio transport    │
│  │ server   │  │ (setInterval)│  │     │  own DB connection  │
│  └────┬─────┘  └──────┬───────┘  │     │                     │
│       │               │          │     └─────────┬───────────┘
│       └───────┬───────┘          │               │
│               │                  │               │
│    ┌──────────▼──────────┐       │    ┌──────────▼──────────┐
│    │ Shared better-sqlite3│      │    │ Own better-sqlite3   │
│    │ connection           │      │    │ connection            │
│    └──────────┬──────────┘       │    └──────────┬──────────┘
│               │                  │               │
└───────────────┼──────────────────┘               │
                │                                  │
                └──────────┬───────────────────────┘
                           │
                    ┌──────▼──────┐
                    │ SQLite DB   │
                    │ (WAL mode)  │
                    └─────────────┘
```

```
CLI commands:  one-shot process, own connection, open→run→exit
Plugin ingest: one-shot process (stdin JSON), own connection, same as CLI
```

### Embedding inference: worker thread

Embedding generation (`onnxruntime-node`) runs in a `worker_thread` within the viewer+sync process.

**Why a worker thread, not inline:**

1. **Event loop blocking.** A single embedding takes 10-50ms. Batch operations (backfill, ingest with auto-embed) process hundreds of items. Running inline would freeze HTTP responses and sync ticks for seconds.
2. **Crash isolation.** onnxruntime-node had a native mutex crash at process exit. In a worker thread, the crash terminates the worker, not the host process. The main process catches the worker error and can restart it.
3. **Clean lifecycle.** The worker thread owns the onnxruntime session. On shutdown, we terminate the worker thread first — avoiding the exit-order crash entirely.

**How it works:**

- The main process sends embedding requests to the worker via `postMessage` (text chunks + model config)
- The worker loads onnxruntime, runs inference, returns vectors via `postMessage`
- The main process writes vectors to `memory_vectors` using its own `better-sqlite3` connection
- The worker has no DB connection — it only does compute

**When embeddings are needed during MCP server operation** (e.g., semantic search uses pre-computed vectors), the MCP process reads existing vectors from the DB. It does not run inference. New embeddings are computed by the viewer+sync process or by CLI commands (`codemem embed`).

### Store connection model

| Component | Connection | Notes |
|---|---|---|
| Viewer + Sync process | One shared `better-sqlite3` connection | Single thread = no contention |
| MCP server process | Own connection | WAL concurrency with viewer |
| CLI commands | Own connection per invocation | Short-lived, WAL handles overlap |
| Embedding worker thread | No connection | Receives text, returns vectors via postMessage |

### Sync daemon specifics

The sync daemon runs as `setInterval(syncTick, intervalMs)` on the main event loop.

**Tick implementation:**
```typescript
// Pseudocode
const syncTick = async () => {
  try {
    await syncDaemonTick(store); // I/O-bound: HTTP to peers + SQLite
    store.setSyncDaemonOk();
  } catch (err) {
    store.setSyncDaemonError(err);
    logger.error('sync tick failed', err);
  }
};

setInterval(syncTick, config.syncIntervalMs);
```

The sync daemon also hosts HTTP routes for peer-to-peer sync API (push/pull). These are served by the same HTTP server as the viewer — they're just additional route handlers under `/api/sync/`.

This matches the current Python architecture: the sync daemon's HTTP server (in `sync/daemon.py`) serves the same kind of routes that the viewer's sync routes handle. In the TS port, they converge into one HTTP server.

### MCP server specifics

The MCP server is spawned by OpenCode as a child process using stdio transport. It:

1. Opens its own `better-sqlite3` connection on startup
2. Registers MCP tools (search, pack, remember, forget, etc.)
3. Handles requests via stdio JSON-RPC
4. Closes the connection on exit

No IPC to the viewer process. The MCP server reads/writes the same SQLite DB via WAL. Write contention with the viewer is handled by `busy_timeout = 5000ms` (per the DB coexistence contract).

### CLI command specifics

No change from the Python model. Each CLI invocation:

1. Opens a `better-sqlite3` connection
2. Runs the command (stats, search, pack, embed, etc.)
3. Closes the connection and exits

The `embed` command runs onnxruntime inline (no worker thread) because it's a one-shot process where blocking is acceptable.

## Consequences

### For the scaffold (bead a71)

1. **One entry point, two modes.** The main binary (`codemem`) serves as both CLI and long-running server:
   - `codemem serve` → starts the unified viewer+sync process
   - `codemem mcp` → starts the stdio MCP server
   - `codemem stats`, `codemem search`, etc. → one-shot CLI commands

2. **Single HTTP server.** The viewer+sync process runs one HTTP server that handles both viewer routes (`/`, `/api/memories/*`, `/api/stats/*`) and sync routes (`/api/sync/*`).

3. **Store is a singleton within the viewer+sync process.** Create one `better-sqlite3` connection at startup, pass it to both the HTTP handler and the sync tick function. Close it on SIGTERM/SIGINT.

4. **Embedding worker is lazy-started.** Don't spawn the worker thread until the first embedding request. If no embeddings are needed during a server session, no worker thread exists.

5. **Sync daemon start is conditional.** Only start the `setInterval` sync loop if sync is enabled in config. Check `config.sync.enabled` at startup.

### What this simplifies

- **One process to monitor.** `codemem serve` is the only long-running process the user manages. The MCP server lifecycle is handled by OpenCode.
- **One DB connection for the server.** No WAL self-contention, no connection pooling, no cleanup logic for abandoned connections.
- **No IPC.** Viewer and sync communicate via shared memory (same JS objects, same store instance). No serialization overhead.

### What this complicates

- **Sync crash → viewer crash.** If an unhandled error escapes the sync tick's try/catch, the process dies. Mitigation: robust error handling in the sync tick, plus process supervision (launchd/systemd restart).
- **Embedding worker lifecycle.** Need to handle worker thread startup, crash recovery, and graceful shutdown. More code than inline inference, but necessary for the event loop.

### Testing implications

- **Viewer+sync integration tests** can run in-process (no child process coordination)
- **MCP server tests** require spawning a child process (or mocking stdio transport)
- **Cross-process concurrency tests** need two Node processes hitting the same DB (per DB coexistence contract §Testing Requirements)
- **Embedding worker tests** need to verify worker crash recovery and correct vector output
