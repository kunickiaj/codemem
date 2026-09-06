import {
	LegacyTeamSetupApiError,
	type LegacyTeamSetupErrorCode,
	type LegacyTeamSetupViewV1,
} from "../lib/api";
import type {
	SetupEffect,
	SetupEffectInput,
	SetupEffectOutcome,
} from "./legacy-team-setup-effects";
import { isChangedStateCode } from "./legacy-team-setup-effects";
import {
	planBlockedFocus,
	planLoadFocus,
	planStepFocus,
	type SetupFocusPlan,
} from "./legacy-team-setup-focus";
import { orderedSetupDevices, orderedSetupProjects } from "./legacy-team-setup-order";

export type TeamSetupStep = "devices" | "projects" | "review" | "completed";
export type InteractiveTeamSetupStep = Exclude<TeamSetupStep, "completed">;
export type SetupErrorScope =
	| { kind: "load" }
	| { kind: "global" }
	| { kind: "device"; itemRef: string }
	| { kind: "project"; itemRef: string };

export interface SetupSessionError {
	message: string;
	retry: "load" | "refresh" | null;
	scope: SetupErrorScope;
}

interface ClosedSetupSessionState {
	status: "closed";
	generation: number;
}

export interface OpenSetupSessionState {
	status: "open";
	generation: number;
	candidateRef: string;
	view: LegacyTeamSetupViewV1 | null;
	step: TeamSetupStep;
	projectsVisitedAttemptId: string | null;
	commands: SetupEffect[];
	nextCommandId: number;
	errors: SetupSessionError[];
	message: string;
	focus: SetupFocusPlan | null;
	nextFocusId: number;
}

export type SetupSessionState = ClosedSetupSessionState | OpenSetupSessionState;

export type SetupSessionEvent =
	| { type: "open"; candidateRef: string }
	| { type: "close" }
	| { type: "close_blocked"; message: string }
	| { type: "open_blocked"; message: string }
	| { type: "navigate"; step: InteractiveTeamSetupStep }
	| { type: "blocked_navigation"; step: "devices" | "projects"; message: string }
	| { type: "retry" }
	| { type: "refresh" }
	| { type: "assign_device"; deviceRef: string; targetIdentityRef: string }
	| {
			type: "decide_device";
			deviceRef: string;
			decision: "included" | "excluded" | "removed";
			targetIdentityRef?: string;
	  }
	| { type: "clear_device"; deviceRef: string }
	| { type: "map_project"; projectRef: string; resolvedProjectRef: string }
	| { type: "finish" }
	| { type: "command_started"; id: string }
	| { type: "effect_outcome"; outcome: SetupEffectOutcome }
	| { type: "focus_applied"; id: number };

const CHANGED_STATE_ERROR =
	"Team setup changed since it was last reviewed. Reload the latest details to continue.";
const ROSTER_UNAVAILABLE_ERROR =
	"Team device details are temporarily unavailable. Check the coordinator connection and settings, then refresh.";
const ROSTER_UNAVAILABLE_AFTER_FINISH_ERROR =
	"Team device details were unavailable, so setup was not finished and no changes were applied. Check the coordinator connection and settings, then refresh.";
const COMPLETION_UNAVAILABLE_ERROR =
	"Team setup completion could not be checked. Check the coordinator connection and settings, then retry.";
const COMPLETION_UNAVAILABLE_AFTER_FINISH_ERROR =
	"Team setup could not be confirmed, and no local changes were applied. Retry to check whether setup completed.";
const COMPLETION_CONFLICT_ERROR =
	"Another device completed this Team with different reviewed details. Retry to load the completed setup.";
const COMPLETION_INVALID_ERROR =
	"The completed Team setup could not be verified. Retry, then check the coordinator connection and settings if the problem continues.";

export function createSetupSessionState(): SetupSessionState {
	return { status: "closed", generation: 0 };
}

