import { afterEach, describe, expect, it } from "vitest";
import { state } from "../../../../lib/state";
import { renderSyncStatus } from "./sync-status";

afterEach(() => {
	document.body.innerHTML = "";
	state.lastSyncStatus = null;
});

describe("renderSyncStatus", () => {
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
