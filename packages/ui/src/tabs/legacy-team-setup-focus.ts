export interface SetupFocusPlan {
	id: number;
	targetId: string;
}

export function planStepFocus(id: number, step: string): SetupFocusPlan {
	return { id, targetId: `legacy-team-setup-step-${step}` };
}

export function planBlockedFocus(
	id: number,
	step: "devices" | "projects",
	unresolvedIndex: number,
): SetupFocusPlan {
	const row = step === "devices" ? "legacy-team-device-row" : "legacy-team-project-row";
	return planTargetFocus(
		id,
		unresolvedIndex >= 0 ? `${row}-${unresolvedIndex}` : `legacy-team-setup-step-${step}`,
	);
}

export function planLoadFocus(
	id: number,
	input: { hasError: boolean; recovery?: boolean; step: string },
): SetupFocusPlan {
	return planTargetFocus(
		id,
		input.recovery
			? "legacy-team-setup-refresh"
			: input.hasError
				? "legacy-team-setup-retry"
				: `legacy-team-setup-step-${input.step}`,
	);
}

function planTargetFocus(id: number, targetId: string): SetupFocusPlan {
	return { id, targetId };
}