export function reduceSetupSession(
	state: SetupSessionState,
	event: SetupSessionEvent,
): SetupSessionState {
	switch (event.type) {
		case "open":
			if (state.status === "open" && hasBlockingOperation(state)) return state;
			return open(state.generation + 1, event.candidateRef);
		case "close":
			if (state.status === "open" && hasBlockingOperation(state)) return state;
			return { status: "closed", generation: state.generation + 1 };
		case "close_blocked":
		case "open_blocked":
			return state.status === "open" ? { ...state, message: event.message } : state;
		case "navigate":
			return navigate(state, event.step);
		case "blocked_navigation":
			return blockedNavigation(state, event.step, event.message);
		case "retry":
			return retry(state);
		case "refresh":
			return enqueueGlobal(state, "refresh", "Refreshing Team setup from the latest server state.");
		case "assign_device":
			return enqueueDevice(state, event, "assign_device");
		case "decide_device":
			return enqueueDevice(state, event, "decide_device");
		case "clear_device":
			return enqueueDevice(state, event, "clear_device");
		case "map_project":
			return enqueueProject(state, event);
		case "finish":
			return enqueueFinish(state);
		case "command_started":
			return mapCommand(state, event.id, (command) => ({ ...command, status: "running" }));
		case "effect_outcome":
			return outcome(state, event.outcome);
		case "focus_applied":
			return state.status === "open" && state.focus?.id === event.id
				? { ...state, focus: null }
				: state;
		default: {
			const exhaustive: never = event;
			return exhaustive;
		}
	}
}

function open(generation: number, candidateRef: string): OpenSetupSessionState {
	const state: OpenSetupSessionState = {
		status: "open",
		generation,
		candidateRef,
		view: null,
		step: "devices",
		projectsVisitedAttemptId: null,
		commands: [],
		nextCommandId: 1,
		errors: [],
		message: "",
		focus: null,
		nextFocusId: 1,
	};
	return append(state, {
		kind: "load",
		candidateRef,
		refresh: false,
		focusOnOutcome: false,
	});
}

function navigate(state: SetupSessionState, step: TeamSetupStep): SetupSessionState {
	if (state.status !== "open" || state.step === "completed" || step === "completed") return state;
	if (step === "projects" && state.view?.unresolvedDeviceCount) {
		return blockedNavigation(
			state,
			"devices",
			"Finish the device decisions before mapping Projects.",
		);
	}
	if (step === "review" && state.view?.unresolvedDeviceCount) {
		return blockedNavigation(
			state,
			"devices",
			"Finish the device decisions before reviewing access.",
		);
	}
	if (step === "review" && state.view?.unresolvedProjectCount) {
		return blockedNavigation(
			state,
			"projects",
			"Finish the Project mappings before reviewing access.",
		);
	}
	const projectsVisitedAttemptId =
		step === "projects" && state.view ? state.view.attemptId : state.projectsVisitedAttemptId;
	return {
		...state,
		step,
		projectsVisitedAttemptId,
		focus: planStepFocus(state.nextFocusId, step),
		nextFocusId: state.nextFocusId + 1,
	};
}

function blockedNavigation(
	state: SetupSessionState,
	step: "devices" | "projects",
	message: string,
): SetupSessionState {
	if (state.status !== "open" || state.step === "completed" || !state.view) return state;
	const unresolvedIndex =
		step === "devices"
			? orderedSetupDevices(state.view.devices).findIndex(
					(device) => device.decision === "unresolved",
				)
			: orderedSetupProjects(state.view.projects).findIndex(
					(project) => project.resolution === "unresolved",
				);
	return {
		...state,
		step,
		projectsVisitedAttemptId:
			step === "projects" ? state.view.attemptId : state.projectsVisitedAttemptId,
		message,
		focus: planBlockedFocus(state.nextFocusId, step, unresolvedIndex),
		nextFocusId: state.nextFocusId + 1,
	};
}

function retry(state: SetupSessionState): SetupSessionState {
	if (
		state.status !== "open" ||
		state.step === "completed" ||
		hasGlobalOperation(state) ||
		hasBlockingOperation(state)
	)
		return state;
	const retryMode =
		globalError(state)?.retry ?? state.errors.find((error) => error.retry)?.retry ?? "load";
	return append(state, {
		kind: "load",
		candidateRef: state.candidateRef,
		refresh: retryMode === "refresh",
		focusOnOutcome: true,
	});
}

