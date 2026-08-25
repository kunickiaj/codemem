import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { DialogCloseButton } from "../components/primitives/dialog-close-button";
import { RadixDialog } from "../components/primitives/radix-dialog";
import * as api from "../lib/api";

type TeamSetupStep = "devices" | "projects" | "review" | "completed";
const CHANGED_STATE_ERROR =
	"Team setup changed since it was last reviewed. Reload the latest details to continue.";
const RELOAD_ERROR_CODES = new Set<api.LegacyTeamSetupErrorCode>([
	"team_setup_roster_changed",
	"team_setup_assignment_changed",
	"team_setup_conflict",
	"team_setup_confirmation_stale",
]);

interface LegacyTeamSetupDialogDependencies {
	loadDetail: typeof api.loadLegacyTeamSetupDetail;
	refreshCandidate: typeof api.refreshLegacyTeamSetupCandidate;
}

const defaultDependencies: LegacyTeamSetupDialogDependencies = {
	loadDetail: api.loadLegacyTeamSetupDetail,
	refreshCandidate: api.refreshLegacyTeamSetupCandidate,
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
	if (step === "devices") {
		return (
			<section aria-labelledby="legacy-team-setup-step-devices">
				<h3 id="legacy-team-setup-step-devices" tabIndex={-1}>
					Review devices
				</h3>
				<p>
					{detail.unresolvedDeviceCount.toLocaleString()} of{" "}
					{detail.candidate.deviceCount.toLocaleString()} Team devices still need a person or
					exclusion decision.
				</p>
				<p className="small">
					Next setup action: assign each unresolved device to a person or exclude it from this Team.
				</p>
			</section>
		);
	}
	if (step === "projects") {
		return (
			<section aria-labelledby="legacy-team-setup-step-projects">
				<h3 id="legacy-team-setup-step-projects" tabIndex={-1}>
					Review Projects
				</h3>
				<p>
					{detail.unresolvedProjectCount.toLocaleString()} of{" "}
					{detail.candidate.projectCount.toLocaleString()} Team Projects still need a mapping
					decision.
				</p>
				<p className="small">
					Next setup action: map each unresolved Project using the server-provided choices.
				</p>
			</section>
		);
	}
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
	const focusAfterLoad = useRef(false);
	const focusStepAfterRender = useRef(false);
	const refreshBeforeLoad = useRef(false);
	const retryNeedsRefresh = useRef(false);

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
		focusAfterLoad.current = false;
		focusStepAfterRender.current = false;
		refreshBeforeLoad.current = false;
		retryNeedsRefresh.current = false;
		setCandidateRef(null);
		setDetail(null);
		setError(null);
		setLoading(false);
	};
	const navigate = (nextStep: TeamSetupStep) => {
		if (nextStep === step) {
			document.getElementById(`legacy-team-setup-step-${nextStep}`)?.focus();
			return;
		}
		focusStepAfterRender.current = true;
		setStep(nextStep);
	};
	const devicesBlockProgress = detail ? detail.unresolvedDeviceCount > 0 : false;
	const projectsBlockReview = detail ? detail.unresolvedProjectCount > 0 : false;

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
			<div aria-busy={loading ? "true" : "false"} className="modal-card legacy-team-setup-card">
				<div className="modal-header">
					<h2 id="legacy-team-setup-title" tabIndex={-1}>
						{title}
					</h2>
					<DialogCloseButton ariaLabel={`Close ${title}`} onClick={close} />
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
								aria-disabled={loading ? "true" : undefined}
								className="settings-button legacy-team-setup-target"
								id="legacy-team-setup-retry"
								onClick={() => {
									if (loading) return;
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
													if (!devicesBlockProgress) navigate("projects");
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
													if (!devicesBlockProgress && !projectsBlockReview) navigate("review");
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
							<StepContent detail={detail} step={step} />
						</>
					) : null}
				</div>
				<div className="modal-footer legacy-team-setup-actions">
					<button
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
