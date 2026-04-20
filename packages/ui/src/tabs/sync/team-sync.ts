/* Team sync card — barrel re-export of the split modules. The tab was
 * broken up into team-sync/ (data/, helpers/, events/, render/) during
 * the UI god-file decomposition; this file now only keeps the public
 * entrypoints stable for index.ts wiring. */

export { setLoadSyncData } from "./team-sync/data/state";
export { initTeamSyncEvents } from "./team-sync/events/init-team-sync-events";
export { renderTeamSync } from "./team-sync/render/render-team-sync";
export { renderSyncSharingReview } from "./team-sync/render/sharing-review";