function enqueueDevice(
	state: SetupSessionState,
	event: Extract<SetupSessionEvent, { type: "assign_device" | "decide_device" | "clear_device" }>,
	kind: "assign_device" | "decide_device" | "clear_device",
): SetupSessionState {
	if (
		state.status !== "open" ||
		state.step === "completed" ||
		!isEditable(state.view) ||
		globalError(state) ||
		hasGlobalOperation(state) ||
		hasBlockingOperation(state)
	) {
		return state;
	}
	const device = state.view.devices.find((item) => item.deviceRef === event.deviceRef);
	if (!device) return state;
	const action =
		event.type === "assign_device"
			? device.actions.assignIdentity
			: event.type === "clear_device"
				? device.actions.clearDecision
				: event.decision === "included"
					? device.actions.include
					: event.decision === "excluded"
						? device.actions.exclude
						: device.actions.remove;
	if (!action.enabled) return state;
	const base = { candidateRef: state.candidateRef, deviceRef: event.deviceRef };
	const command =
		kind === "assign_device" && event.type === "assign_device"
			? {
					kind,
					...base,
					input: {
						attemptId: state.view.attemptId,
						targetIdentityRef: event.targetIdentityRef,
						expectation: device.expectation,
					},
				}
			: kind === "clear_device" && event.type === "clear_device"
				? { kind, ...base, input: { attemptId: state.view.attemptId } }
				: event.type === "decide_device"
					? {
							kind: "decide_device" as const,
							...base,
							input:
								event.decision === "included" && event.targetIdentityRef
									? {
											attemptId: state.view.attemptId,
											decision: "included" as const,
											expectedTargetIdentityRef: event.targetIdentityRef,
										}
									: {
											attemptId: state.view.attemptId,
											decision: event.decision as "excluded" | "removed",
										},
						}
					: null;
	if (!command) return state;
	if (event.type === "decide_device" && event.decision === "included" && !event.targetIdentityRef) {
		return state;
	}
	const pendingMessage =
		event.type === "assign_device"
			? `Saving the assignment for ${device.displayName}.`
			: event.type === "clear_device"
				? `Clearing the decision for ${device.displayName}.`
				: `Saving the decision for ${device.displayName}.`;
	return append(
		clearScope(state, { kind: "device", itemRef: event.deviceRef }),
		command,
		pendingMessage,
	);
}

function enqueueProject(
	state: SetupSessionState,
	event: Extract<SetupSessionEvent, { type: "map_project" }>,
): SetupSessionState {
	if (
		state.status !== "open" ||
		state.step === "completed" ||
		!isEditable(state.view) ||
		globalError(state) ||
		hasGlobalOperation(state) ||
		hasBlockingOperation(state)
	) {
		return state;
	}
	const project = state.view.projects.find((item) => item.projectRef === event.projectRef);
	if (
		!project?.actions.map.enabled ||
		!project.mappingChoices.some((choice) => choice.resolvedProjectRef === event.resolvedProjectRef)
	) {
		return state;
	}
	return append(
		clearScope(state, { kind: "project", itemRef: event.projectRef }),
		{
			kind: "map_project",
			candidateRef: state.candidateRef,
			projectRef: event.projectRef,
			input: {
				attemptId: state.view.attemptId,
				resolvedProjectRef: event.resolvedProjectRef,
			},
		},
		`Saving the mapping for ${project.displayName}.`,
	);
}

function enqueueGlobal(
	state: SetupSessionState,
	kind: "refresh",
	message: string,
): SetupSessionState {
	if (
		state.status !== "open" ||
		state.step === "completed" ||
		!state.view?.actions.refresh.enabled ||
		hasGlobalOperation(state) ||
		hasBlockingOperation(state)
	) {
		return state;
	}
	return append(
		clearScope(state, { kind: "global" }),
		{
			kind,
			candidateRef: state.candidateRef,
		},
		message,
	);
}

