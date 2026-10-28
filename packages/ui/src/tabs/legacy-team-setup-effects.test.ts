import { describe, expect, it, vi } from "vitest";
import { LegacyTeamSetupApiError, type LegacyTeamSetupViewV1 } from "../lib/api";
import {
	createSetupEffectRunner,
	type SetupEffect,
	type SetupEffectDependencies,
} from "./legacy-team-setup-effects";

const view = { state: "reviewing" } as LegacyTeamSetupViewV1;

function dependencies(overrides: Partial<SetupEffectDependencies> = {}): SetupEffectDependencies {
	return {
		clearDecision: vi.fn(),
		finish: vi.fn(),
		loadDetail: vi.fn().mockResolvedValue(view),
		onCompleted: vi.fn(),
		refreshCandidate: vi.fn().mockResolvedValue(view),
		saveAssignment: vi.fn(),
		saveDecision: vi.fn(),
		saveProjectMapping: vi.fn(),
		...overrides,
	} as SetupEffectDependencies;
}

function effect(input: Partial<SetupEffect> & Pick<SetupEffect, "kind">): SetupEffect {
	return {
		candidateRef: "candidate",
		generation: 7,
		id: `7:${input.kind}`,
		status: "running",
		...input,
	} as SetupEffect;
}

describe("legacy Team setup effect runner", () => {
	it("returns authoritative load outcomes with the originating generation", async () => {
		const deps = dependencies();
		const outcome = await createSetupEffectRunner(deps)(
			effect({ kind: "load", refresh: false, focusOnOutcome: true }),
		);

		expect(deps.loadDetail).toHaveBeenCalledWith("candidate");
		expect(outcome).toMatchObject({
			status: "success",
			generation: 7,
			kind: "load",
			view,
		});
	});

	it("recovers changed mutation failures with a fresh authoritative view", async () => {
		const cause = new LegacyTeamSetupApiError(409, "team_setup_assignment_changed");
		const deps = dependencies({ saveDecision: vi.fn().mockRejectedValue(cause) });
		const outcome = await createSetupEffectRunner(deps)(
			effect({
				kind: "decide_device",
				deviceRef: "device",
				input: { attemptId: "attempt", decision: "excluded" },
			}),
		);

		expect(deps.loadDetail).toHaveBeenCalledWith("candidate");
		expect(outcome).toMatchObject({ status: "failure", cause, recoveredView: view });
	});

	it("reloads once when detail reconciliation makes the prior confirmation stale", async () => {
		const cause = new LegacyTeamSetupApiError(409, "team_setup_confirmation_stale");
		const completedView = { state: "completed" } as LegacyTeamSetupViewV1;
		const loadDetail = vi.fn().mockRejectedValueOnce(cause).mockResolvedValueOnce(completedView);
		const outcome = await createSetupEffectRunner(dependencies({ loadDetail }))(
			effect({ kind: "load", refresh: false, focusOnOutcome: true }),
		);

		expect(loadDetail).toHaveBeenCalledTimes(2);
		expect(outcome).toMatchObject({ status: "success", view: completedView });
		expect(outcome).not.toHaveProperty("cause");
	});

	it("preserves a failure from the one-shot detail recovery", async () => {
		const stale = new LegacyTeamSetupApiError(409, "team_setup_confirmation_stale");
		const unavailable = new LegacyTeamSetupApiError(503, "team_setup_completion_unavailable");
		const loadDetail = vi.fn().mockRejectedValueOnce(stale).mockRejectedValueOnce(unavailable);
		const outcome = await createSetupEffectRunner(dependencies({ loadDetail }))(
			effect({ kind: "load", refresh: false, focusOnOutcome: true }),
		);

		expect(loadDetail).toHaveBeenCalledTimes(2);
		expect(outcome).toMatchObject({ status: "failure", cause: stale, recoveryCause: unavailable });
		expect(outcome).not.toHaveProperty("recoveredView");
	});

	it("does not reload a confirmation-stale refresh request", async () => {
		const cause = new LegacyTeamSetupApiError(409, "team_setup_confirmation_stale");
		const loadDetail = vi.fn();
		const refreshCandidate = vi.fn().mockRejectedValue(cause);
		const outcome = await createSetupEffectRunner(dependencies({ loadDetail, refreshCandidate }))(
			effect({ kind: "load", refresh: true, focusOnOutcome: true }),
		);

		expect(refreshCandidate).toHaveBeenCalledOnce();
		expect(loadDetail).not.toHaveBeenCalled();
		expect(outcome).not.toHaveProperty("recoveredView");
	});

	it("does not reload detail for unrelated changed-state errors", async () => {
		const cause = new LegacyTeamSetupApiError(409, "team_setup_roster_changed");
		const loadDetail = vi.fn().mockRejectedValue(cause);
		const outcome = await createSetupEffectRunner(dependencies({ loadDetail }))(
			effect({ kind: "load", refresh: false, focusOnOutcome: true }),
		);

		expect(loadDetail).toHaveBeenCalledOnce();
		expect(outcome).not.toHaveProperty("recoveredView");
	});

	it("does not recover ordinary item failures by reloading", async () => {
		const cause = new Error("safe test failure");
		const deps = dependencies({ saveDecision: vi.fn().mockRejectedValue(cause) });
		const outcome = await createSetupEffectRunner(deps)(
			effect({
				kind: "decide_device",
				deviceRef: "device",
				input: { attemptId: "attempt", decision: "excluded" },
			}),
		);

		expect(deps.loadDetail).not.toHaveBeenCalled();
		expect(outcome).toMatchObject({ status: "failure", cause });
		expect(outcome).not.toHaveProperty("recoveredView");
	});

	it("coalesces concurrent completion refreshes for one attempt", async () => {
		let release = () => undefined;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const deps = dependencies({ onCompleted: vi.fn(() => pending) });
		const run = createSetupEffectRunner(deps);
		const first = run(effect({ kind: "completion_refresh", id: "7:first", attemptId: "attempt" }));
		const second = run(
			effect({ kind: "completion_refresh", id: "7:second", attemptId: "attempt" }),
		);
		await Promise.resolve();

		expect(deps.onCompleted).toHaveBeenCalledOnce();
		release();
		await expect(Promise.all([first, second])).resolves.toHaveLength(2);
	});
});

