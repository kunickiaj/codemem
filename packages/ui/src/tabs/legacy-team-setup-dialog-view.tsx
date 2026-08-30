import { DialogCloseButton } from "../components/primitives/dialog-close-button";
import { RadixDialog, type RadixDialogProps } from "../components/primitives/radix-dialog";
import type { LegacyTeamSetupDeviceV1, LegacyTeamSetupProjectV1 } from "../lib/api";
import { LegacyTeamSetupDevices } from "./legacy-team-setup-devices";
import { setupItemErrorId } from "./legacy-team-setup-dom";
import { LegacyTeamSetupProjects } from "./legacy-team-setup-projects";
import { LegacyTeamSetupReview } from "./legacy-team-setup-review";
import {
	globalError,
	hasBlockingOperation,
	hasGlobalOperation,
	type InteractiveTeamSetupStep,
	isEditable,
	type OpenSetupSessionState,
	type TeamSetupStep,
} from "./legacy-team-setup-session";

const EXPLICIT_LIST_ROLE = { role: "list" } as const;
const EXPLICIT_LIST_ITEM_ROLE = { role: "listitem" } as const;

export interface LegacyTeamSetupDialogViewProps {
	session: OpenSetupSessionState;
	onAssign: (device: LegacyTeamSetupDeviceV1, targetIdentityRef: string) => void;
	onClear: (device: LegacyTeamSetupDeviceV1) => void;
	onClose: () => void;
	onCloseAutoFocus: NonNullable<RadixDialogProps["onCloseAutoFocus"]>;
	onDecide: (
		device: LegacyTeamSetupDeviceV1,
		decision: "included" | "excluded" | "removed",
		targetIdentityRef?: string,
	) => void;
	onFinish: () => void;
	onMap: (project: LegacyTeamSetupProjectV1, resolvedProjectRef: string) => void;
	onNavigate: (step: InteractiveTeamSetupStep) => void;
	onOpenAutoFocus: NonNullable<RadixDialogProps["onOpenAutoFocus"]>;
	onRefresh: () => void;
	onRetry: () => void;
}

