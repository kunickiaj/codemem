import { render } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { RadixDialogProps } from "../components/primitives/radix-dialog";
import * as api from "../lib/api";
import { LegacyTeamSetupDialogView } from "./legacy-team-setup-dialog-view";
import { createSetupEffectRunner, type SetupEffectDependencies } from "./legacy-team-setup-effects";
import {
	createSetupSessionState,
	hasBlockingOperation,
	type InteractiveTeamSetupStep,
	reduceSetupSession,
	type SetupSessionEvent,
} from "./legacy-team-setup-session";

export type LegacyTeamSetupDialogDependencies = SetupEffectDependencies;

const defaultDependencies: LegacyTeamSetupDialogDependencies = {
	clearDecision: api.clearLegacyTeamSetupDecision,
	finish: api.finishLegacyTeamSetup,
	loadDetail: api.loadLegacyTeamSetupDetail,
	onCompleted: () => {},
	refreshCandidate: api.refreshLegacyTeamSetupCandidate,
	saveAssignment: api.saveLegacyTeamSetupAssignment,
	saveDecision: api.saveLegacyTeamSetupDecision,
	saveProjectMapping: api.saveLegacyTeamSetupProjectMapping,
};

const OPEN_TEAM_SETUP_EVENT = "codemem:open-legacy-team-setup";

interface OpenTeamSetupEventDetail {
	candidateRef: string;
	handled: boolean;
	returnFocus: HTMLElement | null;
}

export function openLegacyTeamSetup(candidateRef: string): boolean {
	if (!candidateRef) return false;
	const detail: OpenTeamSetupEventDetail = {
		candidateRef,
		handled: false,
		returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
	};
	window.dispatchEvent(
		new CustomEvent<OpenTeamSetupEventDetail>(OPEN_TEAM_SETUP_EVENT, { detail }),
	);
	return detail.handled;
}

function canRestoreFocus(element: HTMLElement | null): element is HTMLElement {
	if (
		!element?.isConnected ||
		element.tabIndex < 0 ||
		element.matches(":disabled") ||
		element.closest('[hidden], [inert], [aria-hidden="true"]')
	) {
		return false;
	}
	for (let current: HTMLElement | null = element; current; current = current.parentElement) {
		const style = window.getComputedStyle(current);
		if (
			style.display === "none" ||
			style.visibility === "hidden" ||
			style.visibility === "collapse"
		) {
			return false;
		}
	}
	return true;
}

function LegacyTeamSetupDialogHost({
	dependencies,
}: {
	dependencies: LegacyTeamSetupDialogDependencies;
}) {
	const [session, setSession] = useState(createSetupSessionState);
	const returnFocus = useRef<HTMLElement | null>(null);
	const runner = useMemo(() => createSetupEffectRunner(dependencies), [dependencies]);
	const dispatch = (event: SetupSessionEvent) => {
		setSession((current) => reduceSetupSession(current, event));
	};

	useLayoutEffect(() => {
		const onOpen = (event: Event) => {
			const request = event as CustomEvent<OpenTeamSetupEventDetail>;
			request.detail.handled = true;
			returnFocus.current = request.detail.returnFocus;
			setSession((current) => {
				if (current.status === "open" && hasBlockingOperation(current)) {
					return reduceSetupSession(current, {
						type: "open_blocked",
						message:
							"Wait for the current Team setup change to finish before opening another Team.",
					});
				}
				return reduceSetupSession(current, {
					type: "open",
					candidateRef: request.detail.candidateRef,
				});
			});
		};
		window.addEventListener(OPEN_TEAM_SETUP_EVENT, onOpen);
		return () => {
			window.removeEventListener(OPEN_TEAM_SETUP_EVENT, onOpen);
		};
	}, []);

	useEffect(() => {
		if (session.status !== "open") return;
		for (const command of session.commands.filter((item) => item.status === "pending")) {
			dispatch({ type: "command_started", id: command.id });
			void runner(command).then((outcome) => dispatch({ type: "effect_outcome", outcome }));
		}
	}, [runner, session]);

	useEffect(() => {
		if (session.status !== "open" || !session.focus) return;
		const target =
			document.getElementById(session.focus.targetId) ??
			document.getElementById("legacy-team-setup-title");
		if (!target) return;
		target.focus();
		dispatch({ type: "focus_applied", id: session.focus.id });
	}, [session]);

	if (session.status === "closed") return null;
	const close = () => {
		if (hasBlockingOperation(session)) {
			dispatch({
				type: "close_blocked",
				message:
					"Team setup will stay open while this change saves. Close it after saving finishes.",
			});
			return;
		}
		dispatch({ type: "close" });
	};
	const navigate = (step: InteractiveTeamSetupStep) => dispatch({ type: "navigate", step });

	return (
		<LegacyTeamSetupDialogView
			session={session}
			onAssign={(device, targetIdentityRef) =>
				dispatch({ type: "assign_device", deviceRef: device.deviceRef, targetIdentityRef })
			}
			onClear={(device) => dispatch({ type: "clear_device", deviceRef: device.deviceRef })}
			onClose={close}
			onCloseAutoFocus={(event) => restoreFocus(event, returnFocus)}
			onDecide={(device, decision, targetIdentityRef) => {
				if (decision === "included" && !targetIdentityRef) {
					dispatch({
						type: "open_blocked",
						message: `Save a person assignment before including ${device.displayName}.`,
					});
					return;
				}
				dispatch({
					type: "decide_device",
					deviceRef: device.deviceRef,
					decision,
					...(targetIdentityRef ? { targetIdentityRef } : {}),
				});
			}}
			onFinish={() => dispatch({ type: "finish" })}
			onMap={(project, resolvedProjectRef) =>
				dispatch({ type: "map_project", projectRef: project.projectRef, resolvedProjectRef })
			}
			onNavigate={navigate}
			onOpenAutoFocus={focusTitle}
			onRefresh={() => dispatch({ type: "refresh" })}
			onRetry={() => dispatch({ type: "retry" })}
		/>
	);
}

const focusTitle: NonNullable<RadixDialogProps["onOpenAutoFocus"]> = (event) => {
	const heading = document.getElementById("legacy-team-setup-title");
	if (!heading) return;
	event.preventDefault();
	heading.focus();
};

function restoreFocus(
	event: Parameters<NonNullable<RadixDialogProps["onCloseAutoFocus"]>>[0],
	returnFocus: { current: HTMLElement | null },
): void {
	event.preventDefault();
	const activeTab = document.querySelector<HTMLElement>('.tab-btn[aria-current="page"]');
	const target = canRestoreFocus(returnFocus.current) ? returnFocus.current : activeTab;
	target?.focus();
	returnFocus.current = null;
}

export function mountLegacyTeamSetupDialog(
	mount: HTMLElement,
	overrides: Partial<LegacyTeamSetupDialogDependencies> = {},
): void {
	const dependencies = { ...defaultDependencies, ...overrides };
	render(<LegacyTeamSetupDialogHost dependencies={dependencies} />, mount);
}