const staleView = {
	state: "unavailable",
	unavailableReason: "team_setup_confirmation_stale",
} as LegacyTeamSetupViewV1;

describe("initial Team setup stale draft revalidation", () => {
	it.each(["reviewing", "ready_to_finish", "completed"] as const)(
		"replaces a saved stale draft with the refreshed %s view",
		async (state) => {
			const replacement = { state, attemptId: "replacement" } as LegacyTeamSetupViewV1;
			const deps = dependencies({
				loadDetail: vi.fn().mockResolvedValue(staleView),
				refreshCandidate: vi.fn().mockResolvedValue(replacement),
			});
			const command = effect({ kind: "load", refresh: false, focusOnOutcome: true });

			const outcome = await createSetupEffectRunner(deps)(command);

			expect(deps.loadDetail).toHaveBeenCalledExactlyOnceWith("candidate");
			expect(deps.refreshCandidate).toHaveBeenCalledExactlyOnceWith("candidate");
			expect(vi.mocked(deps.loadDetail).mock.invocationCallOrder[0]).toBeLessThan(
				vi.mocked(deps.refreshCandidate).mock.invocationCallOrder[0] as number,
			);
			expect(outcome).toEqual({
				status: "success",
				generation: command.generation,
				id: command.id,
				kind: "load",
				view: replacement,
			});
			// Revalidation must not apply draft choices or complete the setup.
			expect(deps.saveAssignment).not.toHaveBeenCalled();
			expect(deps.saveDecision).not.toHaveBeenCalled();
			expect(deps.saveProjectMapping).not.toHaveBeenCalled();
			expect(deps.clearDecision).not.toHaveBeenCalled();
			expect(deps.finish).not.toHaveBeenCalled();
			expect(deps.onCompleted).not.toHaveBeenCalled();
		},
	);

	it("returns a still-unavailable refresh result without another POST", async () => {
		const deps = dependencies({
			loadDetail: vi.fn().mockResolvedValue(staleView),
			refreshCandidate: vi.fn().mockResolvedValue(staleView),
		});

		const outcome = await createSetupEffectRunner(deps)(
			effect({ kind: "load", refresh: false, focusOnOutcome: true }),
		);

		expect(deps.loadDetail).toHaveBeenCalledOnce();
		expect(deps.refreshCandidate).toHaveBeenCalledOnce();
		expect(outcome).toMatchObject({ status: "success", view: staleView });
	});
});

