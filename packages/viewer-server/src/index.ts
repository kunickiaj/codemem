/**
 * @codemem/viewer-server — unified viewer + sync process.
 *
 * Single HTTP server handling viewer routes and sync daemon.
 * Shares one better-sqlite3 connection between viewer and sync.
 * Embedding inference runs in a worker_thread (lazy-started).
 *
 * Entry: `codemem serve`
 */

export { VERSION } from "@codemem/core";
