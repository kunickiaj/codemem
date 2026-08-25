import { useEffect, useState } from "preact/hooks";
import type { LegacyTeamSetupDetailResponseV1, LegacyTeamSetupDeviceV1 } from "../lib/api";

type DeviceDecision = "included" | "excluded" | "removed";

export interface LegacyTeamSetupDevicesProps {
	blocked: boolean;
	busyDeviceRef: string | null;
	detail: LegacyTeamSetupDetailResponseV1;
	onAssign: (device: LegacyTeamSetupDeviceV1, identityRef: string) => void;
	onClear: (device: LegacyTeamSetupDeviceV1) => void;
	onDecision: (
		device: LegacyTeamSetupDeviceV1,
		decision: DeviceDecision,
		identityRef?: string,
	) => void;
}

const DECISION_LABELS: Record<LegacyTeamSetupDeviceV1["decision"], string> = {
	unresolved: "Needs a decision",
	included: "Included in this Team",
	excluded: "Excluded from this Team",
	removed: "Removed from this Team",
};

function identityName(detail: LegacyTeamSetupDetailResponseV1, identityRef: string | null) {
	if (!identityRef) return null;
	return (
		detail.identityChoices.find((identity) => identity.identityRef === identityRef)?.displayName ??
		"Unavailable person"
	);
}

function initialIdentityRef(device: LegacyTeamSetupDeviceV1): string {
	return device.targetIdentityRef ?? device.existingIdentityRef ?? "";
}

