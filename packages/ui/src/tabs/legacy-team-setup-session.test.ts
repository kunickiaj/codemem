import { describe, expect, it } from "vitest";
import { LegacyTeamSetupApiError, type LegacyTeamSetupViewV1 } from "../lib/api";
import {
	createSetupSessionState,
	errorForItem,
	globalError,
	isEditable,
	type OpenSetupSessionState,
	reduceSetupSession,
	type SetupSessionEvent,
	type SetupSessionState,
} from "./legacy-team-setup-session";

function view(
	overrides: Partial<Extract<LegacyTeamSetupViewV1, { state: "reviewing" }>> = {},
): LegacyTeamSetupViewV1 {
	return {
		version: 1,
		state: "reviewing",
		candidate: {
			candidateRef: "candidate-a",
			displayName: "Example Team",
			status: "in_progress",
			deviceCount: 2,
			projectCount: 1,
			unresolvedDeviceCount: 1,
			unresolvedProjectCount: 1,
		},
		attemptId: "attempt-a",
		unresolvedDeviceCount: 1,
		unresolvedProjectCount: 1,
		devices: ["device-a", "device-b"].map((deviceRef) => ({
			deviceRef,
			displayName: deviceRef,
			enabled: true,
			existingIdentityRef: null,
			suggestedIdentityRef: null,
			verifiedEvidenceKind: null,
			decision: "unresolved" as const,
			targetIdentityRef: null,
			expectation: { kind: "absent" as const },
			actions: {
				assignIdentity: { enabled: true, blockedReason: null },
				include: { enabled: false, blockedReason: "assignment_required" },
				exclude: { enabled: true, blockedReason: null },
				remove: { enabled: false, blockedReason: "device_active" },
				clearDecision: { enabled: false, blockedReason: "decision_unresolved" },
			},
		})),
		projects: [
			{
				projectRef: "project-a",
				displayName: "Project A",
				resolution: "unresolved",
				canonicalProjectRef: null,
				resolvedProjectRef: null,
				mappingChoices: [],
				actions: { map: { enabled: false, blockedReason: "mapping_unavailable" } },
			},
		],
		identityChoices: [],
		actions: {
			refresh: { enabled: true, blockedReason: null },
			finish: { enabled: false, blockedReason: "setup_incomplete" },
		},
		...overrides,
	};
}

function open(): OpenSetupSessionState {
	const state = reduceSetupSession(createSetupSessionState(), {
		type: "open",
		candidateRef: "candidate-a",
	});
	if (state.status !== "open") throw new Error("expected open session");
	return state;
}

function readyView(): LegacyTeamSetupViewV1 {
	return {
		...view({ unresolvedDeviceCount: 0, unresolvedProjectCount: 0 }),
		state: "ready_to_finish",
		finishDigest: "finish",
		accessDeltaDigest: "access",
		viewerAccessDeltaDigest: "viewer",
		accessDelta: {
			teamChanges: [],
			membershipChanges: [],
			projectChanges: [],
			recipientChanges: [],
			deviceAccessChanges: [],
		},
		actions: {
			refresh: { enabled: true, blockedReason: null },
			finish: { enabled: true, blockedReason: null },
		},
	} as LegacyTeamSetupViewV1;
}

function loaded(current = open(), nextView = view()): OpenSetupSessionState {
	const command = current.commands[0];
	if (!command) throw new Error("expected load command");
	const state = reduceSetupSession(current, {
		type: "effect_outcome",
		outcome: {
			status: "success",
			generation: command.generation,
			id: command.id,
			kind: command.kind,
			view: nextView,
		},
	});
	if (state.status !== "open") throw new Error("expected open loaded session");
	return state;
}

