/* Sync tab sub-view controller.
 *
 * The Sync tab hosts two sibling regions inside #tab-sync:
 *   - #syncMainView          (everything except diagnostics)
 *   - #syncDiagnosticsView   (the advanced diagnostics card)
 *
 * Users switch between them via the URL hash:
 *   #sync              -> main view
 *   #sync/diagnostics  -> diagnostics view
 *
 * Keeping the toggle here (not in lib/state.ts's tab router) avoids
 * churning ALL_TAB_IDS and keeps #sync as a single top-level tab in the
 * nav. See docs/plans/2026-04-23-sync-tab-redesign.md (Q1).
 */

export type SyncSubView = "main" | "diagnostics";

export function getSyncSubView(): SyncSubView {
	const hash = window.location.hash.replace(/^#/, "");
	return hash === "sync/diagnostics" ? "diagnostics" : "main";
}

export function applySyncSubView(view: SyncSubView = getSyncSubView()): void {
	const main = document.getElementById("syncMainView");
	const diag = document.getElementById("syncDiagnosticsView");
	if (!main || !diag) return;
	if (view === "diagnostics") {
		main.hidden = true;
		diag.hidden = false;
	} else {
		main.hidden = false;
		diag.hidden = true;
	}
}

let listenerAttached = false;

export function ensureSyncSubViewListener(): void {
	if (listenerAttached) return;
	listenerAttached = true;
	window.addEventListener("hashchange", () => {
		applySyncSubView();
	});
}