function enqueueFinish(state: SetupSessionState): SetupSessionState {
	if (
		state.status !== "open" ||
		state.step === "completed" ||
		state.view?.state !== "ready_to_finish" ||
		state.commands.length ||
		state.errors.length > 0
	) {
		return state;
	}
	return append(
		clearScope(state, { kind: "global" }),
		{
			kind: "finish",
			candidateRef: state.candidateRef,
			attemptId: state.view.attemptId,
			input: {
				attemptId: state.view.attemptId,
				finishDigest: state.view.finishDigest,
				confirmedAccessDeltaDigest: state.view.accessDeltaDigest,
				confirmedViewerAccessDeltaDigest: state.view.viewerAccessDeltaDigest,
			},
		},
		"Finishing Team setup.",
	);
}

function append(
	state: OpenSetupSessionState,
	command: SetupEffectInput,
	message = state.message,
): OpenSetupSessionState {
	const id = `${state.generation}:${state.nextCommandId}`;
	return {
		...state,
		commands: [
			...state.commands,
			{ ...command, generation: state.generation, id, status: "pending" } as SetupEffect,
		],
		nextCommandId: state.nextCommandId + 1,
		message,
	};
}

function outcome(state: SetupSessionState, result: SetupEffectOutcome): SetupSessionState {
	if (state.status !== "open" || state.generation !== result.generation) return state;
	const command = state.commands.find((item) => item.id === result.id);
	if (!command) return state;
	const withoutCommand = {
		...state,
		commands: state.commands.filter((item) => item.id !== result.id),
	};
	if (result.status === "failure") return failed(withoutCommand, command, result);
	if (command.kind === "completion_refresh") {
		return {
			...withoutCommand,
			message: "Team setup complete. Sharing and Projects are up to date.",
		};
	}
	if (command.kind === "finish") return completed(withoutCommand, command.attemptId);
	if (!result.view) return withoutCommand;
	const cleared = clearCommandError(withoutCommand, command);
	return applyView(
		{ ...cleared, message: successMessage(command, state.view) },
		result.view,
		command.kind === "load" && command.focusOnOutcome,
	);
}

function successMessage(command: SetupEffect, view: LegacyTeamSetupViewV1 | null): string {
	if (command.kind === "refresh") return "Team setup refreshed.";
	if (command.kind === "load") return "";
	if ("deviceRef" in command) {
		const name = view?.devices.find(
			(device) => device.deviceRef === command.deviceRef,
		)?.displayName;
		return name ? `${name} saved.` : "Device saved.";
	}
	if ("projectRef" in command) {
		const name = view?.projects.find(
			(project) => project.projectRef === command.projectRef,
		)?.displayName;
		return name ? `${name} saved.` : "Project mapping saved.";
	}
	return "";
}

function failed(
	state: OpenSetupSessionState,
	command: SetupEffect,
	result: Extract<SetupEffectOutcome, { status: "failure" }>,
): OpenSetupSessionState {
	if (command.kind === "completion_refresh") {
		return {
			...state,
			message:
				"Team setup complete. Sharing or Projects could not be refreshed; use that view's Refresh control.",
		};
	}
	const recovered = result.recoveredView ? applyView(state, result.recoveredView, false) : state;
	if (result.recoveredView?.state === "completed") return recovered;
	const error = errorFor(command, result.cause, result.recoveryCause);
	const next = {
		...recovered,
		errors: [...clearScope(recovered, error.scope).errors, error],
		message: "",
	};
	if (command.kind !== "load" || !command.focusOnOutcome) return next;
	return {
		...next,
		focus: planLoadFocus(next.nextFocusId, {
			hasError: true,
			recovery: next.view?.state === "unavailable",
			step: next.step,
		}),
		nextFocusId: next.nextFocusId + 1,
	};
}

