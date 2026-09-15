/* Health tab — barrel re-export of the split modules. The tab was
 * broken up into health/ (types.ts, components.ts, render/, and
 * lifecycle.ts) during the UI god-file decomposition; this file now
 * only keeps the public entrypoints stable for app-shell wiring. */

export { initHealthTab, loadHealthData, refreshViewerStatus } from "./health/lifecycle";
export {
	markHealthStatusUnchecked,
	renderHealthOverview,
} from "./health/render/health-overview";
export { renderSessionSummary } from "./health/render/session-summary";
export { renderStats } from "./health/render/stats";
