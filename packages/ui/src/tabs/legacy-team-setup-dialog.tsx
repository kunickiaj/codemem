import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { DialogCloseButton } from "../components/primitives/dialog-close-button";
import { RadixDialog } from "../components/primitives/radix-dialog";
import * as api from "../lib/api";
import { LegacyTeamSetupDevices } from "./legacy-team-setup-devices";
import { LegacyTeamSetupProjects } from "./legacy-team-setup-projects";

type TeamSetupStep = "devices" | "projects" | "review" | "completed";
const CHANGED_STATE_ERROR =
	"Team setup changed since it was last reviewed. Reload the latest details to continue.";
const SAVED_RELOAD_ERROR =
	"The change was saved, but the latest Team setup details could not be loaded. Reload before continuing.";
const RELOAD_ERROR_CODES = new Set<api.LegacyTeamSetupErrorCode>([
	"team_setup_roster_changed",
	"team_setup_assignment_changed",
	"team_setup_conflict",
	"team_setup_confirmation_stale",
]);

export interface LegacyTeamSetupDialogDependencies {
	clearDecision: typeof api.clearLegacyTeamSetupDecision;
	loadDetail: typeof api.loadLegacyTeamSetupDetail;
	refreshCandidate: typeof api.refreshLegacyTeamSetupCandidate;
	saveAssignment: typeof api.saveLegacyTeamSetupAssignment;
	saveDecision: typeof api.saveLegacyTeamSetupDecision;
	saveProjectMapping: typeof api.saveLegacyTeamSetupProjectMapping;
}

const defaultDependencies: LegacyTeamSetupDialogDependencies = {
	clearDecision: api.clearLegacyTeamSetupDecision,
	loadDetail: api.loadLegacyTeamSetupDetail,
	refreshCandidate: api.refreshLegacyTeamSetupCandidate,
	saveAssignment: api.saveLegacyTeamSetupAssignment,
	saveDecision: api.saveLegacyTeamSetupDecision,
	saveProjectMapping: api.saveLegacyTeamSetupProjectMapping,
};

let pendingCandidateRef: string | null = null;
let requestOpen: ((candidateRef: string) => void) | null = null;
let returnFocus: HTMLElement | null = null;

