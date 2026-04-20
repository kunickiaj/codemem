/* Diagnostics card — barrel re-export of the split modules. The tab
 * was broken up into diagnostics/ (types.ts, helpers.ts, render/, and
 * lifecycle.ts) during the UI god-file decomposition; this file now
 * only keeps the public entrypoints stable for sync/index.ts wiring. */

export { syncAttemptsHistoryNote } from "./diagnostics/helpers";
export {
	initDiagnosticsEvents,
	renderPairing,
	setRenderSyncPeers,
} from "./diagnostics/lifecycle";
export {
	renderSyncAttempts,
	renderSyncDiagnosticsUnavailable,
} from "./diagnostics/render/sync-attempts";
export { renderSyncStatus } from "./diagnostics/render/sync-status";