describe("initial Team setup refresh exclusions", () => {
	it.each([{ completionOnly: true }, { readOnlyRecovery: true }])(
		"does not refresh stale detail for restricted load %j",
		async (mode) => {
			const deps = dependencies({ loadDetail: vi.fn().mockResolvedValue(staleView) });

			const outcome = await createSetupEffectRunner(deps)(
				effect({ kind: "load", refresh: false, focusOnOutcome: true, ...mode }),
			);

			expect(deps.loadDetail).toHaveBeenCalledExactlyOnceWith("candidate");
			expect(deps.refreshCandidate).not.toHaveBeenCalled();
			expect(outcome).toMatchObject({ status: "success", view: staleView });
		},
	);

	it.each([
		{ state: "reviewing" },
		{ state: "ready_to_finish" },
		{ state: "completed" },
		{ state: "unavailable", unavailableReason: "team_setup_roster_changed" },
		{ state: "unavailable", unavailableReason: "team_setup_conflict" },
		{ state: "unavailable", unavailableReason: "team_setup_completion_unavailable" },
	])("does not refresh ordinary detail %j", async (detail) => {
		const loadedView = detail as LegacyTeamSetupViewV1;
		const deps = dependencies({ loadDetail: vi.fn().mockResolvedValue(loadedView) });

		const outcome = await createSetupEffectRunner(deps)(
			effect({ kind: "load", refresh: false, focusOnOutcome: true }),
		);

		expect(deps.loadDetail).toHaveBeenCalledOnce();
		expect(deps.refreshCandidate).not.toHaveBeenCalled();
		expect(outcome).toMatchObject({ status: "success", view: loadedView });
	});

	it("keeps explicit refresh independent of detail loading and automatic revalidation", async () => {
		const deps = dependencies({ refreshCandidate: vi.fn().mockResolvedValue(staleView) });

		const outcome = await createSetupEffectRunner(deps)(
			effect({ kind: "load", refresh: true, focusOnOutcome: true }),
		);

		expect(deps.loadDetail).not.toHaveBeenCalled();
		expect(deps.refreshCandidate).toHaveBeenCalledExactlyOnceWith("candidate");
		expect(outcome).toMatchObject({ status: "success", view: staleView });
	});
});

describe("initial Team setup automatic refresh failures", () => {
	it("preserves an automatic refresh failure", async () => {
		const cause = new Error("refresh unavailable");
		const deps = dependencies({
			loadDetail: vi.fn().mockResolvedValue(staleView),
			refreshCandidate: vi.fn().mockRejectedValue(cause),
		});

		const outcome = await createSetupEffectRunner(deps)(
			effect({ kind: "load", refresh: false, focusOnOutcome: true }),
		);

		expect(deps.loadDetail).toHaveBeenCalledOnce();
		expect(deps.refreshCandidate).toHaveBeenCalledOnce();
		expect(outcome).toMatchObject({ status: "failure", cause });
	});

	it("does not turn a stale refresh failure into success or a second POST", async () => {
		const cause = new LegacyTeamSetupApiError(409, "team_setup_confirmation_stale");
		const deps = dependencies({
			loadDetail: vi.fn().mockResolvedValueOnce(staleView).mockResolvedValue(view),
			refreshCandidate: vi.fn().mockRejectedValue(cause),
		});

		const outcome = await createSetupEffectRunner(deps)(
			effect({ kind: "load", refresh: false, focusOnOutcome: true }),
		);

		expect(deps.refreshCandidate).toHaveBeenCalledOnce();
		expect(deps.loadDetail).toHaveBeenCalledTimes(2);
		expect(outcome).toMatchObject({ status: "failure", cause, recoveredView: view });
		expect(deps.saveAssignment).not.toHaveBeenCalled();
		expect(deps.saveDecision).not.toHaveBeenCalled();
		expect(deps.finish).not.toHaveBeenCalled();
	});

	it("does not refresh after a rejected detail request", async () => {
		const cause = new LegacyTeamSetupApiError(503, "team_setup_completion_unavailable");
		const deps = dependencies({ loadDetail: vi.fn().mockRejectedValue(cause) });

		const outcome = await createSetupEffectRunner(deps)(
			effect({ kind: "load", refresh: false, focusOnOutcome: true }),
		);

		expect(deps.loadDetail).toHaveBeenCalledOnce();
		expect(deps.refreshCandidate).not.toHaveBeenCalled();
		expect(outcome).toMatchObject({ status: "failure", cause });
	});
});