function applyView(
	state: OpenSetupSessionState,
	view: LegacyTeamSetupViewV1,
	focusOnOutcome: boolean,
): OpenSetupSessionState {
	const step = initialStep(view, state.projectsVisitedAttemptId === view.attemptId);
	const projectsVisitedAttemptId =
		step === "projects" ? view.attemptId : state.projectsVisitedAttemptId;
	const unavailableError: SetupSessionError[] =
		view.state === "unavailable"
			? [
					{
						scope: { kind: "global" } as const,
						message: unavailableMessage(view.unavailableReason),
						retry: "refresh" as const,
					},
				]
			: view.state === "completed"
				? []
				: state.errors.filter((error) => {
						if (error.scope.kind === "device") {
							const itemRef = error.scope.itemRef;
							return view.devices.some((device) => device.deviceRef === itemRef);
						}
						if (error.scope.kind === "project") {
							const itemRef = error.scope.itemRef;
							return view.projects.some((project) => project.projectRef === itemRef);
						}
						return false;
					});
	let next: OpenSetupSessionState = {
		...state,
		view,
		step,
		projectsVisitedAttemptId,
		errors: unavailableError,
		message:
			view.state === "completed"
				? "Team setup complete. Sharing and Projects are refreshing."
				: state.message,
	};
	const hasGlobalRetryTarget = unavailableError.some(
		(error) => error.scope.kind === "global" || error.scope.kind === "load",
	);
	if (focusOnOutcome || step !== state.step) {
		next = {
			...next,
			focus: planLoadFocus(next.nextFocusId, {
				hasError: hasGlobalRetryTarget,
				recovery: view.state === "unavailable",
				step,
			}),
			nextFocusId: next.nextFocusId + 1,
		};
	}
	if (view.state === "completed" && !hasCompletionRefresh(next, view.attemptId)) {
		next = append(next, {
			kind: "completion_refresh",
			candidateRef: next.candidateRef,
			attemptId: view.attemptId,
		});
	}
	return next;
}

function completed(state: OpenSetupSessionState, attemptId: string): OpenSetupSessionState {
	let next: OpenSetupSessionState = {
		...state,
		step: "completed" as const,
		message: "Team setup complete. Sharing and Projects are refreshing.",
		focus: planStepFocus(state.nextFocusId, "completed"),
		nextFocusId: state.nextFocusId + 1,
	};
	if (!hasCompletionRefresh(next, attemptId)) {
		next = append(next, {
			kind: "completion_refresh",
			candidateRef: next.candidateRef,
			attemptId,
		});
	}
	return next;
}

function errorFor(
	command: SetupEffect,
	cause: unknown,
	recoveryCause?: unknown,
): SetupSessionError {
	const changed = cause instanceof LegacyTeamSetupApiError && isChangedStateCode(cause.errorCode);
	const rosterUnavailable =
		cause instanceof LegacyTeamSetupApiError && cause.errorCode === "team_setup_roster_unavailable";
	const { completionCode, message, terminalRecoveryCode } = completionOrChangedMessage({
		command,
		cause,
		recoveryCause,
		changed,
		rosterUnavailable,
	});
	const globalError = changed || rosterUnavailable || completionCode !== null;
	return {
		scope: errorScopeFor(command, { globalError }),
		message,
		retry: retryFor(command, cause, recoveryCause, {
			changed,
			rosterUnavailable,
			terminalRecovery: terminalRecoveryCode !== null,
		}),
	};
}

function errorScopeFor(command: SetupEffect, options: { globalError: boolean }): SetupErrorScope {
	if (options.globalError) return { kind: "global" };
	if (
		command.kind === "assign_device" ||
		command.kind === "decide_device" ||
		command.kind === "clear_device"
	) {
		return { kind: "device", itemRef: command.deviceRef };
	}
	if (command.kind === "map_project") return { kind: "project", itemRef: command.projectRef };
	return command.kind === "load" ? { kind: "load" } : { kind: "global" };
}

function retryFor(
	command: SetupEffect,
	cause: unknown,
	recoveryCause: unknown,
	options: { changed: boolean; rosterUnavailable: boolean; terminalRecovery: boolean },
): SetupSessionError["retry"] {
	const confirmationStale =
		(cause instanceof LegacyTeamSetupApiError &&
			cause.errorCode === "team_setup_confirmation_stale") ||
		(recoveryCause instanceof LegacyTeamSetupApiError &&
			recoveryCause.errorCode === "team_setup_confirmation_stale");
	if (confirmationStale || options.terminalRecovery) return "load";
	if (options.changed || options.rosterUnavailable) return "refresh";
	if (command.kind === "refresh") return "refresh";
	if (command.kind === "load" && command.refresh) return "refresh";
	return "load";
}

