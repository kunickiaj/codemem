import type * as api from "../lib/api";
import {
	LegacyTeamSetupApiError,
	type LegacyTeamSetupErrorCode,
	type LegacyTeamSetupViewV1,
} from "../lib/api";

export interface SetupEffectDependencies {
	clearDecision: typeof api.clearLegacyTeamSetupDecision;
	finish: typeof api.finishLegacyTeamSetup;
	loadDetail: typeof api.loadLegacyTeamSetupDetail;
	onCompleted: () => void | Promise<void>;
	refreshCandidate: typeof api.refreshLegacyTeamSetupCandidate;
	saveAssignment: typeof api.saveLegacyTeamSetupAssignment;
	saveDecision: typeof api.saveLegacyTeamSetupDecision;
	saveProjectMapping: typeof api.saveLegacyTeamSetupProjectMapping;
}

interface SetupEffectBase {
	generation: number;
	id: string;
	status: "pending" | "running";
}

export type SetupEffect =
	| (SetupEffectBase & {
			kind: "load";
			candidateRef: string;
			refresh: boolean;
			focusOnOutcome: boolean;
	  })
	| (SetupEffectBase & {
			kind: "assign_device";
			candidateRef: string;
			deviceRef: string;
			input: Parameters<typeof api.saveLegacyTeamSetupAssignment>[2];
	  })
	| (SetupEffectBase & {
			kind: "decide_device";
			candidateRef: string;
			deviceRef: string;
			input: Parameters<typeof api.saveLegacyTeamSetupDecision>[2];
	  })
	| (SetupEffectBase & {
			kind: "clear_device";
			candidateRef: string;
			deviceRef: string;
			input: Parameters<typeof api.clearLegacyTeamSetupDecision>[2];
	  })
	| (SetupEffectBase & {
			kind: "map_project";
			candidateRef: string;
			projectRef: string;
			input: Parameters<typeof api.saveLegacyTeamSetupProjectMapping>[2];
	  })
	| (SetupEffectBase & { kind: "refresh"; candidateRef: string })
	| (SetupEffectBase & {
			kind: "finish";
			candidateRef: string;
			attemptId: string;
			input: Parameters<typeof api.finishLegacyTeamSetup>[1];
	  })
	| (SetupEffectBase & {
			kind: "completion_refresh";
			candidateRef: string;
			attemptId: string;
	  });

export type SetupEffectInput = SetupEffect extends infer Effect
	? Effect extends SetupEffect
		? Omit<Effect, "generation" | "id" | "status">
		: never
	: never;

export type SetupEffectOutcome =
	| {
			status: "success";
			generation: number;
			id: string;
			kind: SetupEffect["kind"];
			view?: LegacyTeamSetupViewV1;
	  }
	| {
			status: "failure";
			generation: number;
			id: string;
			kind: SetupEffect["kind"];
			cause: unknown;
			recoveryCause?: unknown;
			recoveredView?: LegacyTeamSetupViewV1;
	  };

export type SetupEffectRunner = (effect: SetupEffect) => Promise<SetupEffectOutcome>;

export function createSetupEffectRunner(dependencies: SetupEffectDependencies): SetupEffectRunner {
	let completedRefresh: {
		attemptId: string;
		candidateRef: string;
		promise: Promise<void>;
	} | null = null;

	return async (effect) => {
		try {
			const view = await execute(
				effect,
				dependencies,
				() => completedRefresh,
				(next) => {
					completedRefresh = next;
				},
			);
			return {
				status: "success",
				generation: effect.generation,
				id: effect.id,
				kind: effect.kind,
				view,
			};
		} catch (cause) {
			let recoveredView: LegacyTeamSetupViewV1 | undefined;
			let recoveryCause: unknown;
			try {
				recoveredView = await recover(effect, dependencies, cause);
			} catch (recoveryError) {
				recoveryCause = recoveryError;
			}
			return {
				status: "failure",
				generation: effect.generation,
				id: effect.id,
				kind: effect.kind,
				cause,
				...(recoveryCause ? { recoveryCause } : {}),
				...(recoveredView ? { recoveredView } : {}),
			};
		}
	};
}

async function execute(
	effect: SetupEffect,
	dependencies: SetupEffectDependencies,
	getCompletedRefresh: () => {
		attemptId: string;
		candidateRef: string;
		promise: Promise<void>;
	} | null,
	setCompletedRefresh: (
		value: { attemptId: string; candidateRef: string; promise: Promise<void> } | null,
	) => void,
): Promise<LegacyTeamSetupViewV1 | undefined> {
	switch (effect.kind) {
		case "load":
			return effect.refresh
				? dependencies.refreshCandidate(effect.candidateRef)
				: dependencies.loadDetail(effect.candidateRef);
		case "assign_device":
			return dependencies.saveAssignment(effect.candidateRef, effect.deviceRef, effect.input);
		case "decide_device":
			return dependencies.saveDecision(effect.candidateRef, effect.deviceRef, effect.input);
		case "clear_device":
			return dependencies.clearDecision(effect.candidateRef, effect.deviceRef, effect.input);
		case "map_project":
			return dependencies.saveProjectMapping(effect.candidateRef, effect.projectRef, effect.input);
		case "refresh":
			return dependencies.refreshCandidate(effect.candidateRef);
		case "finish":
			await dependencies.finish(effect.candidateRef, effect.input);
			return undefined;
		case "completion_refresh": {
			const current = getCompletedRefresh();
			if (current?.attemptId === effect.attemptId && current.candidateRef === effect.candidateRef) {
				await current.promise;
				return undefined;
			}
			const promise = Promise.resolve().then(() => dependencies.onCompleted());
			setCompletedRefresh({
				attemptId: effect.attemptId,
				candidateRef: effect.candidateRef,
				promise,
			});
			try {
				await promise;
			} finally {
				if (getCompletedRefresh()?.promise === promise) setCompletedRefresh(null);
			}
			return undefined;
		}
		default: {
			const exhaustive: never = effect;
			throw new Error(`Unhandled Team setup effect: ${String(exhaustive)}`);
		}
	}
}

async function recover(
	effect: SetupEffect,
	dependencies: SetupEffectDependencies,
	cause: unknown,
): Promise<LegacyTeamSetupViewV1 | undefined> {
	if (effect.kind === "completion_refresh") return undefined;
	if (!(cause instanceof LegacyTeamSetupApiError) || !isChangedStateCode(cause.errorCode)) {
		return undefined;
	}
	if (
		effect.kind === "load" &&
		(effect.refresh || cause.errorCode !== "team_setup_confirmation_stale")
	) {
		return undefined;
	}
	return dependencies.loadDetail(effect.candidateRef);
}

export function isChangedStateCode(code: LegacyTeamSetupErrorCode): boolean {
	return [
		"team_setup_roster_changed",
		"team_setup_assignment_changed",
		"team_setup_conflict",
		"team_setup_confirmation_stale",
	].includes(code);
}