export function openLegacyTeamSetup(candidateRef: string): boolean {
	if (!candidateRef) return false;
	returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	if (requestOpen) requestOpen(candidateRef);
	else pendingCandidateRef = candidateRef;
	return true;
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

function initialStep(detail: api.LegacyTeamSetupDetailResponseV1): TeamSetupStep {
	if (detail.draftState === "completed") return "completed";
	if (detail.unresolvedDeviceCount > 0) return "devices";
	if (detail.unresolvedProjectCount > 0) return "projects";
	return "review";
}

function detailNeedsRecovery(detail: api.LegacyTeamSetupDetailResponseV1): boolean {
	return (
		detail.draftState === "stale" ||
		(!detail.canFinish &&
			detail.conflictState !== null &&
			RELOAD_ERROR_CODES.has(detail.conflictState))
	);
}

function safeLoadError(cause: unknown): string {
	if (isChangedStateError(cause)) {
		return CHANGED_STATE_ERROR;
	}
	return "Team setup details are temporarily unavailable. Retry to load the latest details.";
}

function isChangedStateError(cause: unknown): boolean {
	return cause instanceof api.LegacyTeamSetupApiError && RELOAD_ERROR_CODES.has(cause.errorCode);
}

function safeMutationError(cause: unknown): string {
	if (isChangedStateError(cause)) {
		return CHANGED_STATE_ERROR;
	}
	if (
		cause instanceof api.LegacyTeamSetupApiError &&
		cause.errorCode === "team_setup_roster_unavailable"
	) {
		return "Team device details are temporarily unavailable. Reload the latest details before trying again.";
	}
	return "This device change could not be saved. Reload the latest details before trying again.";
}

function safeProjectMutationError(cause: unknown): string {
	if (cause instanceof api.LegacyTeamSetupApiError && RELOAD_ERROR_CODES.has(cause.errorCode)) {
		return CHANGED_STATE_ERROR;
	}
	return "This Project mapping could not be saved. Reload the latest details before trying again.";
}

function StepContent({
	detail,
	step,
}: {
	detail: api.LegacyTeamSetupDetailResponseV1;
	step: TeamSetupStep;
}) {
	if (step === "completed") {
		return (
			<section aria-labelledby="legacy-team-setup-step-completed">
				<h3 id="legacy-team-setup-step-completed" tabIndex={-1}>
					Team setup complete
				</h3>
				<p>This Team is ready for Project sharing.</p>
			</section>
		);
	}
	if (step === "devices") return null;
	if (step === "projects") return null;
	return (
		<section aria-labelledby="legacy-team-setup-step-review">
			<h3 id="legacy-team-setup-step-review" tabIndex={-1}>
				Review and finish
			</h3>
			<p>
				{detail.canFinish
					? "The server has confirmed that this Team is ready for final review."
					: "Final review is waiting for current server confirmation evidence."}
			</p>
			<p className="small">
				Next setup action: confirm the server-provided access review before finishing.
			</p>
		</section>
	);
}

function LegacyTeamSetupDialogHost({
	dependencies,
}: {
	dependencies: LegacyTeamSetupDialogDependencies;
}) {
	const [candidateRef, setCandidateRef] = useState<string | null>(null);
	const [detail, setDetail] = useState<api.LegacyTeamSetupDetailResponseV1 | null>(null);
	const [step, setStep] = useState<TeamSetupStep>("devices");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [loadRevision, setLoadRevision] = useState(0);
	const [busyDeviceRef, setBusyDeviceRef] = useState<string | null>(null);
	const [busyProjectRef, setBusyProjectRef] = useState<string | null>(null);
	const [operationStatus, setOperationStatus] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);
	const focusAfterLoad = useRef(false);
	const focusControlAfterRender = useRef<string | null>(null);
	const focusStepAfterRender = useRef(false);
	const refreshBeforeLoad = useRef(false);
	const retryNeedsRefresh = useRef(false);
	const submitting = useRef(false);

	useEffect(() => {
		requestOpen = (nextCandidateRef) => {
			refreshBeforeLoad.current = false;
			retryNeedsRefresh.current = false;
			setCandidateRef(nextCandidateRef);
			setDetail(null);
			setError(null);
			setLoadRevision((current) => current + 1);
		};
		if (pendingCandidateRef) {
			const pending = pendingCandidateRef;
			pendingCandidateRef = null;
			requestOpen(pending);
		}
		return () => {
			requestOpen = null;
		};
	}, []);

	useEffect(() => {
		if (!candidateRef) return;
		let current = true;
		const shouldRefresh = refreshBeforeLoad.current;
		refreshBeforeLoad.current = false;
		setLoading(true);
		const nextDetail = shouldRefresh
			? dependencies
					.refreshCandidate(candidateRef)
					.then(() => dependencies.loadDetail(candidateRef))
			: dependencies.loadDetail(candidateRef);
		void nextDetail.then(
			(nextDetail) => {
				if (!current) return;
				retryNeedsRefresh.current = detailNeedsRecovery(nextDetail);
				setDetail(nextDetail);
				setStep(initialStep(nextDetail));
				setError(detailNeedsRecovery(nextDetail) ? CHANGED_STATE_ERROR : null);
				setLoading(false);
			},
			(cause: unknown) => {
				if (!current) return;
				retryNeedsRefresh.current = shouldRefresh || isChangedStateError(cause);
				setError(safeLoadError(cause));
				setLoading(false);
			},
		);
		return () => {
			current = false;
		};
	}, [candidateRef, dependencies, loadRevision]);

	useEffect(() => {
		if (focusControlAfterRender.current) {
			const targetId = focusControlAfterRender.current;
			focusControlAfterRender.current = null;
			focusStepAfterRender.current = false;
			document.getElementById(targetId)?.focus();
			return;
		}
		if (!focusStepAfterRender.current) return;
		focusStepAfterRender.current = false;
		document.getElementById(`legacy-team-setup-step-${step}`)?.focus();
	}, [step]);

	useEffect(() => {
		if (loading || !focusAfterLoad.current) return;
		focusAfterLoad.current = false;
		if (error) {
			document.getElementById("legacy-team-setup-retry")?.focus();
			return;
		}
		document.getElementById(`legacy-team-setup-step-${step}`)?.focus();
	}, [error, loading, step]);

	if (!candidateRef) return null;
	const title = detail ? `Set up ${detail.candidate.displayName}` : "Set up Team";
	const close = () => {
		if (submitting.current) {
			setOperationStatus(
				"Team setup will stay open while this change saves. Close it after saving finishes.",
			);
			return;
		}
		focusAfterLoad.current = false;
		focusControlAfterRender.current = null;
		focusStepAfterRender.current = false;
		refreshBeforeLoad.current = false;
		retryNeedsRefresh.current = false;
		setCandidateRef(null);
		setDetail(null);
		setError(null);
		setLoading(false);
		setBusyDeviceRef(null);
		setBusyProjectRef(null);
		setOperationStatus("");
		setStep("devices");
	};
	const navigate = (nextStep: TeamSetupStep) => {
		if (nextStep === step) {
			document.getElementById(`legacy-team-setup-step-${nextStep}`)?.focus();
			return;
		}
		focusStepAfterRender.current = true;
		setStep(nextStep);
	};
	const explainBlockedStep = (blockedStep: "devices" | "projects", message: string) => {
		setOperationStatus(message);
		const unresolvedIndex =
			blockedStep === "devices"
				? detail?.devices.findIndex((device) => device.decision === "unresolved")
				: detail?.projects.findIndex((project) => project.resolution === "unresolved");
		const targetId =
			unresolvedIndex !== undefined && unresolvedIndex >= 0
				? blockedStep === "devices"
					? `legacy-team-device-row-${unresolvedIndex}`
					: `legacy-team-project-row-${unresolvedIndex}`
				: null;
		if (targetId && blockedStep === step) {
			document.getElementById(targetId)?.focus();
			return;
		}
		focusControlAfterRender.current = targetId;
		navigate(blockedStep);
	};
	const devicesBlockProgress = detail ? detail.unresolvedDeviceCount > 0 : false;
	const projectsBlockReview = detail ? detail.unresolvedProjectCount > 0 : false;
	const mutationsBlocked = loading || isSubmitting || Boolean(error);
	const applyAuthoritativeDetail = (
		nextDetail: api.LegacyTeamSetupDetailResponseV1,
		preserveDevicesStep: boolean,
	) => {
		retryNeedsRefresh.current = detailNeedsRecovery(nextDetail);
		setDetail(nextDetail);
		setStep((current) => {
			const nextStep =
				preserveDevicesStep && current === "devices" && nextDetail.unresolvedDeviceCount > 0
					? "devices"
					: initialStep(nextDetail);
			if (nextStep !== current) focusStepAfterRender.current = true;
			return nextStep;
		});
		setError(detailNeedsRecovery(nextDetail) ? CHANGED_STATE_ERROR : null);
	};
	const reloadAfterMutation = async () => {
		const nextDetail = await dependencies.loadDetail(candidateRef);
		applyAuthoritativeDetail(nextDetail, true);
		return nextDetail;
	};
	const recoverMutation = async (cause: unknown, getMessage = safeMutationError) => {
		const message = getMessage(cause);
		setOperationStatus("");
		setError(message);
		if (
			!(cause instanceof api.LegacyTeamSetupApiError) ||
			!RELOAD_ERROR_CODES.has(cause.errorCode)
		) {
			return;
		}
		try {
			const nextDetail = await dependencies.loadDetail(candidateRef);
			applyAuthoritativeDetail(nextDetail, true);
			retryNeedsRefresh.current = true;
		} catch {
			retryNeedsRefresh.current = true;
			// Keep the stable mutation error when the best-effort recovery reload also fails.
		}
		setError(message);
	};
	const runMutation = async (
		itemRef: string,
		status: string,
		savedStatus: string,
		setBusyRef: (value: string | null) => void,
		getError: (cause: unknown) => string,
		operation: () => Promise<unknown>,
	) => {
		if (mutationsBlocked || submitting.current) return;
		submitting.current = true;
		setIsSubmitting(true);
		setBusyRef(itemRef);
		setOperationStatus(status);
		setError(null);
		try {
			try {
				await operation();
			} catch (cause) {
				await recoverMutation(cause, getError);
				return;
			}
			try {
				await reloadAfterMutation();
				setOperationStatus(savedStatus);
			} catch {
				setOperationStatus("");
				setError(SAVED_RELOAD_ERROR);
			}
		} finally {
			submitting.current = false;
			setIsSubmitting(false);
			setBusyRef(null);
		}
	};
	const assignDevice = (device: api.LegacyTeamSetupDeviceV1, targetIdentityRef: string) => {
		const currentDetail = detail;
		if (!currentDetail) return;
		void runMutation(
			device.deviceRef,
			`Saving the assignment for ${device.displayName}.`,
			`${device.displayName} saved.`,
			setBusyDeviceRef,
			safeMutationError,
			() =>
				dependencies.saveAssignment(candidateRef, device.deviceRef, {
					attemptId: currentDetail.attemptId,
					targetIdentityRef,
					expectation: device.expectation,
				}),
		);
	};
	const decideDevice = (
		device: api.LegacyTeamSetupDeviceV1,
		decision: "included" | "excluded" | "removed",
		targetIdentityRef?: string,
	) => {
		const currentDetail = detail;
		if (!currentDetail) return;
		if (decision === "included" && !targetIdentityRef) {
			setOperationStatus(`Save a person assignment before including ${device.displayName}.`);
			return;
		}
		void runMutation(
			device.deviceRef,
			`Saving the decision for ${device.displayName}.`,
			`${device.displayName} saved.`,
			setBusyDeviceRef,
			safeMutationError,
			async () => {
				if (decision === "included" && targetIdentityRef) {
					await dependencies.saveDecision(candidateRef, device.deviceRef, {
						attemptId: currentDetail.attemptId,
						decision: "included",
						expectedTargetIdentityRef: targetIdentityRef,
					});
				} else if (decision !== "included") {
					await dependencies.saveDecision(candidateRef, device.deviceRef, {
						attemptId: currentDetail.attemptId,
						decision,
					});
				}
			},
		);
	};
	const clearDevice = (device: api.LegacyTeamSetupDeviceV1) => {
		const currentDetail = detail;
		if (!currentDetail) return;
		void runMutation(
			device.deviceRef,
			`Clearing the decision for ${device.displayName}.`,
			`${device.displayName} saved.`,
			setBusyDeviceRef,
			safeMutationError,
			() =>
				dependencies.clearDecision(candidateRef, device.deviceRef, {
					attemptId: currentDetail.attemptId,
				}),
		);
	};
	const mapProject = (project: api.LegacyTeamSetupProjectV1, resolvedProjectRef: string) => {
		const currentDetail = detail;
		if (!currentDetail) return;
		void runMutation(
			project.projectRef,
			`Saving the mapping for ${project.displayName}.`,
			`${project.displayName} saved.`,
			setBusyProjectRef,
			safeProjectMutationError,
			() =>
				dependencies.saveProjectMapping(candidateRef, project.projectRef, {
					attemptId: currentDetail.attemptId,
					resolvedProjectRef,
				}),
		);
	};

	return (
		<RadixDialog
			ariaDescribedby="legacy-team-setup-description"
			ariaLabelledby="legacy-team-setup-title"
			contentClassName="modal legacy-team-setup-dialog"
			contentId="legacyTeamSetupDialog"
			onCloseAutoFocus={(event) => {
				event.preventDefault();
				const activeTab = document.querySelector<HTMLElement>('.tab-btn[aria-current="page"]');
				const target = canRestoreFocus(returnFocus) ? returnFocus : activeTab;
				target?.focus();
				returnFocus = null;
			}}
			onOpenAutoFocus={(event) => {
				const heading = document.getElementById("legacy-team-setup-title");
				if (!heading) return;
				event.preventDefault();
				heading.focus();
			}}
			onOpenChange={(open) => {
				if (!open) close();
			}}
			open
			overlayClassName="modal-backdrop"
			overlayId="legacyTeamSetupDialogBackdrop"
		>
			<div
				aria-busy={loading || isSubmitting ? "true" : "false"}
				className="modal-card legacy-team-setup-card"
			>
				<div className="modal-header">
					<h2 id="legacy-team-setup-title" tabIndex={-1}>
						{title}
					</h2>
					<DialogCloseButton
						ariaDisabled={isSubmitting}
						ariaLabel={`Close ${title}`}
						onClick={close}
					/>
				</div>
				<div className="modal-body legacy-team-setup-body">
					<p className="small" id="legacy-team-setup-description">
						Review the server-provided device and Project work before this Team can be used for
						sharing.
					</p>
					{loading && !detail ? <p role="status">Loading the latest Team setup details…</p> : null}
					{error ? (
						<div className="legacy-team-setup-error">
							<p aria-live="assertive" role="alert">
								{error}
							</p>
							<button
								aria-disabled={loading || isSubmitting ? "true" : undefined}
								className="settings-button legacy-team-setup-target"
								id="legacy-team-setup-retry"
								onClick={() => {
									if (loading || isSubmitting) return;
									focusAfterLoad.current = true;
									refreshBeforeLoad.current = retryNeedsRefresh.current;
									setLoadRevision((current) => current + 1);
								}}
								type="button"
							>
								{loading ? "Retrying…" : "Retry"}
							</button>
						</div>
					) : null}
					{detail ? (
						<>
							{step !== "completed" ? (
								<>
									<ol aria-label="Team setup steps" className="legacy-team-setup-steps">
										<li>
											<button
												aria-current={step === "devices" ? "step" : undefined}
												className="settings-button legacy-team-setup-target"
												onClick={() => navigate("devices")}
												type="button"
											>
												Devices
											</button>
										</li>
										<li>
											<button
												aria-current={step === "projects" ? "step" : undefined}
												aria-describedby={
													devicesBlockProgress ? "legacy-team-setup-block-devices" : undefined
												}
												aria-disabled={devicesBlockProgress ? "true" : undefined}
												className="settings-button legacy-team-setup-target"
												onClick={() => {
													if (devicesBlockProgress) {
														explainBlockedStep(
															"devices",
															"Finish the device decisions before mapping Projects.",
														);
													} else navigate("projects");
												}}
												type="button"
											>
												Projects
											</button>
										</li>
										<li>
											<button
												aria-current={step === "review" ? "step" : undefined}
												aria-describedby={
													devicesBlockProgress
														? "legacy-team-setup-block-devices"
														: projectsBlockReview
															? "legacy-team-setup-block-projects"
															: undefined
												}
												aria-disabled={
													devicesBlockProgress || projectsBlockReview ? "true" : undefined
												}
												className="settings-button legacy-team-setup-target"
												onClick={() => {
													if (devicesBlockProgress) {
														explainBlockedStep(
															"devices",
															"Finish the device decisions before reviewing access.",
														);
													} else if (projectsBlockReview) {
														explainBlockedStep(
															"projects",
															"Finish the Project mappings before reviewing access.",
														);
													} else navigate("review");
												}}
												type="button"
											>
												Review
											</button>
										</li>
									</ol>
									{devicesBlockProgress ? (
										<p className="small" id="legacy-team-setup-block-devices">
											Finish the device decisions before mapping Projects or reviewing access.
										</p>
									) : null}
									{projectsBlockReview ? (
										<p className="small" id="legacy-team-setup-block-projects">
											Finish the Project mappings before reviewing access.
										</p>
									) : null}
								</>
							) : null}
							{loading ? (
								<p aria-live="polite" className="small" role="status">
									Refreshing Team setup details…
								</p>
							) : null}
							<p aria-live="polite" className="small" role="status">
								{operationStatus}
							</p>
							{step === "devices" ? (
								<LegacyTeamSetupDevices
									blocked={mutationsBlocked}
									busyDeviceRef={busyDeviceRef}
									detail={detail}
									onAssign={assignDevice}
									onClear={clearDevice}
									onDecision={decideDevice}
								/>
							) : step === "projects" ? (
								<LegacyTeamSetupProjects
									blocked={mutationsBlocked}
									busyProjectRef={busyProjectRef}
									detail={detail}
									onMap={mapProject}
								/>
							) : (
								<StepContent detail={detail} step={step} />
							)}
						</>
					) : null}
				</div>
				<div className="modal-footer legacy-team-setup-actions">
					<button
						aria-disabled={isSubmitting ? "true" : undefined}
						className="settings-button legacy-team-setup-target"
						onClick={close}
						type="button"
					>
						Close
					</button>
				</div>
			</div>
		</RadixDialog>
	);
}

export function mountLegacyTeamSetupDialog(
	mount: HTMLElement,
	overrides: Partial<LegacyTeamSetupDialogDependencies> = {},
): void {
	const dependencies = { ...defaultDependencies, ...overrides };
	render(<LegacyTeamSetupDialogHost dependencies={dependencies} />, mount);
}