function completionOrChangedMessage(options: {
	command: SetupEffect;
	cause: unknown;
	recoveryCause?: unknown;
	changed: boolean;
	rosterUnavailable: boolean;
}) {
	const { command, cause, recoveryCause, changed, rosterUnavailable } = options;
	const causeCompletionCode =
		cause instanceof LegacyTeamSetupApiError ? completionErrorCode(cause.errorCode) : null;
	const recoveryCompletionCode =
		recoveryCause instanceof LegacyTeamSetupApiError
			? completionErrorCode(recoveryCause.errorCode)
			: null;
	const terminalRecoveryCode = terminalCompletionCode(recoveryCompletionCode);
	const completionCode = terminalRecoveryCode ?? causeCompletionCode;
	const completionError =
		completionCode === "team_setup_completion_unavailable" && command.kind === "finish"
			? COMPLETION_UNAVAILABLE_AFTER_FINISH_ERROR
			: completionMessage(completionCode);
	if (terminalRecoveryCode) {
		return {
			completionCode,
			message: completionError ?? safeError(command.kind),
			terminalRecoveryCode,
		};
	}
	if (changed) return { completionCode, message: CHANGED_STATE_ERROR, terminalRecoveryCode };
	if (rosterUnavailable) {
		const message =
			command.kind === "finish" ? ROSTER_UNAVAILABLE_AFTER_FINISH_ERROR : ROSTER_UNAVAILABLE_ERROR;
		return { completionCode, message, terminalRecoveryCode };
	}
	return {
		completionCode,
		message: completionError ?? safeError(command.kind),
		terminalRecoveryCode,
	};
}

function terminalCompletionCode(
	code: ReturnType<typeof completionErrorCode>,
): "team_setup_completion_conflict" | "team_setup_completion_invalid" | null {
	if (code === "team_setup_completion_conflict" || code === "team_setup_completion_invalid")
		return code;
	return null;
}

function safeError(kind: SetupEffect["kind"]): string {
	switch (kind) {
		case "load":
			return "Team setup details are temporarily unavailable. Retry to load the latest details.";
		case "assign_device":
		case "decide_device":
		case "clear_device":
			return "This device change could not be saved. Reload the latest details before trying again.";
		case "map_project":
			return "This Project mapping could not be saved. Reload the latest details before trying again.";
		case "refresh":
			return "Team setup could not be refreshed. Retry to load the latest server details.";
		case "finish":
			return "Team setup could not be finished. Reload the latest details before trying again.";
		case "completion_refresh":
			return "Team setup completed, but dependent views could not be refreshed.";
		default: {
			const exhaustive: never = kind;
			return exhaustive;
		}
	}
}

function initialStep(view: LegacyTeamSetupViewV1, projectsVisited: boolean): TeamSetupStep {
	if (view.state === "completed") return "completed";
	if (view.unresolvedDeviceCount > 0) return "devices";
	if (!projectsVisited && view.projects.length > 0) return "projects";
	if (view.unresolvedProjectCount > 0) return "projects";
	return "review";
}

export function isEditable(
	view: LegacyTeamSetupViewV1 | null,
): view is Extract<LegacyTeamSetupViewV1, { state: "reviewing" | "ready_to_finish" }> {
	return view?.state === "reviewing" || view?.state === "ready_to_finish";
}

export function isItemBusy(state: OpenSetupSessionState, itemRef: string): boolean {
	return state.commands.some(
		(command) =>
			("deviceRef" in command && command.deviceRef === itemRef) ||
			("projectRef" in command && command.projectRef === itemRef),
	);
}

