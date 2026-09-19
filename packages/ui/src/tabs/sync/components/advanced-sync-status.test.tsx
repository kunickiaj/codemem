import { render } from "preact";
import { afterEach, describe, expect, it } from "vitest";
import type { UiTeamSyncPrimaryStatus } from "../view-model";
import { AdvancedSyncStatus } from "./advanced-sync-status";

function renderStatus(status: UiTeamSyncPrimaryStatus) {
	const mount = document.createElement("div");
	document.body.appendChild(mount);
	render(<AdvancedSyncStatus status={status} />, mount);
	return mount;
}

afterEach(() => {
	document.body.innerHTML = "";
});

describe("AdvancedSyncStatus", () => {
	it.each([
		["disabled", "Sync is off", "Off"],
		["healthy", "Sync is on", "On"],
		["needs-attention", "Sync needs attention", "Attention"],
	] as const)("renders the %s status", (state, label, badge) => {
		const root = renderStatus({
			state,
			badgeLabel: badge,
			meta: "Coordinator cannot be reached.",
			nextAction: null,
		});
		expect(root.textContent).toContain(label);
		expect(root.textContent).toContain(badge);
		expect(root.textContent).not.toContain("Coordinator cannot be reached.");
	});
});