function DeviceRow({
	blocked,
	busy,
	detail,
	device,
	index,
	onAssign,
	onClear,
	onDecision,
}: LegacyTeamSetupDevicesProps & {
	busy: boolean;
	device: LegacyTeamSetupDeviceV1;
	index: number;
}) {
	const controlId = `legacy-team-device-identity-${index}`;
	const evidenceId = `legacy-team-device-evidence-${index}`;
	const assignmentHelpId = `legacy-team-device-assignment-help-${index}`;
	const initialIdentity = initialIdentityRef(device);
	const savedIdentity = device.targetIdentityRef ?? "";
	const [draftIdentityRef, setDraftIdentityRef] = useState(initialIdentity);
	useEffect(() => setDraftIdentityRef(initialIdentity), [initialIdentity]);
	const selectedChoiceExists = detail.identityChoices.some(
		(identity) => identity.identityRef === draftIdentityRef,
	);
	const existingName = identityName(detail, device.existingIdentityRef);
	const suggestedName = identityName(detail, device.suggestedIdentityRef);
	const controlsBlocked = blocked || busy;
	const assignmentControlsBlocked = controlsBlocked || !device.enabled;
	const assignmentEvidenceInactive =
		device.expectation.kind === "existing" && device.verifiedEvidenceKind !== "active_assignment";
	const assignmentIdentityUnavailable = Boolean(draftIdentityRef) && !selectedChoiceExists;
	const includeNeedsHelp =
		assignmentEvidenceInactive ||
		assignmentIdentityUnavailable ||
		!savedIdentity ||
		draftIdentityRef !== savedIdentity;
	const includeBlocked = controlsBlocked || includeNeedsHelp;
	const assignmentBlocked =
		assignmentControlsBlocked ||
		!draftIdentityRef ||
		assignmentEvidenceInactive ||
		assignmentIdentityUnavailable ||
		draftIdentityRef === savedIdentity;

	return (
		<fieldset aria-busy={busy ? "true" : "false"} className="legacy-team-device-row">
			<legend>{device.displayName}</legend>
			<div className="small legacy-team-device-evidence" id={evidenceId}>
				<span>
					{device.enabled ? "Current Team device" : "Device no longer active on this Team"}
				</span>
				{existingName ? (
					<span>
						Current assignment: {existingName}
						{device.verifiedEvidenceKind === "active_assignment"
							? " · verified active assignment"
							: ""}
					</span>
				) : null}
				{!existingName && suggestedName ? <span>Suggested person: {suggestedName}</span> : null}
				<span>Decision: {DECISION_LABELS[device.decision]}</span>
			</div>
			<label htmlFor={controlId}>Person using this device</label>
			<select
				aria-describedby={`${evidenceId}${includeNeedsHelp ? ` ${assignmentHelpId}` : ""}`}
				className="feed-search legacy-team-device-select"
				disabled={assignmentControlsBlocked}
				id={controlId}
				onChange={(event) => setDraftIdentityRef(event.currentTarget.value)}
				value={draftIdentityRef}
			>
				<option value="">Choose a person</option>
				{draftIdentityRef && !selectedChoiceExists ? (
					<option value={draftIdentityRef}>Current server assignment</option>
				) : null}
				{detail.identityChoices.map((identity) => (
					<option key={identity.identityRef} value={identity.identityRef}>
						{identity.displayName}
					</option>
				))}
			</select>
			{!device.enabled ? (
				<p className="small" id={assignmentHelpId}>
					Inactive devices can only be removed from this Team.
				</p>
			) : assignmentIdentityUnavailable ? (
				<p className="small" id={assignmentHelpId}>
					This person is no longer available. Choose an available person and save the assignment
					before including this device.
				</p>
			) : assignmentEvidenceInactive ? (
				<p className="small" id={assignmentHelpId}>
					This assignment is inactive. Reconcile this device in Devices or exclude it from this
					Team.
				</p>
			) : !draftIdentityRef || !savedIdentity || draftIdentityRef !== savedIdentity ? (
				<p className="small" id={assignmentHelpId}>
					{draftIdentityRef
						? "Save the selected person assignment before including this device."
						: "Choose and save a person assignment before including this device."}
				</p>
			) : null}
			<div className="legacy-team-device-actions">
				<button
					aria-describedby={!draftIdentityRef ? assignmentHelpId : evidenceId}
					aria-disabled={assignmentBlocked ? "true" : undefined}
					className="settings-button legacy-team-setup-target"
					onClick={() => {
						if (!assignmentBlocked) onAssign(device, draftIdentityRef);
					}}
					type="button"
				>
					Save assignment
				</button>
				{device.enabled ? (
					<>
						<button
							aria-describedby={includeNeedsHelp ? assignmentHelpId : evidenceId}
							aria-disabled={includeBlocked ? "true" : undefined}
							className="settings-button legacy-team-setup-target"
							onClick={() => {
								if (!includeBlocked) onDecision(device, "included", savedIdentity);
							}}
							type="button"
						>
							Include
						</button>
						<button
							aria-disabled={controlsBlocked ? "true" : undefined}
							className="settings-button legacy-team-setup-target"
							onClick={() => {
								if (!controlsBlocked) onDecision(device, "excluded");
							}}
							type="button"
						>
							Exclude
						</button>
					</>
				) : (
					<button
						aria-disabled={controlsBlocked ? "true" : undefined}
						className="settings-button legacy-team-setup-target"
						onClick={() => {
							if (!controlsBlocked) onDecision(device, "removed");
						}}
						type="button"
					>
						Remove
					</button>
				)}
				{device.decision !== "unresolved" ? (
					<button
						aria-disabled={controlsBlocked ? "true" : undefined}
						className="settings-button legacy-team-setup-target"
						onClick={() => {
							if (!controlsBlocked) onClear(device);
						}}
						type="button"
					>
						Clear decision
					</button>
				) : null}
			</div>
		</fieldset>
	);
}

export function LegacyTeamSetupDevices(props: LegacyTeamSetupDevicesProps) {
	return (
		<section aria-labelledby="legacy-team-setup-step-devices">
			<h3 id="legacy-team-setup-step-devices" tabIndex={-1}>
				Review devices
			</h3>
			<p>
				{props.detail.unresolvedDeviceCount.toLocaleString()} of{" "}
				{props.detail.candidate.deviceCount.toLocaleString()} Team devices still need a decision.
			</p>
			<div className="legacy-team-device-list">
				{props.detail.devices.map((device, index) => (
					<DeviceRow
						{...props}
						busy={props.busyDeviceRef === device.deviceRef}
						device={device}
						index={index}
						key={device.deviceRef}
					/>
				))}
			</div>
		</section>
	);
}
