/* Shared module state for the team sync card — everything that was
 * previously a file-local `let` on team-sync.ts lives on one exported
 * object so the helpers/renderers/event handlers can read and write it
 * across modules. */

export interface TeamSyncState {
	invitePolicy: "auto_admit" | "approval_required";
	loadSyncData: () => Promise<void>;
}

export const teamSyncState: TeamSyncState = {
	invitePolicy: "auto_admit",
	loadSyncData: async () => {},
};

export function setLoadSyncData(fn: () => Promise<void>) {
	teamSyncState.loadSyncData = fn;
}
