import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { state } from "../../../lib/state";
import {
	advancedDeviceIdentityView,
	canManageSpacesInTeams,
	openDeviceIdentitySetup,
	renderSyncPeersList,
} from "./sync-peers";

beforeEach(() => {
	state.lastSyncActors = [
		{ actor_id: "identity-confirmed", display_name: "Confirmed Person" },
		{ actor_id: "identity-hint", display_name: "Suggested Person" },
	];
	state.lastDeviceIdentityInventory = null;
	state.deviceIdentityInventoryLoadError = false;
	state.pendingDeviceIdentityFocus = undefined;
	window.location.hash = "advanced/sync";
});

afterEach(() => {
	const mount = document.getElementById("mount");
	if (mount) act(() => render(null, mount));
	document.body.innerHTML = "";
});

describe("canManageSpacesInTeams", () => {
	it("allows the Teams management action only for ready coordinator admin devices", () => {
		expect(canManageSpacesInTeams({ has_admin_secret: true, readiness: "ready" })).toBe(true);
	});

	it("blocks the Teams management action when admin capability is absent", () => {
		expect(canManageSpacesInTeams({ has_admin_secret: false, readiness: "ready" })).toBe(false);
		expect(canManageSpacesInTeams({ has_admin_secret: true, readiness: "partial" })).toBe(false);
		expect(canManageSpacesInTeams(null)).toBe(false);
	});
});

describe("Advanced device Identity ownership", () => {
	it("uses only an active binding as authoritative ownership", () => {
		const view = advancedDeviceIdentityView(
			{
				version: 1,
				deviceId: "peer-a",
				evidenceDeviceIds: ["peer-a"],
				displayName: "Peer A",
				state: "configured",
				identityId: "identity-confirmed",
				suggestedIdentityId: "identity-hint",
				validatedFingerprint: null,
				isLocal: false,
				sources: ["sync_peer", "identity_binding"],
				conflictCodes: [],
			},
			"identity-hint",
			state.lastSyncActors,
		);

		expect(view).toMatchObject({
			status: "configured",
			summary: "Authoritative Identity: Confirmed Person.",
			actionLabel: "Review or rebind in Devices",
		});
		expect(view.detail).toContain("active identity_devices binding");
	});

	it("labels sync_peers.actor_id as a suggestion until setup is confirmed", () => {
		const view = advancedDeviceIdentityView(undefined, "identity-hint", state.lastSyncActors);

		expect(view.summary).toBe("Suggested Identity: Suggested Person.");
		expect(view.detail).toContain("sync_peers.actor_id is only a suggestion or hint");
		expect(view.actionLabel).toBe("Set up Identity in Devices");
	});

	it("does not present cached ownership as authoritative when inventory refresh fails", () => {
		const view = advancedDeviceIdentityView(undefined, "identity-hint", state.lastSyncActors, true);

		expect(view).toMatchObject({
			status: "unavailable",
			summary: "Authoritative Identity status is temporarily unavailable.",
			actionLabel: "Review Identity in Devices",
		});
		expect(view.detail).toContain("suggestions or provenance only");
	});

	it("does not infer missing ownership from an incomplete inventory", () => {
		const view = advancedDeviceIdentityView(
			undefined,
			"identity-hint",
			state.lastSyncActors,
			false,
			true,
		);

		expect(view.status).toBe("unavailable");
		expect(view.summary).toContain("inventory is incomplete");
		expect(view.detail).toContain("not shown from a partial inventory");
	});

	it("routes ownership work to Devices and requests post-render focus", () => {
		openDeviceIdentitySetup("peer-a");

		expect(window.location.hash).toBe("#devices");
		expect(state.pendingDeviceIdentityFocus).toBe("peer-a");
	});

	it("removes the direct actor assignment affordance but keeps Advanced peer actions", () => {
		document.body.innerHTML = '<div id="mount"></div>';
		state.lastDeviceIdentityInventory = {
			version: 1,
			items: [
				{
					version: 1,
					deviceId: "peer-a",
					evidenceDeviceIds: ["peer-a"],
					displayName: "Peer A",
					state: "setup_required",
					identityId: null,
					suggestedIdentityId: "identity-hint",
					validatedFingerprint: null,
					isLocal: false,
					sources: ["sync_peer"],
					conflictCodes: [],
				},
			],
			coordinatorEvidence: { availability: "available", safeErrorCode: null },
			truncated: false,
		};
		const mount = document.getElementById("mount");
		if (!mount) throw new Error("mount missing");
		act(() =>
			renderSyncPeersList(mount, {
				peers: [{ peer_device_id: "peer-a", name: "Peer A", actor_id: "identity-hint" }],
				onRemove: vi.fn(),
				onRename: vi.fn(),
				onSync: vi.fn(),
			}),
		);
		const disclosure = mount.querySelector<HTMLButtonElement>('[aria-expanded="false"]');
		if (!disclosure) throw new Error("peer disclosure missing");
		act(() => disclosure.click());

		expect(mount.textContent).toContain("Authoritative Identity ownership");
		expect(mount.textContent).toContain("Set up Identity in Devices");
		expect(mount.textContent).toContain("Sync now");
		expect(mount.textContent).toContain("Advanced sharing rules");
		expect(mount.textContent).not.toContain("Save assignment");
		expect(mount.querySelector('[aria-label^="Assigned person"]')).toBeNull();
	});
});
