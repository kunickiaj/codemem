import { afterEach, describe, expect, it } from "vitest";
import type { UiTeamSyncPrimaryStatus } from "../../view-model";
import { renderTeamSyncPrimaryStatus } from "./render-team-sync";

afterEach(() => {
	document.body.innerHTML = "";
});

function renderStatus(primaryStatus: UiTeamSyncPrimaryStatus) {
	const badge = document.createElement("span");
	const meta = document.createElement("div");
	renderTeamSyncPrimaryStatus(badge, meta, primaryStatus);
	return { badge, meta };
}

describe("renderTeamSyncPrimaryStatus", () => {
	it.each([
		[
			"disabled",
			{
				state: "disabled",
				badgeLabel: "Sync off",
				meta: "Team: Acme. Coordinator presence does not move Project data while sync is off.",
				nextAction: "Open Settings and turn on sync.",
			},
			"sync-online-badge sync-online-offline",
		],
		[
			"reachable",
			{
				state: "reachable",
				badgeLabel: "Reachable",
				meta: "Team: Acme. The coordinator is reachable, but healthy sync is not confirmed.",
				nextAction: "Pair and approve a device.",
			},
			"sync-online-badge sync-online-offline",
		],
		[
			"healthy",
			{
				state: "healthy",
				badgeLabel: "Healthy",
				meta: "Team: Acme. Sync is healthy.",
				nextAction: null,
			},
			"sync-online-badge",
		],
		[
			"needs attention",
			{
				state: "needs-attention",
				badgeLabel: "Needs attention",
				meta: "Team: Acme. Exact-Project setup has not converged.",
				nextAction: "Open Project sharing below and retry setup for Roadmap.",
			},
			"sync-online-badge sync-online-error",
		],
		[
			"pending setup",
			{
				state: "pending-setup",
				badgeLabel: "Setup pending",
				meta: "Team: Acme. Exact-Project setup is still pending.",
				nextAction: "Keep both devices online, then sync again.",
			},
			"sync-online-badge sync-online-offline",
		],
		[
			"trust blocked",
			{
				state: "trust-blocked",
				badgeLabel: "Pairing needed",
				meta: "Team: Acme. A device still needs two-way trust.",
				nextAction: "Finish pairing or approval on both devices.",
			},
			"sync-online-badge sync-online-error",
		],
		[
			"not enrolled",
			{
				state: "not-enrolled",
				badgeLabel: "Not enrolled",
				meta: "Team: Acme. This device is not enrolled with the coordinator.",
				nextAction: "Paste a Team invite below.",
			},
			"sync-online-badge sync-online-offline",
		],
		[
			"configured unreachable",
			{
				state: "unreachable",
				badgeLabel: "Unreachable",
				meta: "Team: Acme. The coordinator is not currently reachable.",
				nextAction: "Check the coordinator connection.",
			},
			"sync-online-badge sync-online-error",
		],
		[
			"unconfigured setup needed",
			{
				state: "unreachable",
				badgeLabel: "Setup needed",
				meta: "Configure or join a Team before expecting Project data to sync.",
				nextAction: "Configure a coordinator in Advanced settings.",
			},
			"sync-online-badge sync-online-error",
		],
	] as const)("renders %s badge and metadata", (_name, status, expectedClass) => {
		const { badge, meta } = renderStatus(status);

		expect(badge.textContent).toBe(status.badgeLabel);
		expect(badge.className).toBe(expectedClass);
		expect(meta.textContent).toBe(status.meta);
		expect(meta.textContent).not.toContain(status.nextAction ?? "__no_action__");
	});
});
