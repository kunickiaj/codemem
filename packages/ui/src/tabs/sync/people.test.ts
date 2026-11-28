import { beforeEach, describe, expect, it, vi } from "vitest";
import { state } from "../../lib/state";
import { renderSyncActors } from "./people";

vi.mock("../../lib/api", () => ({}));
vi.mock("./components/sync-peers", () => ({
	renderSyncPeersList: vi.fn(),
	canManageLegacyCoordinatorSpaces: () => false,
}));

beforeEach(() => {
	vi.clearAllMocks();
	document.body.innerHTML = '<div id="syncPeers"></div>';
	state.lastSyncPeers = [];
	state.syncPeersSectionFeedback = null;
	state.syncPeerFeedbackById.clear();
});

describe("people on a device that may not change them", () => {
	function mountPeople(status: unknown) {
		document.body.innerHTML = `
			<div id="syncActorsMeta"></div>
			<div id="syncActorsList"></div>
			<input id="syncActorCreateInput" />
			<button id="syncActorCreateButton">Create person</button>`;
		state.lastSyncActors = [
			{ actor_id: "person-local", display_name: "Adam", is_local: true },
			{ actor_id: "person-b", display_name: "Brian", is_local: false },
		] as typeof state.lastSyncActors;
		state.lastSyncCoordinatorAdminStatus = status as typeof state.lastSyncCoordinatorAdminStatus;
		// The Feed and Teams cache may be empty or stale when Sync opens first.
		state.lastCoordinatorAdminStatus = null;
		renderSyncActors();
	}
	const createButton = () => document.getElementById("syncActorCreateButton") as HTMLButtonElement;
	const renameButtons = () =>
		[...document.querySelectorAll("button")].filter((button) => button.textContent === "Rename");

	it.each([
		[
			{ readiness: "not_configured", has_admin_secret: false },
			"Adding or changing people needs a coordinator. Set the coordinator URL and group in Settings.",
		],
		[
			{ readiness: "partial", has_admin_secret: false },
			"Only a device that holds the coordinator admin secret can add or change people. Use that device.",
		],
	])("hides the controls and says why: %o", (status, copy) => {
		mountPeople(status);

		expect(createButton().disabled).toBe(true);
		expect(renameButtons()).toEqual([]);
		expect(document.body.textContent).toContain("Brian");
		expect(document.getElementById("syncActorsMeta")?.textContent).toContain(copy);
	});

	it("keeps the controls on the admin device", () => {
		mountPeople({ readiness: "ready", has_admin_secret: true });

		expect(createButton().disabled).toBe(false);
		expect(renameButtons()).toHaveLength(1);
	});
});
