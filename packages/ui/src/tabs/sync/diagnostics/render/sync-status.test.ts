import { afterEach, describe, expect, it } from "vitest";
import { state } from "../../../../lib/state";
import { renderSyncStatus } from "./sync-status";

afterEach(() => {
	document.body.innerHTML = "";
	state.lastSyncStatus = null;
});

describe("renderSyncStatus", () => {
	it.each([
		["rebootstrapping", true],
		["ready", false],
	])("shows peer diagnostics only during %s recovery", (daemonState, expectedAction) => {
		// Arrange: a paired device must reach the recovery branch instead of no-peer onboarding.
		document.body.innerHTML = `
			<div id="syncStatusGrid"></div>
			<div id="syncMeta"></div>
			<div id="syncActions"></div>
		`;
		state.lastSyncStatus = {
			daemon_state: daemonState,
			enabled: true,
			peers: { "peer-1": {} },
			pending: 0,
			ping: {},
			sync: {},
		} as never;

		// Act: render recovery guidance for the current daemon state.
		renderSyncStatus();

		// Assert: guidance uses a supported command and never the removed sync status spelling.
		const actions = document.getElementById("syncActions")?.textContent ?? "";
		expect(actions.includes("codemem sync peers")).toBe(expectedAction);
		expect(actions).not.toContain("codemem sync status");
	});

	it("routes no-peer pairing recovery to Devices", () => {
		document.body.innerHTML = `
			<div id="syncStatusGrid"></div>
			<div id="syncMeta"></div>
			<div id="syncActions"></div>
		`;
		state.lastSyncStatus = {
			daemon_state: "ready",
			enabled: true,
			peers: {},
			pending: 0,
			ping: {},
			sync: {},
		} as never;

		renderSyncStatus();

		expect(document.getElementById("syncMeta")?.textContent).toContain(
			"Pair another device from Devices",
		);
		expect(document.getElementById("syncMeta")?.textContent).not.toContain(
			"Show pairing command under People & devices",
		);
	});
});
