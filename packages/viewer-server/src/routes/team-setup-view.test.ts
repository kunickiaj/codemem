import { describe, expect, it } from "vitest";
import { isLegacyTeamSetupView } from "../../../ui/src/lib/api/sync.js";
import { projectLegacyTeamSetupView } from "./team-setup-view.js";

const accessDelta = {
	teamChanges: [],
	membershipChanges: [],
	projectChanges: [],
	recipientChanges: [],
	deviceAccessChanges: [],
};

function input() {
	return {
		version: 1 as const,
		candidate: {
			candidateRef: "candidate-ref",
			displayName: "Example Team",
			status: "in_progress" as const,
			deviceCount: 2,
			projectCount: 1,
			unresolvedDeviceCount: 1,
			unresolvedProjectCount: 1,
		},
		draftState: "in_progress" as const,
		attemptId: "attempt-id",
		unresolvedDeviceCount: 1,
		unresolvedProjectCount: 1,
		identityChoices: [{ identityRef: "identity-ref", displayName: "Alex" }],
		devices: [
			{
				deviceRef: "active-device",
				displayName: "Active laptop",
				enabled: true,
				existingIdentityRef: null,
				suggestedIdentityRef: null,
				verifiedEvidenceKind: null,
				decision: "unresolved" as const,
				targetIdentityRef: null,
				expectation: { kind: "absent" as const },
			},
			{
				deviceRef: "inactive-device",
				displayName: "Retired laptop",
				enabled: false,
				existingIdentityRef: null,
				suggestedIdentityRef: null,
				verifiedEvidenceKind: null,
				decision: "removed" as const,
				targetIdentityRef: null,
				expectation: { kind: "absent" as const },
			},
		],
		projects: [
			{
				projectRef: "project-ref",
				displayName: "Project",
				resolution: "unresolved" as const,
				canonicalProjectRef: null,
				resolvedProjectRef: null,
				mappingChoices: [{ resolvedProjectRef: "resolved-project-ref", displayName: "Project" }],
			},
		],
		unavailableReason: null,
		preview: null,
	};
}

describe("legacy Team setup view projection", () => {
	it.each([
		{ name: "reviewing", overrides: {} },
		{
			name: "ready_to_finish",
			overrides: {
				preview: {
					finishDigest: "finish-digest",
					accessDeltaDigest: "access-digest",
					viewerAccessDeltaDigest: "viewer-digest",
					accessDelta,
				},
			},
		},
		{
			name: "unavailable",
			overrides: { unavailableReason: "team_setup_conflict" as const },
		},
		{ name: "completed", overrides: { draftState: "completed" as const } },
	])("keeps the $name server projection compatible with the UI wire validator", ({ overrides }) => {
		const view = projectLegacyTeamSetupView({ ...input(), ...overrides });
		expect(isLegacyTeamSetupView(JSON.parse(JSON.stringify(view)) as unknown)).toBe(true);
	});

	it("projects reviewing without confirmation evidence and typed action gates", () => {
		const view = projectLegacyTeamSetupView(input());

		expect(view).toMatchObject({
			state: "reviewing",
		});
		expect(view).not.toHaveProperty("draftState");
		expect(view).not.toHaveProperty("canFinish");
		expect(view).not.toHaveProperty("conflictState");
		expect(view).not.toHaveProperty("finishDigest");
		expect(view).not.toHaveProperty("accessDelta");
		expect(view.devices[0]?.actions).toEqual({
			assignIdentity: { enabled: true, blockedReason: null },
			include: { enabled: false, blockedReason: "assignment_required" },
			exclude: { enabled: true, blockedReason: null },
			remove: { enabled: false, blockedReason: "device_active" },
			clearDecision: { enabled: false, blockedReason: "decision_unresolved" },
		});
		expect(view.devices[1]?.actions.remove).toEqual({ enabled: true, blockedReason: null });
		expect(view.projects[0]?.actions.map).toEqual({ enabled: true, blockedReason: null });
	});

	it("projects ready_to_finish with confirmation evidence only on that variant", () => {
		const view = projectLegacyTeamSetupView({
			...input(),
			unresolvedDeviceCount: 0,
			unresolvedProjectCount: 0,
			preview: {
				finishDigest: "finish-digest",
				accessDeltaDigest: "access-digest",
				viewerAccessDeltaDigest: "viewer-digest",
				accessDelta,
			},
		});

		expect(view).toMatchObject({
			state: "ready_to_finish",
			finishDigest: "finish-digest",
			accessDeltaDigest: "access-digest",
			viewerAccessDeltaDigest: "viewer-digest",
			accessDelta,
			actions: { finish: { enabled: true, blockedReason: null } },
		});
		expect(view).not.toHaveProperty("unavailableReason");
	});

	it("projects unavailable with every item mutation gate disabled", () => {
		const view = projectLegacyTeamSetupView({
			...input(),
			draftState: "stale",
			unavailableReason: "team_setup_roster_changed",
		});

		expect(view).toMatchObject({
			state: "unavailable",
		});
		expect(
			view.devices.every((device) =>
				Object.values(device.actions).every(
					(gate) => !gate.enabled && gate.blockedReason === "setup_unavailable",
				),
			),
		).toBe(true);
		expect(
			view.projects.every(
				(project) =>
					!project.actions.map.enabled && project.actions.map.blockedReason === "setup_unavailable",
			),
		).toBe(true);
		expect(view).not.toHaveProperty("finishDigest");
	});

	it("normalizes stale drafts without a reason", () => {
		const view = projectLegacyTeamSetupView({
			...input(),
			draftState: "stale",
		});

		expect(view).toMatchObject({
			state: "unavailable",
			unavailableReason: "team_setup_confirmation_stale",
		});
	});

	it("projects completed with every mutation and refresh gate disabled", () => {
		const view = projectLegacyTeamSetupView({
			...input(),
			draftState: "completed",
		});

		expect(view).toMatchObject({
			state: "completed",
		});
		expect(view.actions).toEqual({
			refresh: { enabled: false, blockedReason: "setup_completed" },
			finish: { enabled: false, blockedReason: "setup_completed" },
		});
		expect(
			view.devices.every((device) =>
				Object.values(device.actions).every(
					(gate) => !gate.enabled && gate.blockedReason === "setup_completed",
				),
			),
		).toBe(true);
	});
});