export function hasBlockingOperation(state: OpenSetupSessionState): boolean {
	return state.commands.some(
		(command) =>
			(command.kind === "load" && command.refresh) ||
			[
				"refresh",
				"assign_device",
				"decide_device",
				"clear_device",
				"map_project",
				"finish",
			].includes(command.kind),
	);
}

export function hasGlobalOperation(state: OpenSetupSessionState): boolean {
	return state.commands.some((command) => ["load", "refresh", "finish"].includes(command.kind));
}

export function errorForItem(
	state: OpenSetupSessionState,
	kind: "device" | "project",
	itemRef: string,
): SetupSessionError | null {
	return (
		state.errors.find(
			(error) =>
				error.scope.kind === kind && "itemRef" in error.scope && error.scope.itemRef === itemRef,
		) ?? null
	);
}

export function globalError(state: OpenSetupSessionState): SetupSessionError | null {
	return (
		state.errors.find((error) => error.scope.kind === "global" || error.scope.kind === "load") ??
		null
	);
}

function unavailableMessage(reason: LegacyTeamSetupErrorCode): string {
	if (isChangedStateCode(reason)) return CHANGED_STATE_ERROR;
	if (reason === "team_setup_roster_unavailable") return ROSTER_UNAVAILABLE_ERROR;
	const completion = completionMessage(completionErrorCode(reason));
	if (completion) return completion;
	if (reason === "team_setup_incomplete") {
		return "Team setup needs refreshed server details before review can continue.";
	}
	return "Team setup details are temporarily unavailable. Refresh to load the latest server state.";
}

function completionErrorCode(
	reason: LegacyTeamSetupErrorCode,
):
	| "team_setup_completion_unavailable"
	| "team_setup_completion_conflict"
	| "team_setup_completion_invalid"
	| null {
	if (
		reason === "team_setup_completion_unavailable" ||
		reason === "team_setup_completion_conflict" ||
		reason === "team_setup_completion_invalid"
	) {
		return reason;
	}
	return null;
}

function completionMessage(reason: ReturnType<typeof completionErrorCode>): string | null {
	if (reason === "team_setup_completion_unavailable") return COMPLETION_UNAVAILABLE_ERROR;
	if (reason === "team_setup_completion_conflict") return COMPLETION_CONFLICT_ERROR;
	if (reason === "team_setup_completion_invalid") return COMPLETION_INVALID_ERROR;
	return null;
}

function isGlobalRecoveryScope(scope: SetupErrorScope): boolean {
	return scope.kind === "global" || scope.kind === "load";
}

function clearScope(state: OpenSetupSessionState, scope: SetupErrorScope): OpenSetupSessionState {
	// `globalError()` presents load and global errors through one slot, so
	// replacing either must clear both or the older entry keeps winning.
	const replacesGlobalRecovery = isGlobalRecoveryScope(scope);
	return {
		...state,
		errors: state.errors.filter((error) => {
			if (replacesGlobalRecovery) return !isGlobalRecoveryScope(error.scope);
			if (error.scope.kind !== scope.kind) return true;
			if (!("itemRef" in scope) || !("itemRef" in error.scope)) return false;
			return error.scope.itemRef !== scope.itemRef;
		}),
	};
}

function clearCommandError(
	state: OpenSetupSessionState,
	command: SetupEffect,
): OpenSetupSessionState {
	if (
		command.kind === "assign_device" ||
		command.kind === "decide_device" ||
		command.kind === "clear_device"
	) {
		return clearScope(state, { kind: "device", itemRef: command.deviceRef });
	}
	if (command.kind === "map_project") {
		return clearScope(state, { kind: "project", itemRef: command.projectRef });
	}
	return { ...state, errors: [] };
}

function mapCommand(
	state: SetupSessionState,
	id: string,
	map: (command: SetupEffect) => SetupEffect,
): SetupSessionState {
	return state.status === "open"
		? {
				...state,
				commands: state.commands.map((command) => (command.id === id ? map(command) : command)),
			}
		: state;
}

function hasCompletionRefresh(state: OpenSetupSessionState, attemptId: string): boolean {
	return state.commands.some(
		(command) => command.kind === "completion_refresh" && command.attemptId === attemptId,
	);
}
