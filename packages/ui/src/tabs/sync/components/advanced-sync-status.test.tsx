import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { state } from "../../../lib/state";
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

beforeEach(() => {
	state.lastSyncStatus = null;
});

describe("AdvancedSyncStatus", () => {
	it.each([
		["disabled", "Sync is off", "Off"],
		["healthy", "Not verified", "Not verified"],
		["needs-attention", "Sync needs attention", "Attention"],
	] as const)("renders the %s status", (state, label, badge) => {
		// Arrange / Act: a legacy primary status alone cannot prove replication.
		const root = renderStatus({
			state,
			badgeLabel: badge,
			meta: "Coordinator cannot be reached.",
			nextAction: null,
		});
		// Assert
		expect(root.textContent).toContain(label);
		expect(root.textContent).toContain(badge);
		expect(root.textContent).not.toContain("Coordinator cannot be reached.");
	});

	it.each([
		["exchange_succeeded", "OK", 0, 0],
		["needs_attention", "Sync needs attention", 1, 0],
		["not_verified", "Not verified", 0, 1],
	] as const)(
		"uses aggregate %s rather than a legacy healthy primary status",
		(healthState, label, attention, unverified) => {
			// Arrange
			state.lastSyncStatus = {
				sync_health: {
					state: healthState,
					peer_count: 2,
					attention_count: attention,
					unverified_count: unverified,
					stale_count: 0,
				},
			};
			// Act
			const root = renderStatus({
				state: "healthy",
				badgeLabel: "Healthy",
				meta: "",
				nextAction: null,
			});
			// Assert
			expect(root.querySelector('[role="status"] .sync-health-state')?.textContent).toContain(
				label,
			);
			expect(
				[...root.querySelectorAll(".sync-health-kpis dd")].map((node) => node.textContent),
			).toEqual(["2", String(attention), String(unverified)]);
			expect(root.textContent).not.toContain("Sync is on");
		},
	);
});
