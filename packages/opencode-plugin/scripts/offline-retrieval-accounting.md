# Offline memory retrieval accounting

The harness runs six synthetic tasks through real codemem MCP stdio and compares three scripted model transcripts. Each mode sends the same searches and hydrates one batch with the same ordered IDs. The script checks candidate sets, compact index shape, hydrated bodies, byte-for-byte equality of MCP payloads, and server ledger handoff.

## Run from the repository root

Use Node 24 and the installed workspace dependencies. The command uses a temporary database and home directory, disables the viewer and embeddings, and does not start a model provider.

```fish
mkdir -p .tmp
printf '{}\n' > .tmp/offline-retrieval-empty.json
env -u CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET -u CODEMEM_SYNC_COORDINATOR_URL \
  CODEMEM_CONFIG=.tmp/offline-retrieval-empty.json \
  node packages/opencode-plugin/scripts/offline-retrieval-accounting.mts \
  > .tmp/offline-retrieval-accounting.json
```

The JSON records the seed and scenario hash, fixture time, Node and MCP server versions, negotiated protocol, and the hash of the two complete MCP tool descriptors. Repeat runs from the same checkout and runtime should produce matching JSON.

Pass `--include-fixture-payloads` to include the synthetic task text, tool descriptors, search results, and hydrated records for a separate model trial. The command still uses only a temporary fixture database and makes no model requests.

## Byte and round definitions

- **MCP stdio:** Request and reply bytes include the newline and JSON-RPC envelope. Reply bytes include any duplication between MCP text and structured content. `textBytes` counts the raw text once. All three paths retrieve equivalent payloads in two dependency rounds. The decision and cross-project tasks send two independent searches before receiving either result.
- **Direct:** The mock request exposes both tool signatures. It carries the index results into the next model round before batch hydration.
- **Deferred:** The mock exposes an `execute` gateway and catalog stub. Search and hydration are separate `execute` calls, so the next model round still receives the index results. The wrapper returns the searches as one array.
- **Program:** The harness executes the fixture's generated JavaScript in Node and records the modeled gateway response. It models a single model-visible result containing the hydrated batch. The MCP ledger still records the intermediate index handoffs to the client.

The warm deferred and program transcripts start with the two input signatures in context. The cold transcripts add one scripted discovery round that returns the same signatures. Direct has the same transcript in both cases. Warm and cold refer to catalog knowledge, and every actual MCP run uses the same initialized connection. The report counts each model request's serialized mock envelope, including replayed history, separately from raw schema, catalog, discovery, source, and result bytes. The mock request after hydration counts as an inference request because it would turn evidence into an answer.

In a sample run, the broad-filter task returned 14 candidates and hydrated IDs `10, 11`. The real MCP replies totaled 9,726 bytes per mode. Warm intermediate text measured 2,271 bytes for direct, 2,273 for deferred, and zero for program. Across all scenarios, the modeled inference request counts for direct, deferred, and program were `3/3/2` warm and `3/4/3` cold.

The fixture tests exact retrieval and server-side capture. It does not measure real model answers, token usage or caching, latency, OpenCode or Pi capture, impact attribution, or process memory. Those require separately approved measurements before drawing a rollout conclusion.
