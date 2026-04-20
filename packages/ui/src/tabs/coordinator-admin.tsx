/* Coordinator Admin tab — barrel re-export of the lifecycle module.
 * The tab was split into coordinator-admin/ (data/, components/, and
 * lifecycle.ts) during the UI god-file decomposition; this file now
 * only keeps the public entrypoints stable for app-shell wiring. */

export {
	initCoordinatorAdminTab,
	loadCoordinatorAdminData,
} from "./coordinator-admin/lifecycle";
