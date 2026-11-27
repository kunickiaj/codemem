import type { ComponentChildren } from "preact";
import { DialogCloseButton } from "../components/primitives/dialog-close-button";
import {
	RadixDialog,
	type RadixDialogProps,
	RadixDialogTitle,
} from "../components/primitives/radix-dialog";
import type {
	LegacyTeamSetupAssignee,
	LegacyTeamSetupDetailResponseV1,
	LegacyTeamSetupDeviceV1,
	LegacyTeamSetupProjectV1,
} from "../lib/api";
import { type DeviceNotice, LegacyTeamSetupDevices } from "./legacy-team-setup-devices";
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
	type SetupSessionError,
	type TeamSetupStep,
} from "./legacy-team-setup-session";

const EXPLICIT_LIST_ROLE = { role: "list" } as const;
const EXPLICIT_LIST_ITEM_ROLE = { role: "listitem" } as const;

export interface LegacyTeamSetupDialogViewProps {
	session: OpenSetupSessionState;
	onAssign: (device: LegacyTeamSetupDeviceV1, assignee: LegacyTeamSetupAssignee) => void;
	onDeviceDraftChange?: (deviceRef: string) => void;
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
	/** Shown with the recovery details of a setup that cannot be loaded or was turned off. */
	recoveryPanel?: ComponentChildren;
}

const UNSAVED_DEVICE_NOTICES_ID = "legacy-team-setup-device-notices";

function editableNotices(
	notices: ReadonlyMap<string, string>,
	onEdit: ((deviceRef: string) => void) | undefined,
): ReadonlyMap<string, DeviceNotice> {
	return new Map(
		[...notices].map(([deviceRef, message]) => [
			deviceRef,
			{ message, onEdit: onEdit ? () => onEdit(deviceRef) : undefined },
		]),
	);
}

function reviewBlockedDescriptionId(
	input: { itemRecoveryRequired: boolean; blockedDescriptionId: string | undefined },
	devicesNeedFixing: boolean,
): string | undefined {
	if (input.itemRecoveryRequired) return "legacy-team-setup-item-errors";
	if (devicesNeedFixing) return UNSAVED_DEVICE_NOTICES_ID;
	return input.blockedDescriptionId;
}

/** Why Finish is off while a device still shows an assignment that couldn't be saved. */
function UnsavedDeviceNotices(props: {
	detail: LegacyTeamSetupDetailResponseV1;
	notices: ReadonlyMap<string, string>;
}) {
	if (props.notices.size === 0) return null;
	const nameOf = (deviceRef: string) =>
		props.detail.devices.find((device) => device.deviceRef === deviceRef)?.displayName ??
		"A device";
	return (
		<div className="legacy-team-setup-error" id={UNSAVED_DEVICE_NOTICES_ID}>
			{[...props.notices].map(([deviceRef, message]) => (
				<p key={deviceRef}>
					{nameOf(deviceRef)}: {message} Fix this in Devices before finishing.
				</p>
			))}
		</div>
	);
}

function requiresRecoveryView(
	view: LegacyTeamSetupDialogViewProps["session"]["view"],
	error: SetupSessionError | null,
): boolean {
	return (
		view?.state === "unavailable" ||
		error?.retry === "refresh" ||
		((error?.scope.kind === "load" || error?.hideStaleView === true) && Boolean(view))
	);
}

/**
 * Item errors that need Retry lock their item. A correctable one, such as a name
 * that's already listed, is shown on its own row and leaves the row editable.
 */
function groupItemErrors(errors: OpenSetupSessionState["errors"]) {
	const itemErrors = errors.filter(
		(item) => (item.scope.kind === "device" || item.scope.kind === "project") && !item.correctable,
	);
	const refsOf = (kind: "device" | "project") =>
		new Set(
			itemErrors.flatMap((item) =>
				item.scope.kind === kind && "itemRef" in item.scope ? [item.scope.itemRef] : [],
			),
		);
	const deviceNotices = new Map(
		errors.flatMap((item) =>
			item.correctable && item.scope.kind === "device"
				? [[item.scope.itemRef, item.message] as const]
				: [],
		),
	);
	return {
		itemErrors,
		deviceNotices,
		blockedDeviceRefs: refsOf("device"),
		blockedProjectRefs: refsOf("project"),
	};
}

function retryLabel(loading: boolean, refresh: boolean): string {
	if (loading) return refresh ? "Refreshing…" : "Retrying…";
	return refresh ? "Retry loading current setup" : "Retry";
}

/**
 * The setup's global error with its retry, and the Team recovery: beside the
 * recovery details of a setup that could not be loaded, or on its own for a
 * setup that loads while its Team is on hold.
 */
function GlobalError(props: {
	busy: boolean;
	error: ReturnType<typeof globalError>;
	loading: boolean;
	onRetry: () => void;
	recoveryMode: boolean;
	recoveryPanel?: ComponentChildren;
}) {
	const { busy, error, loading, recoveryMode } = props;
	if (!error) return <>{props.recoveryPanel}</>;
	return (
		<div
			className="legacy-team-setup-error legacy-team-setup-recovery"
			id="legacy-team-setup-global-error"
		>
			{recoveryMode ? <strong>Current setup details are unavailable</strong> : null}
			<p aria-live="assertive" id="legacy-team-setup-error" role="alert">
				{error.message}
			</p>
			<button
				aria-busy={busy ? "true" : undefined}
				aria-disabled={busy ? "true" : undefined}
				className="settings-button legacy-team-setup-target"
				id="legacy-team-setup-retry"
				onClick={() => {
					if (!busy) props.onRetry();
				}}
				type="button"
			>
				{retryLabel(loading, error.retry === "refresh")}
			</button>
			{recoveryMode ? props.recoveryPanel : null}
		</div>
	);
}