export function LegacyTeamSetupDialogView(props: LegacyTeamSetupDialogViewProps) {
	const session = props.session;
	const view = session.view;
	const error = globalError(session);
	const loading = session.commands.some((command) => command.kind === "load");
	const globalBusy = hasGlobalOperation(session) || hasBlockingOperation(session);
	const recoveryRequired = view?.state === "unavailable" || error?.retry === "refresh";
	const mutationsBlocked = !isEditable(view) || globalBusy || Boolean(error);
	const mutationBlockDescriptionId = error
		? "legacy-team-setup-error"
		: globalBusy
			? "legacy-team-setup-operation-status"
			: view?.state === "unavailable"
				? "legacy-team-setup-refresh"
				: undefined;
	const title = view ? `Set up ${view.candidate.displayName}` : "Set up Team";
	const itemErrors = session.errors.filter(
		(item) => item.scope.kind === "device" || item.scope.kind === "project",
	);
	const itemRecoveryRequired = itemErrors.length > 0;
	const blockedDeviceRefs = new Set(
		itemErrors.flatMap((item) => (item.scope.kind === "device" ? [item.scope.itemRef] : [])),
	);
	const blockedProjectRefs = new Set(
		itemErrors.flatMap((item) => (item.scope.kind === "project" ? [item.scope.itemRef] : [])),
	);
	const busyDeviceRefs = new Set(
		session.commands.flatMap((command) => ("deviceRef" in command ? [command.deviceRef] : [])),
	);
	const busyProjectRefs = new Set(
		session.commands.flatMap((command) => ("projectRef" in command ? [command.projectRef] : [])),
	);

	return (
		<RadixDialog
			ariaDescribedby="legacy-team-setup-description"
			ariaLabelledby="legacy-team-setup-title"
			contentClassName="modal legacy-team-setup-dialog"
			contentId="legacyTeamSetupDialog"
			onCloseAutoFocus={props.onCloseAutoFocus}
			onOpenAutoFocus={props.onOpenAutoFocus}
			onOpenChange={(open) => {
				if (!open) props.onClose();
			}}
			open
			overlayClassName="modal-backdrop"
			overlayId="legacyTeamSetupDialogBackdrop"
		>
			<div aria-busy={globalBusy ? "true" : "false"} className="modal-card legacy-team-setup-card">
				<div className="modal-header">
					<h2 id="legacy-team-setup-title" tabIndex={-1}>
						{title}
					</h2>
					<DialogCloseButton
						ariaDisabled={globalBusy}
						ariaLabel={`Close ${title}`}
						onClick={props.onClose}
					/>
				</div>
				<div className="modal-body legacy-team-setup-body">
					<p className="small" id="legacy-team-setup-description">
						Review device ownership and Project access before this Team can be used for sharing.
					</p>
					{loading && !view ? <p role="status">Loading the latest Team setup details…</p> : null}
					{error ? (
						<div className="legacy-team-setup-error" id="legacy-team-setup-global-error">
							<p aria-live="assertive" id="legacy-team-setup-error" role="alert">
								{error.message}
							</p>
							{view?.state !== "unavailable" ? (
								<button
									aria-busy={globalBusy ? "true" : undefined}
									aria-disabled={globalBusy ? "true" : undefined}
									className="settings-button legacy-team-setup-target"
									id="legacy-team-setup-retry"
									onClick={() => {
										if (!globalBusy) props.onRetry();
									}}
									type="button"
								>
									{loading ? "Retrying…" : "Retry"}
								</button>
							) : null}
						</div>
					) : null}
					{itemRecoveryRequired ? (
						<div className="legacy-team-setup-error" id="legacy-team-setup-item-errors">
							{itemErrors.map((item) => (
								<p
									aria-live="assertive"
									id={
										"itemRef" in item.scope
											? setupItemErrorId(item.scope.kind, item.scope.itemRef)
											: undefined
									}
									key={
										"itemRef" in item.scope
											? `${item.scope.kind}:${item.scope.itemRef}`
											: item.scope.kind
									}
									role="alert"
								>
									{item.message}
								</p>
							))}
							<button
								aria-busy={globalBusy ? "true" : undefined}
								aria-disabled={globalBusy ? "true" : undefined}
								className="settings-button legacy-team-setup-target"
								id="legacy-team-setup-item-retry"
								onClick={() => {
									if (!globalBusy) props.onRetry();
								}}
								type="button"
							>
								{loading ? "Retrying…" : "Retry"}
							</button>
						</div>
					) : null}
					{view ? (
						<>
							{session.step !== "completed" ? (
								<StepNavigation
									onNavigate={props.onNavigate}
									step={session.step}
									unresolvedDeviceCount={view.unresolvedDeviceCount}
									unresolvedProjectCount={view.unresolvedProjectCount}
								/>
							) : null}
							{loading ? (
								<p
									aria-live="polite"
									className="small"
									id="legacy-team-setup-refresh-status"
									role="status"
								>
									Refreshing Team setup details…
								</p>
							) : null}
							<p
								aria-live="polite"
								className="small"
								id="legacy-team-setup-operation-status"
								role="status"
							>
								{session.message}
							</p>
							{view.state === "unavailable" ? (
								<button
									aria-busy={globalBusy ? "true" : undefined}
									aria-disabled={globalBusy ? "true" : undefined}
									className="settings-button legacy-team-setup-target"
									id="legacy-team-setup-refresh"
									onClick={() => {
										if (!globalBusy) props.onRefresh();
									}}
									type="button"
								>
									Refresh Team setup
								</button>
							) : null}
							{session.step === "devices" ? (
								<LegacyTeamSetupDevices
									blocked={mutationsBlocked}
									blockedDescriptionId={mutationBlockDescriptionId}
									blockedDeviceRefs={blockedDeviceRefs}
									busyDeviceRefs={busyDeviceRefs}
									detail={view}
									onAssign={props.onAssign}
									onClear={props.onClear}
									onDecision={props.onDecide}
								/>
							) : session.step === "projects" ? (
								<LegacyTeamSetupProjects
									blocked={mutationsBlocked}
									blockedDescriptionId={mutationBlockDescriptionId}
									blockedProjectRefs={blockedProjectRefs}
									busyProjectRefs={busyProjectRefs}
									detail={view}
									onContinue={() => props.onNavigate("review")}
									onMap={props.onMap}
								/>
							) : session.step === "review" && view.state === "ready_to_finish" ? (
								<LegacyTeamSetupReview
									blocked={mutationsBlocked || itemRecoveryRequired}
									blockedDescriptionId={
										itemRecoveryRequired
											? "legacy-team-setup-item-errors"
											: mutationBlockDescriptionId
									}
									detail={view}
									onFinish={props.onFinish}
								/>
							) : (
								<FallbackStep
									busy={globalBusy}
									canFinish={view.state === "ready_to_finish"}
									onRefresh={props.onRefresh}
									recoveryRequired={recoveryRequired}
									step={session.step}
								/>
							)}
						</>
					) : null}
				</div>
				<div className="modal-footer legacy-team-setup-actions">
					<button
						aria-disabled={globalBusy ? "true" : undefined}
						className="settings-button legacy-team-setup-target"
						onClick={props.onClose}
						type="button"
					>
						Close
					</button>
				</div>
			</div>
		</RadixDialog>
	);
}

