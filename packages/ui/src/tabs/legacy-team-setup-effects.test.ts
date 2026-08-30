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