describe("legacy Team setup session reducer", () => {
	it("opens with a generation-bound load command", () => {
		const state = open();

		expect(state.generation).toBe(1);
		expect(state.commands).toEqual([
			expect.objectContaining({
				kind: "load",
				candidateRef: "candidate-a",
				generation: 1,
				status: "pending",
			}),
		]);
	});

	it("discards an outcome from an older dialog generation", () => {
		const first = open();
		const oldCommand = first.commands[0];
		if (!oldCommand) throw new Error("expected old command");
		const second = reduceSetupSession(first, { type: "open", candidateRef: "candidate-b" });
		const result = reduceSetupSession(second, {
			type: "effect_outcome",
			outcome: {
				status: "success",
				generation: oldCommand.generation,
				id: oldCommand.id,
				kind: oldCommand.kind,
				view: view(),
			},
		});

		expect(result).toBe(second);
	});

	it("applies authoritative load state and plans the unresolved step", () => {
		const state = loaded();

		expect(state.view?.state).toBe("reviewing");
		expect(state.step).toBe("devices");
		expect(state.commands).toEqual([]);
	});

	it("records Projects as visited when blocked navigation redirects there", () => {
		const state = loaded();
		const redirected = reduceSetupSession(state, {
			type: "blocked_navigation",
			step: "projects",
			message: "Resolve Projects first.",
		});

		expect(redirected).toMatchObject({
			step: "projects",
			projectsVisitedAttemptId: "attempt-a",
		});
	});

	it("keeps navigation on Devices while device decisions remain unresolved", () => {
		const state = loaded();

		expect(reduceSetupSession(state, { type: "navigate", step: "projects" })).toMatchObject({
			step: "devices",
			message: "Finish the device decisions before mapping Projects.",
			focus: { targetId: "legacy-team-device-row-0" },
		});
	});

	it("keeps navigation on Projects while Project mappings remain unresolved", () => {
		const current = view({
			unresolvedDeviceCount: 0,
			devices: view().devices.map((device) => ({ ...device, decision: "excluded" as const })),
		});
		const state = loaded(open(), current);

		expect(reduceSetupSession(state, { type: "navigate", step: "review" })).toMatchObject({
			step: "projects",
			message: "Finish the Project mappings before reviewing access.",
			focus: { targetId: "legacy-team-project-row-0" },
		});
	});

	it("does not expose completed as an interactive navigation destination", () => {
		const state = loaded();
		const fabricated = { type: "navigate", step: "completed" } as unknown as SetupSessionEvent;

		expect(reduceSetupSession(state, fabricated)).toBe(state);
	});

	it("preserves the open session while a mutation is active", () => {
		const mutation = reduceSetupSession(loaded(), {
			type: "decide_device",
			deviceRef: "device-a",
			decision: "excluded",
		});

		expect(reduceSetupSession(mutation, { type: "close" })).toBe(mutation);
		expect(reduceSetupSession(mutation, { type: "open", candidateRef: "candidate-b" })).toBe(
			mutation,
		);
	});

	it("preserves the open session while an authoritative refresh is active", () => {
		const refresh = reduceSetupSession(loaded(), { type: "refresh" });

		expect(reduceSetupSession(refresh, { type: "close" })).toBe(refresh);
		expect(reduceSetupSession(refresh, { type: "open", candidateRef: "candidate-b" })).toBe(
			refresh,
		);
	});

	it("replaces the session while an ordinary read-only load is pending", () => {
		const loading = open();

		expect(reduceSetupSession(loading, { type: "close" })).toMatchObject({
			status: "closed",
		});
	});

	it("scopes an ordinary mutation failure to one device", () => {
		let state: SetupSessionState = loaded();
		state = reduceSetupSession(state, {
			type: "decide_device",
			deviceRef: "device-a",
			decision: "excluded",
		});
		if (state.status !== "open") throw new Error("expected open mutation session");
		expect(state.message).toBe("Saving the decision for device-a.");
		const command = state.commands[0];
		if (!command) throw new Error("expected mutation command");
		state = reduceSetupSession(state, {
			type: "effect_outcome",
			outcome: {
				status: "failure",
				generation: command.generation,
				id: command.id,
				kind: command.kind,
				cause: new Error("private failure"),
			},
		});
		if (state.status !== "open") throw new Error("expected open failed session");

		expect(errorForItem(state, "device", "device-a")?.message).toContain("could not be saved");
		expect(errorForItem(state, "device", "device-b")).toBeNull();
		expect(
			reduceSetupSession(state, {
				type: "decide_device",
				deviceRef: "device-b",
				decision: "excluded",
			}),
		).toMatchObject({ commands: [expect.objectContaining({ deviceRef: "device-b" })] });
	});

	it("focuses the next step when an unrelated item error remains", () => {
		let state: SetupSessionState = {
			...loaded(),
			errors: [
				{
					scope: { kind: "device", itemRef: "device-a" },
					message: "Retry this device change",
					retry: "load",
				},
			],
		};
		state = reduceSetupSession(state, {
			type: "decide_device",
			deviceRef: "device-b",
			decision: "excluded",
		});
		if (state.status !== "open") throw new Error("expected open mutation session");
		const command = state.commands[0];
		if (!command) throw new Error("expected mutation command");
		const nextView = view({
			unresolvedDeviceCount: 0,
			devices: view().devices.map((device) => ({ ...device, decision: "excluded" as const })),
		});

		state = reduceSetupSession(state, {
			type: "effect_outcome",
			outcome: {
				status: "success",
				generation: command.generation,
				id: command.id,
				kind: command.kind,
				view: nextView,
			},
		});

		expect(state).toMatchObject({
			step: "projects",
			focus: { targetId: "legacy-team-setup-step-projects" },
			errors: [expect.objectContaining({ scope: { kind: "device", itemRef: "device-a" } })],
		});
	});

	it("ignores device mutations while an authoritative refresh is running", () => {
		const refreshing = reduceSetupSession(loaded(), { type: "refresh" });
		if (refreshing.status !== "open") throw new Error("expected open refresh session");

		expect(refreshing.commands).toEqual([expect.objectContaining({ kind: "refresh" })]);
		expect(
			reduceSetupSession(refreshing, {
				type: "decide_device",
				deviceRef: "device-a",
				decision: "excluded",
			}),
		).toBe(refreshing);
	});

	it("ignores Project mutations while an authoritative refresh is running", () => {
		const current = view();
		const project = current.projects[0];
		if (!project) throw new Error("expected project");
		const state = loaded(open(), {
			...current,
			projects: [
				{
					...project,
					mappingChoices: [{ resolvedProjectRef: "resolved-project-a", displayName: "Project A" }],
					actions: { map: { enabled: true, blockedReason: null } },
				},
			],
		});
		const refreshing = reduceSetupSession(state, { type: "refresh" });
		if (refreshing.status !== "open") throw new Error("expected open refresh session");

		expect(
			reduceSetupSession(refreshing, {
				type: "map_project",
				projectRef: "project-a",
				resolvedProjectRef: "resolved-project-a",
			}),
		).toBe(refreshing);
	});

	it("announces a Project mapping while it is being saved", () => {
		const current = view();
		const project = current.projects[0];
		if (!project) throw new Error("expected project");
		const state = loaded(open(), {
			...current,
			projects: [
				{
					...project,
					mappingChoices: [{ resolvedProjectRef: "resolved-project-a", displayName: "Project A" }],
					actions: { map: { enabled: true, blockedReason: null } },
				},
			],
		});
		const saving = reduceSetupSession(state, {
			type: "map_project",
			projectRef: "project-a",
			resolvedProjectRef: "resolved-project-a",
		});

		expect(saving).toMatchObject({ message: "Saving the mapping for Project A." });
	});

	it("ignores refresh when the authoritative action gate is disabled", () => {
		const current = view();
		const completed = loaded(open(), {
			...current,
			state: "completed",
			actions: {
				...current.actions,
				refresh: { enabled: false, blockedReason: "setup_completed" },
			},
		} as LegacyTeamSetupViewV1);

		expect(reduceSetupSession(completed, { type: "refresh" })).toBe(completed);
	});

	it("ignores refresh while an item mutation is running", () => {
		const mutation = reduceSetupSession(loaded(), {
			type: "decide_device",
			deviceRef: "device-a",
			decision: "excluded",
		});

		expect(reduceSetupSession(mutation, { type: "refresh" })).toBe(mutation);
	});

	it("ignores retry and a second item mutation while an item mutation is active", () => {
		const mutation = reduceSetupSession(loaded(), {
			type: "decide_device",
			deviceRef: "device-a",
			decision: "excluded",
		});

		expect(reduceSetupSession(mutation, { type: "retry" })).toBe(mutation);
		expect(
			reduceSetupSession(mutation, {
				type: "decide_device",
				deviceRef: "device-b",
				decision: "excluded",
			}),
		).toBe(mutation);
	});

	it("treats roster outages from item mutations as global recovery errors", () => {
		let state: SetupSessionState = reduceSetupSession(loaded(), {
			type: "decide_device",
			deviceRef: "device-a",
			decision: "excluded",
		});
		if (state.status !== "open") throw new Error("expected open mutation session");
		const command = state.commands[0];
		if (!command) throw new Error("expected mutation command");
		state = reduceSetupSession(state, {
			type: "effect_outcome",
			outcome: {
				status: "failure",
				generation: command.generation,
				id: command.id,
				kind: command.kind,
				cause: new LegacyTeamSetupApiError(503, "team_setup_roster_unavailable"),
			},
		});
		if (state.status !== "open") throw new Error("expected open failed session");

		expect(globalError(state)).toMatchObject({ scope: { kind: "global" } });
		expect(errorForItem(state, "device", "device-a")).toBeNull();
		expect(
			reduceSetupSession(state, {
				type: "decide_device",
				deviceRef: "device-b",
				decision: "excluded",
			}),
		).toBe(state);
	});

	it.each([
		["team_setup_completion_unavailable", "Team setup completion could not be checked"],
		[
			"team_setup_completion_conflict",
			"Another device completed this Team with different reviewed details",
		],
		["team_setup_completion_invalid", "The completed Team setup could not be verified"],
	] as const)("treats %s as a global reload recovery error", (errorCode, expectedMessage) => {
		// Arrange
		let state: SetupSessionState = reduceSetupSession(loaded(), {
			type: "decide_device",
			deviceRef: "device-a",
			decision: "excluded",
		});
		if (state.status !== "open") throw new Error("expected open mutation session");
		const command = state.commands[0];
		if (!command) throw new Error("expected mutation command");

		// Act
		state = reduceSetupSession(state, {
			type: "effect_outcome",
			outcome: {
				status: "failure",
				generation: command.generation,
				id: command.id,
				kind: command.kind,
				cause: new LegacyTeamSetupApiError(409, errorCode),
			},
		});

		// Assert
		if (state.status !== "open") throw new Error("expected open failed session");
		expect(globalError(state)).toMatchObject({
			scope: { kind: "global" },
			message: expect.stringContaining(expectedMessage),
			retry: "load",
		});
		expect(globalError(state)?.message).not.toContain(errorCode);
		expect(errorForItem(state, "device", "device-a")).toBeNull();
	});

	function failPendingLoad(state: SetupSessionState, cause: Error): SetupSessionState {
		if (state.status !== "open") throw new Error("expected open session");
		const command = state.commands.find((entry) => entry.status === "pending");
		if (!command) throw new Error("expected pending load command");
		return reduceSetupSession(state, {
			type: "effect_outcome",
			outcome: {
				status: "failure",
				generation: command.generation,
				id: command.id,
				kind: command.kind,
				cause,
			},
		});
	}

	function retryAndFailLoad(state: SetupSessionState, cause: Error): OpenSetupSessionState {
		const next = failPendingLoad(reduceSetupSession(state, { type: "retry" }), cause);
		if (next.status !== "open") throw new Error("expected open failed session");
		return next;
	}

	it("replaces a stale load error when a retried load reports a completion outcome", () => {
		const initialFailure = failPendingLoad(open(), new Error("network down"));
		if (initialFailure.status !== "open") throw new Error("expected open failed session");
		expect(globalError(initialFailure)).toMatchObject({ scope: { kind: "load" } });

		const completionFailure = retryAndFailLoad(
			initialFailure,
			new LegacyTeamSetupApiError(409, "team_setup_completion_conflict"),
		);
		expect(completionFailure.errors).toHaveLength(1);
		expect(globalError(completionFailure)).toMatchObject({
			scope: { kind: "global" },
			message: expect.stringContaining("Another device completed this Team"),
		});

		const genericFailureAgain = retryAndFailLoad(completionFailure, new Error("network down"));
		expect(genericFailureAgain.errors).toHaveLength(1);
		expect(globalError(genericFailureAgain)?.message).not.toContain(
			"Another device completed this Team",
		);
	});

	it("prioritizes global refresh recovery and preserves it after a transient failure", () => {
		let state: OpenSetupSessionState = {
			...loaded(),
			errors: [
				{ scope: { kind: "device", itemRef: "device-a" }, message: "item", retry: "load" },
				{ scope: { kind: "global" }, message: "global", retry: "refresh" },
			],
		};
		state = reduceSetupSession(state, { type: "retry" }) as OpenSetupSessionState;
		const command = state.commands[0];
		if (command?.kind !== "load") throw new Error("expected recovery load");
		expect(command.refresh).toBe(true);

		state = reduceSetupSession(state, {
			type: "effect_outcome",
			outcome: {
				status: "failure",
				generation: command.generation,
				id: command.id,
				kind: command.kind,
				cause: new Error("temporary failure"),
			},
		}) as OpenSetupSessionState;
		expect(globalError(state)?.retry).toBe("refresh");
	});

	it("preserves refresh recovery after an explicit refresh fails", () => {
		let state = reduceSetupSession(loaded(), { type: "refresh" });
		if (state.status !== "open") throw new Error("expected refresh session");
		const command = state.commands[0];
		if (command?.kind !== "refresh") throw new Error("expected refresh command");
		state = reduceSetupSession(state, {
			type: "effect_outcome",
			outcome: {
				status: "failure",
				generation: command.generation,
				id: command.id,
				kind: command.kind,
				cause: new Error("temporary failure"),
			},
		});
		if (state.status !== "open") throw new Error("expected failed refresh session");

		expect(globalError(state)?.retry).toBe("refresh");
	});

	it("restores failed unavailable recovery focus to the recovery retry", () => {
		const unavailable = {
			...view(),
			state: "unavailable",
			unavailableReason: "team_setup_roster_changed",
			actions: {
				refresh: { enabled: true, blockedReason: null },
				finish: { enabled: false, blockedReason: "setup_unavailable" },
			},
		} as LegacyTeamSetupViewV1;
		let state: SetupSessionState = reduceSetupSession(loaded(open(), unavailable), {
			type: "retry",
		});
		if (state.status !== "open") throw new Error("expected recovery session");
		const command = state.commands[0];
		if (command?.kind !== "load") throw new Error("expected recovery load");
		state = reduceSetupSession(state, {
			type: "effect_outcome",
			outcome: {
				status: "failure",
				generation: command.generation,
				id: command.id,
				kind: command.kind,
				cause: new Error("temporary failure"),
			},
		});

		expect(state).toMatchObject({
			focus: { targetId: "legacy-team-setup-retry" },
		});
	});

	it("preserves the session while unavailable recovery refresh is active", () => {
		const unavailable = {
			...view(),
			state: "unavailable",
			unavailableReason: "team_setup_roster_changed",
			actions: {
				refresh: { enabled: true, blockedReason: null },
				finish: { enabled: false, blockedReason: "setup_unavailable" },
			},
		} as LegacyTeamSetupViewV1;
		const recovery = reduceSetupSession(loaded(open(), unavailable), { type: "retry" });

		expect(reduceSetupSession(recovery, { type: "close" })).toBe(recovery);
		expect(reduceSetupSession(recovery, { type: "open", candidateRef: "candidate-b" })).toBe(
			recovery,
		);
	});

	it("blocks finish while global recovery is unresolved", () => {
		const state: OpenSetupSessionState = {
			...loaded(open(), readyView()),
			errors: [{ scope: { kind: "global" }, message: "Reload required", retry: "load" }],
		};

		expect(reduceSetupSession(state, { type: "finish" })).toBe(state);
	});

	it("blocks finish while an item save error is unresolved", () => {
		const state: OpenSetupSessionState = {
			...loaded(open(), readyView()),
			errors: [
				{
					scope: { kind: "device", itemRef: "device-a" },
					message: "The device decision could not be saved.",
					retry: "load",
				},
			],
		};

		expect(reduceSetupSession(state, { type: "finish" })).toBe(state);
	});

	it("unblocks finish after an authoritative refresh clears an item error", () => {
		let state: SetupSessionState = {
			...loaded(),
			errors: [
				{
					scope: { kind: "device", itemRef: "device-a" },
					message: "The device decision could not be saved.",
					retry: "load",
				},
			],
		};
		state = reduceSetupSession(state, { type: "refresh" });
		if (state.status !== "open") throw new Error("expected refresh session");
		const command = state.commands[0];
		if (command?.kind !== "refresh") throw new Error("expected refresh command");
		state = reduceSetupSession(state, {
			type: "effect_outcome",
			outcome: {
				status: "success",
				generation: command.generation,
				id: command.id,
				kind: command.kind,
				view: readyView(),
			},
		});

		expect(state).toMatchObject({ errors: [] });
		expect(reduceSetupSession(state, { type: "finish" })).toMatchObject({
			commands: [expect.objectContaining({ kind: "finish" })],
		});
	});

	it("blocks finish resubmission after an ordinary finish failure", () => {
		let state = reduceSetupSession(loaded(open(), readyView()), { type: "finish" });
		if (state.status !== "open") throw new Error("expected finish session");
		const command = state.commands[0];
		if (command?.kind !== "finish") throw new Error("expected finish command");
		state = reduceSetupSession(state, {
			type: "effect_outcome",
			outcome: {
				status: "failure",
				generation: command.generation,
				id: command.id,
				kind: command.kind,
				cause: new Error("temporary failure"),
			},
		});
		if (state.status !== "open") throw new Error("expected failed finish session");

		expect(globalError(state)).not.toBeNull();
		expect(reduceSetupSession(state, { type: "finish" })).toBe(state);
	});

	it("reloads completion state after finish publication is unavailable", () => {
		let state = reduceSetupSession(loaded(open(), readyView()), { type: "finish" });
		if (state.status !== "open") throw new Error("expected finish session");
		const command = state.commands[0];
		if (command?.kind !== "finish") throw new Error("expected finish command");
		state = reduceSetupSession(state, {
			type: "effect_outcome",
			outcome: {
				status: "failure",
				generation: command.generation,
				id: command.id,
				kind: command.kind,
				cause: new LegacyTeamSetupApiError(503, "team_setup_completion_unavailable"),
			},
		});
		if (state.status !== "open") throw new Error("expected failed finish session");

		expect(globalError(state)).toMatchObject({
			message: expect.stringContaining("no local changes were applied"),
			retry: "load",
		});
		expect(globalError(state)?.message).not.toContain("setup was not finished");
		state = reduceSetupSession(state, { type: "retry" });
		expect(state).toMatchObject({
			commands: [expect.objectContaining({ kind: "load", refresh: false })],
		});
	});

	it("uses a plain detail retry when confirmation-stale recovery also fails", () => {
		let state = reduceSetupSession(loaded(open(), readyView()), { type: "finish" });
		if (state.status !== "open") throw new Error("expected finish session");
		const command = state.commands[0];
		if (command?.kind !== "finish") throw new Error("expected finish command");
		state = reduceSetupSession(state, {
			type: "effect_outcome",
			outcome: {
				status: "failure",
				generation: command.generation,
				id: command.id,
				kind: command.kind,
				cause: new LegacyTeamSetupApiError(409, "team_setup_confirmation_stale"),
				recoveryCause: new LegacyTeamSetupApiError(503, "team_setup_completion_unavailable"),
			},
		});
		if (state.status !== "open") throw new Error("expected failed finish session");

		expect(globalError(state)).toMatchObject({
			message: expect.stringContaining("changed since it was last reviewed"),
			retry: "load",
		});
		expect(globalError(state)?.message).not.toContain("no local changes were applied");
		state = reduceSetupSession(state, { type: "retry" });
		expect(state).toMatchObject({
			commands: [expect.objectContaining({ kind: "load", refresh: false })],
		});
	});

	it("preserves refresh retry when roster-change recovery also fails", () => {
		let state = reduceSetupSession(loaded(open(), readyView()), { type: "finish" });
		if (state.status !== "open") throw new Error("expected finish session");
		const command = state.commands[0];
		if (command?.kind !== "finish") throw new Error("expected finish command");
		state = reduceSetupSession(state, {
			type: "effect_outcome",
			outcome: {
				status: "failure",
				generation: command.generation,
				id: command.id,
				kind: command.kind,
				cause: new LegacyTeamSetupApiError(409, "team_setup_roster_changed"),
				recoveryCause: new LegacyTeamSetupApiError(503, "team_setup_completion_unavailable"),
			},
		});
		if (state.status !== "open") throw new Error("expected failed finish session");

		expect(globalError(state)).toMatchObject({
			message: expect.stringContaining("changed since it was last reviewed"),
			retry: "refresh",
		});
		state = reduceSetupSession(state, { type: "retry" });
		expect(state).toMatchObject({
			commands: [expect.objectContaining({ kind: "load", refresh: true })],
		});
	});

	it.each([
		["team_setup_completion_conflict", "different reviewed details"],
		["team_setup_completion_invalid", "could not be verified"],
	] as const)(
		"surfaces terminal recovery error %s with a detail retry",
		(errorCode, expectedMessage) => {
			let state = reduceSetupSession(loaded(open(), readyView()), { type: "finish" });
			if (state.status !== "open") throw new Error("expected finish session");
			const command = state.commands[0];
			if (command?.kind !== "finish") throw new Error("expected finish command");
			state = reduceSetupSession(state, {
				type: "effect_outcome",
				outcome: {
					status: "failure",
					generation: command.generation,
					id: command.id,
					kind: command.kind,
					cause: new LegacyTeamSetupApiError(409, "team_setup_roster_changed"),
					recoveryCause: new LegacyTeamSetupApiError(409, errorCode),
				},
			});
			if (state.status !== "open") throw new Error("expected failed finish session");

			expect(globalError(state)).toMatchObject({
				message: expect.stringContaining(expectedMessage),
				retry: "load",
			});
			state = reduceSetupSession(state, { type: "retry" });
			expect(state).toMatchObject({
				commands: [expect.objectContaining({ kind: "load", refresh: false })],
			});
		},
	);

	it("uses a plain detail retry when roster-change recovery finds a completed draft", () => {
		let state = reduceSetupSession(loaded(open(), readyView()), { type: "finish" });
		if (state.status !== "open") throw new Error("expected finish session");
		const command = state.commands[0];
		if (command?.kind !== "finish") throw new Error("expected finish command");
		state = reduceSetupSession(state, {
			type: "effect_outcome",
			outcome: {
				status: "failure",
				generation: command.generation,
				id: command.id,
				kind: command.kind,
				cause: new LegacyTeamSetupApiError(409, "team_setup_roster_changed"),
				recoveryCause: new LegacyTeamSetupApiError(409, "team_setup_confirmation_stale"),
			},
		});
		if (state.status !== "open") throw new Error("expected failed finish session");

		expect(globalError(state)).toMatchObject({
			message: expect.stringContaining("changed since it was last reviewed"),
			retry: "load",
		});
		state = reduceSetupSession(state, { type: "retry" });
		expect(state).toMatchObject({
			commands: [expect.objectContaining({ kind: "load", refresh: false })],
		});
	});

	it.each([
		{ type: "decide_device", deviceRef: "device-a", decision: "included" },
		{ type: "decide_device", deviceRef: "device-a", decision: "removed" },
		{ type: "clear_device", deviceRef: "device-a" },
	] as const)("ignores disabled device action $type", (event) => {
		const state = loaded();

		expect(reduceSetupSession(state, event)).toBe(state);
	});

	it("ignores a disabled device assignment", () => {
		const current = view();
		const firstDevice = current.devices[0];
		if (!firstDevice) throw new Error("expected device");
		const state = loaded(open(), {
			...current,
			devices: [
				{
					...firstDevice,
					actions: {
						...firstDevice.actions,
						assignIdentity: { enabled: false, blockedReason: "assignment_unavailable" },
					},
				},
				...current.devices.slice(1),
			],
		});

		expect(
			reduceSetupSession(state, {
				type: "assign_device",
				deviceRef: "device-a",
				targetIdentityRef: "identity-a",
			}),
		).toBe(state);
	});

	it.each([
		{ projectRef: "missing-project", resolvedProjectRef: "resolved-project-a" },
		{ projectRef: "project-a", resolvedProjectRef: "resolved-project-a" },
	] as const)("ignores unavailable Project mapping for $projectRef", (event) => {
		const state = loaded();

		expect(reduceSetupSession(state, { type: "map_project", ...event })).toBe(state);
	});

	it("ignores a Project mapping choice absent from the authoritative view", () => {
		const current = view();
		const project = current.projects[0];
		if (!project) throw new Error("expected project");
		const state = loaded(open(), {
			...current,
			projects: [
				{
					...project,
					mappingChoices: [{ resolvedProjectRef: "resolved-project-a", displayName: "Project A" }],
					actions: { map: { enabled: true, blockedReason: null } },
				},
			],
		});

		expect(
			reduceSetupSession(state, {
				type: "map_project",
				projectRef: "project-a",
				resolvedProjectRef: "resolved-project-b",
			}),
		).toBe(state);
	});

	it("never treats unavailable views as editable", () => {
		const unavailable = {
			...view(),
			state: "unavailable",
			unavailableReason: "team_setup_conflict",
			actions: {
				refresh: { enabled: true, blockedReason: null },
				finish: { enabled: false, blockedReason: "setup_unavailable" },
			},
		} as LegacyTeamSetupViewV1;

		expect(isEditable(unavailable)).toBe(false);
	});

	it("enforces server action gates before enqueuing mutations", () => {
		const state = loaded();

		expect(
			reduceSetupSession(state, {
				type: "decide_device",
				deviceRef: "device-a",
				decision: "included",
				targetIdentityRef: "identity-a",
			}),
		).toBe(state);
		expect(
			reduceSetupSession(state, {
				type: "map_project",
				projectRef: "project-a",
				resolvedProjectRef: "resolved-a",
			}),
		).toBe(state);
	});

	it("prefers authoritative refresh when any accumulated error requires it", () => {
		const state: OpenSetupSessionState = {
			...loaded(),
			errors: [
				{
					scope: { kind: "device", itemRef: "device-a" },
					message: "Device failed",
					retry: "load",
				},
				{ scope: { kind: "global" }, message: "State changed", retry: "refresh" },
			],
		};
		const retried = reduceSetupSession(state, { type: "retry" });

		expect(retried).toMatchObject({
			commands: [expect.objectContaining({ kind: "load", refresh: true })],
		});
	});

	it("does not queue retry while an item mutation is running", () => {
		const state = reduceSetupSession(
			{
				...loaded(),
				errors: [
					{
						scope: { kind: "project", itemRef: "project-a" },
						message: "Project failed",
						retry: "load",
					},
				],
			},
			{ type: "decide_device", deviceRef: "device-a", decision: "excluded" },
		);
		if (state.status !== "open") throw new Error("expected open session");

		expect(state.commands).toEqual([expect.objectContaining({ kind: "decide_device" })]);
		expect(reduceSetupSession(state, { type: "retry" })).toBe(state);
	});

	it("queues completion refresh exactly once after finish", () => {
		let state: SetupSessionState = loaded(open(), readyView());
		state = reduceSetupSession(state, { type: "finish" });
		if (state.status !== "open") throw new Error("expected finish session");
		const finish = state.commands[0];
		if (!finish) throw new Error("expected finish command");
		state = reduceSetupSession(state, {
			type: "effect_outcome",
			outcome: {
				status: "success",
				generation: finish.generation,
				id: finish.id,
				kind: finish.kind,
			},
		});
		if (state.status !== "open") throw new Error("expected completed session");

		expect(state.step).toBe("completed");
		const completionRefresh = state.commands.find(
			(command) => command.kind === "completion_refresh",
		);
		if (!completionRefresh) throw new Error("expected completion refresh command");
		state = reduceSetupSession(state, {
			type: "effect_outcome",
			outcome: {
				status: "success",
				generation: completionRefresh.generation,
				id: completionRefresh.id,
				kind: completionRefresh.kind,
			},
		});
		if (state.status !== "open") throw new Error("expected settled completed session");
		expect(state.commands).toEqual([]);
		expect(reduceSetupSession(state, { type: "navigate", step: "devices" })).toBe(state);
		expect(reduceSetupSession(state, { type: "retry" })).toBe(state);
		expect(reduceSetupSession(state, { type: "finish" })).toBe(state);
		expect(
			reduceSetupSession(state, {
				type: "decide_device",
				deviceRef: "device-a",
				decision: "excluded",
			}),
		).toBe(state);
	});
});