function StepNavigation(props: {
	step: TeamSetupStep;
	unresolvedDeviceCount: number;
	unresolvedProjectCount: number;
	onNavigate: (step: InteractiveTeamSetupStep) => void;
}) {
	const devicesBlocked = props.unresolvedDeviceCount > 0;
	const projectsBlocked = props.unresolvedProjectCount > 0;
	const steps: Array<{ label: string; step: "devices" | "projects" | "review" }> = [
		{ label: "Devices", step: "devices" },
		{ label: "Projects", step: "projects" },
		{ label: "Review", step: "review" },
	];
	return (
		<>
			<ol {...EXPLICIT_LIST_ROLE} aria-label="Team setup steps" className="legacy-team-setup-steps">
				{steps.map((item, index) => {
					const blocked =
						item.step === "projects"
							? devicesBlocked
							: item.step === "review"
								? devicesBlocked || projectsBlocked
								: false;
					const describedBy = blocked
						? devicesBlocked
							? "legacy-team-setup-block-devices"
							: "legacy-team-setup-block-projects"
						: undefined;
					return (
						<li {...EXPLICIT_LIST_ITEM_ROLE} className="legacy-team-setup-step" key={item.step}>
							<span aria-hidden="true" className="legacy-team-setup-step-number">
								{index + 1}
							</span>
							<button
								aria-current={props.step === item.step ? "step" : undefined}
								aria-describedby={describedBy}
								aria-disabled={blocked ? "true" : undefined}
								aria-label={`Step ${index + 1}: ${item.label}`}
								className="settings-button legacy-team-setup-target"
								onClick={() => props.onNavigate(item.step)}
								type="button"
							>
								{item.label}
							</button>
						</li>
					);
				})}
			</ol>
			{devicesBlocked ? (
				<p className="small" id="legacy-team-setup-block-devices">
					Finish the device decisions before mapping Projects or reviewing access.
				</p>
			) : null}
			{projectsBlocked ? (
				<p className="small" id="legacy-team-setup-block-projects">
					Finish the Project mappings before reviewing access.
				</p>
			) : null}
		</>
	);
}

function FallbackStep(props: {
	busy: boolean;
	canFinish: boolean;
	onRefresh: () => void;
	recoveryRequired: boolean;
	step: TeamSetupStep;
}) {
	if (props.step === "completed") {
		return (
			<section aria-labelledby="legacy-team-setup-step-completed">
				<h3 id="legacy-team-setup-step-completed" tabIndex={-1}>
					Team setup complete
				</h3>
				<p>This Team is ready for Project sharing.</p>
			</section>
		);
	}
	if (props.step !== "review") return null;
	return (
		<section aria-labelledby="legacy-team-setup-step-review">
			<h3 id="legacy-team-setup-step-review" tabIndex={-1}>
				Review and finish
			</h3>
			<p>
				{props.canFinish
					? "The server has confirmed that this Team is ready for final review."
					: "Final review is waiting for the latest setup details."}
			</p>
			<p className="small">Next setup action: review the access summary before finishing.</p>
			{!props.canFinish && !props.recoveryRequired ? (
				<button
					aria-busy={props.busy ? "true" : undefined}
					aria-disabled={props.busy ? "true" : undefined}
					className="settings-button legacy-team-setup-target"
					onClick={() => {
						if (!props.busy) props.onRefresh();
					}}
					type="button"
				>
					Refresh Team setup
				</button>
			) : null}
		</section>
	);
}
