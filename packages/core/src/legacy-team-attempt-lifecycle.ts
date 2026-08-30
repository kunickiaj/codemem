export type LegacyTeamAttemptState = "needs_setup" | "in_progress" | "stale" | "completed";

export type LegacyTeamAttemptPlan =
	| { kind: "create" }
	| { kind: "replace" }
	| { kind: "reuse" }
	| { kind: "preserve_completion" };

export function planLegacyTeamAttempt(input: {
	state: LegacyTeamAttemptState | null;
	evidenceMatches: boolean;
	completionReady: boolean;
}): LegacyTeamAttemptPlan {
	if (input.state == null) return { kind: "create" };
	switch (input.state) {
		case "completed":
			return input.completionReady ? { kind: "preserve_completion" } : { kind: "replace" };
		case "stale":
			return { kind: "replace" };
		case "needs_setup":
		case "in_progress":
			return input.evidenceMatches ? { kind: "reuse" } : { kind: "replace" };
		default: {
			const exhaustive: never = input.state;
			throw new Error(`unknown legacy Team attempt state: ${exhaustive}`);
		}
	}
}