export function LegacyTeamSetupDialogView(props: LegacyTeamSetupDialogViewProps) {
	const session = props.session;
	const view = session.view;
	const error = globalError(session);
	const loading = session.commands.some((command) => command.kind === "load");
	const globalBusy = hasGlobalOperation(session) || hasBlockingOperation(session);
	const finishing = session.commands.some((command) => command.kind === "finish");
	const recoveryRequired = requiresRecoveryView(view, error);
	const recoveryMode = error != null && (!view || recoveryRequired);
	const mutationsBlocked = !isEditable(view) || globalBusy || Boolean(error);
	const mutationBlockDescriptionId =
		[
			error ? "legacy-team-setup-error" : null,
			globalBusy ? "legacy-team-setup-operation-status" : null,
			view?.state === "unavailable" ? "legacy-team-setup-refresh" : null,
		]
			.filter(Boolean)
			.join(" ") || undefined;
	const title = view ? `Set up ${view.candidate.displayName}` : "Set up Team";
	const { itemErrors, deviceNotices, blockedDeviceRefs, blockedProjectRefs } = groupItemErrors(
		session.errors,
	);
	const itemRecoveryRequired = itemErrors.length > 0;
	const itemRefreshRecovery = itemErrors.some((item) => item.retry === "refresh");
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
					<div id="legacy-team-setup-title" tabIndex={-1}>
						<RadixDialogTitle>{title}</RadixDialogTitle>
					</div>
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
					<GlobalError
						busy={globalBusy}
						error={error}
						loading={loading}
						onRetry={props.onRetry}
						recoveryMode={recoveryMode}
						recoveryPanel={props.recoveryPanel}
					/>
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
								{loading
									? itemRefreshRecovery
										? "Refreshing…"
										: "Retrying…"
									: itemRefreshRecovery
										? "Refresh Team setup"
										: "Retry"}
							</button>
						</div>
					) : null}
					{view ? (
						<>
							{session.step !== "completed" && !recoveryMode ? (
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
							{recoveryMode ? null : (
								<StepBody
									blockedDescriptionId={mutationBlockDescriptionId}
									blockedDeviceRefs={blockedDeviceRefs}
									blockedProjectRefs={blockedProjectRefs}
									busy={globalBusy}
									busyDeviceRefs={busyDeviceRefs}
									busyProjectRefs={busyProjectRefs}
									deviceNotices={deviceNotices}
									finishing={finishing}
									itemRecoveryRequired={itemRecoveryRequired}
									mutationsBlocked={mutationsBlocked}
									props={props}
									recoveryRequired={recoveryRequired}
									view={view}
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

/** The current step's content: device review, Project mapping, the final review, or a fallback. */
function StepBody(input: {
	blockedDescriptionId: string | undefined;
	blockedDeviceRefs: ReadonlySet<string>;
	blockedProjectRefs: ReadonlySet<string>;
	busy: boolean;
	busyDeviceRefs: ReadonlySet<string>;
	busyProjectRefs: ReadonlySet<string>;
	deviceNotices: ReadonlyMap<string, string>;
	finishing: boolean;
	itemRecoveryRequired: boolean;
	mutationsBlocked: boolean;
	props: LegacyTeamSetupDialogViewProps;
	recoveryRequired: boolean;
	view: NonNullable<OpenSetupSessionState["view"]>;
}) {
	const { props, view } = input;
	const step = props.session.step;
	if (step === "devices") {
		return (
			<LegacyTeamSetupDevices
				blocked={input.mutationsBlocked}
				blockedDescriptionId={input.blockedDescriptionId}
				blockedDeviceRefs={input.blockedDeviceRefs}
				busyDeviceRefs={input.busyDeviceRefs}
				detail={view}
				deviceNotices={editableNotices(input.deviceNotices, props.onDeviceDraftChange)}
				onAssign={props.onAssign}
				onClear={props.onClear}
				onDecision={props.onDecide}
			/>
		);
	}
	if (step === "projects") {
		return (
			<LegacyTeamSetupProjects
				blocked={input.mutationsBlocked}
				blockedDescriptionId={input.blockedDescriptionId}
				blockedProjectRefs={input.blockedProjectRefs}
				busyProjectRefs={input.busyProjectRefs}
				detail={view}
				onContinue={() => props.onNavigate("review")}
				onMap={props.onMap}
			/>
		);
	}
	if (step === "review" && view.state === "ready_to_finish") {
		const devicesNeedFixing = input.deviceNotices.size > 0;
		return (
			<>
				<UnsavedDeviceNotices detail={view} notices={input.deviceNotices} />
				<LegacyTeamSetupReview
					blocked={input.mutationsBlocked || input.itemRecoveryRequired || devicesNeedFixing}
					blockedDescriptionId={reviewBlockedDescriptionId(input, devicesNeedFixing)}
					detail={view}
					finishing={input.finishing}
					onFinish={props.onFinish}
				/>
			</>
		);
	}
	return (
		<FallbackStep
			busy={input.busy}
			canFinish={view.state === "ready_to_finish"}
			onRefresh={props.onRefresh}
			recoveryRequired={input.recoveryRequired}
			step={step}
		/>
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
