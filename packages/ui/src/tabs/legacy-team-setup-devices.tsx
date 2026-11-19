import { useEffect, useId, useState } from "preact/hooks";
import { NativeSelect } from "../components/primitives/native-select";
import type {
	LegacyTeamSetupAssignee,
	LegacyTeamSetupDetailResponseV1,
	LegacyTeamSetupDeviceV1,
} from "../lib/api";
import { PERSON_NAME_LIMIT, personNameProblem } from "../lib/identity-presentation";
import { setupItemErrorId } from "./legacy-team-setup-dom";
import { orderedSetupDevices } from "./legacy-team-setup-order";

type DeviceDecision = "included" | "excluded" | "removed";

export interface LegacyTeamSetupDevicesProps {
	blocked: boolean;
	blockedDeviceRefs?: ReadonlySet<string>;
	blockedDescriptionId?: string;
	busyDeviceRefs: ReadonlySet<string>;
	detail: LegacyTeamSetupDetailResponseV1;
	/** A message the person can fix on this device's row, keyed by device. */
	deviceNotices?: ReadonlyMap<string, string>;
	onAssign: (device: LegacyTeamSetupDeviceV1, assignee: LegacyTeamSetupAssignee) => void;
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

/** Another device's record on this machine is a guess, so the person must pick. */
function initialIdentityRef(device: LegacyTeamSetupDeviceV1): string {
	if (device.targetIdentityRef) return device.targetIdentityRef;
	if (device.identityEvidence === "label") return "";
	return device.existingIdentityRef ?? "";
}

function assignmentEvidenceText(device: LegacyTeamSetupDeviceV1, name: string): string {
	if (device.identityEvidence === "label")
		return `This computer lists it as ${name}. Confirm the person who uses that device.`;
	if (device.verifiedEvidenceKind === "active_assignment")
		return `Current assignment: ${name} · verified active assignment`;
	return `Current assignment: ${name}`;
}

/** Picker value for "someone new"; never a server identity reference. */
const NEW_PERSON = "new-person";

/**
 * Why the typed name can't be saved for someone new, or "" when it can. Whether
 * the name is already taken is left to the server: the list adds suffixes to tell
 * same-named people apart, so its labels aren't the stored names.
 */
function newPersonProblem(name: string): string {
	if (!name.trim()) return "Enter the name of the person who uses this device.";
	return personNameProblem(name);
}

function assignmentHelpText(input: {
	device: LegacyTeamSetupDeviceV1;
	draft: string;
	saved: string;
	newPersonError: string;
	identityUnavailable: boolean;
	evidenceInactive: boolean;
}): string | null {
	if (!input.device.enabled) return "Inactive devices can only be removed from this Team.";
	if (input.draft === NEW_PERSON) {
		return (
			input.newPersonError ||
			"Save the assignment to add this person and assign this device to them."
		);
	}
	if (input.identityUnavailable) {
		return "This person is no longer available. Choose an available person and save the assignment before including this device.";
	}
	if (input.evidenceInactive) {
		return "This assignment is inactive. Reconcile this device in Devices or exclude it from this Team.";
	}
	if (!input.draft) return "Choose and save a person assignment before including this device.";
	if (!input.saved || input.draft !== input.saved) {
		return "Save the selected person assignment before including this device.";
	}
	return null;
}

function PersonPicker(props: {
	controlId: string;
	describedBy: string;
	detail: LegacyTeamSetupDetailResponseV1;
	disabled: boolean;
	draft: string;
	newPersonName: string;
	onDraft: (value: string) => void;
	onNewPersonName: (value: string) => void;
	showUnavailable: boolean;
}) {
	return (
		<>
			<label htmlFor={props.controlId}>Person using this device</label>
			<NativeSelect
				aria-describedby={props.describedBy}
				className="legacy-team-device-select"
				disabled={props.disabled}
				id={props.controlId}
				onChange={(event) => props.onDraft(event.currentTarget.value)}
				value={props.draft}
			>
				<option value="">Choose a person</option>
				{props.showUnavailable ? (
					<option value={props.draft}>Current server assignment</option>
				) : null}
				{props.detail.identityChoices.map((identity) => (
					<option key={identity.identityRef} value={identity.identityRef}>
						{identity.displayName}
					</option>
				))}
				<option value={NEW_PERSON}>Someone new…</option>
			</NativeSelect>
			<NewPersonName
				describedBy={props.describedBy}
				disabled={props.disabled}
				id={`${props.controlId}-new-name`}
				onInput={props.onNewPersonName}
				shown={props.draft === NEW_PERSON}
				value={props.newPersonName}
			/>
		</>
	);
}

/** The name field for "Someone new…", shown only while that choice is selected. */
function NewPersonName(props: {
	describedBy: string;
	disabled: boolean;
	id: string;
	onInput: (value: string) => void;
	shown: boolean;
	value: string;
}) {
	if (!props.shown) return null;
	return (
		<>
			<label htmlFor={props.id}>Their name</label>
			<input
				aria-describedby={props.describedBy}
				className="legacy-team-device-new-person"
				disabled={props.disabled}
				id={props.id}
				maxLength={PERSON_NAME_LIMIT}
				onInput={(event) => props.onInput(event.currentTarget.value)}
				type="text"
				value={props.value}
			/>
		</>
	);
}

/** What the assignment controls allow and explain for the current draft. */
function assignmentState(input: {
	assignmentControlsBlocked: boolean;
	detail: LegacyTeamSetupDetailResponseV1;
	device: LegacyTeamSetupDeviceV1;
	draft: string;
	newPersonName: string;
	saved: string;
}) {
	const { device, draft, saved } = input;
	const addingPerson = draft === NEW_PERSON;
	const newPersonError = addingPerson ? newPersonProblem(input.newPersonName) : "";
	const selectedChoiceExists =
		addingPerson || input.detail.identityChoices.some((identity) => identity.identityRef === draft);
	const evidenceInactive =
		device.actions.assignIdentity.blockedReason === "assignment_evidence_inactive";
	const identityUnavailable = Boolean(draft) && !selectedChoiceExists;
	const includeNeedsHelp =
		!device.actions.include.enabled ||
		evidenceInactive ||
		identityUnavailable ||
		!saved ||
		draft !== saved;
	const assignmentBlocked =
		input.assignmentControlsBlocked ||
		!draft ||
		Boolean(newPersonError) ||
		evidenceInactive ||
		identityUnavailable ||
		draft === saved;
	return {
		addingPerson,
		assignmentBlocked,
		assignmentHelp: assignmentHelpText({
			device,
			draft,
			saved,
			newPersonError,
			identityUnavailable,
			evidenceInactive,
		}),
		assignmentIdentityUnavailable: identityUnavailable,
		includeNeedsHelp,
	};
}

function DeviceRow({
	blocked,
	blockedDescriptionId,
	blockedDeviceRefs,
	busy,
	detail,
	device,
	deviceNotices,
	index,
	onAssign,
	onClear,
	onDecision,
}: LegacyTeamSetupDevicesProps & {
	busy: boolean;
	device: LegacyTeamSetupDeviceV1;
	index: number;
}) {
	const generatedId = useId();
	const controlId = `${generatedId}-identity`;
	const evidenceId = `${generatedId}-evidence`;
	const assignmentHelpId = `${generatedId}-assignment-help`;
	const initialIdentity = initialIdentityRef(device);
	const savedIdentity = device.targetIdentityRef ?? "";
	const [draftIdentityRef, setDraftIdentityRef] = useState(initialIdentity);
	const [newPersonName, setNewPersonName] = useState("");
	useEffect(() => setDraftIdentityRef(initialIdentity), [initialIdentity]);
	const itemBlocked = blockedDeviceRefs?.has(device.deviceRef) ?? false;
	const controlsBlocked = blocked || itemBlocked || busy;
	const assignmentControlsBlocked = controlsBlocked || !device.actions.assignIdentity.enabled;
	const {
		addingPerson,
		assignmentBlocked,
		assignmentHelp,
		assignmentIdentityUnavailable,
		includeNeedsHelp,
	} = assignmentState({
		assignmentControlsBlocked,
		detail,
		device,
		draft: draftIdentityRef,
		newPersonName,
		saved: savedIdentity,
	});
	const includeBlocked = controlsBlocked || includeNeedsHelp;
	const notice = deviceNotices?.get(device.deviceRef);
	const existingName = identityName(detail, device.existingIdentityRef);
	const suggestedName = identityName(detail, device.suggestedIdentityRef);
	const assignmentNeedsHelp = !device.enabled || includeNeedsHelp;
	const globalBlockedDescription = blocked
		? blockedDescriptionId
		: itemBlocked
			? setupItemErrorId("device", device.deviceRef)
			: undefined;
	const assignmentDescription = [
		evidenceId,
		assignmentNeedsHelp ? assignmentHelpId : undefined,
		globalBlockedDescription,
	]
		.filter(Boolean)
		.join(" ");
	const actionDescription = [evidenceId, globalBlockedDescription].filter(Boolean).join(" ");
	const needsAttention = device.decision === "unresolved";

	return (
		<fieldset
			aria-busy={busy ? "true" : "false"}
			className={`legacy-team-device-row${needsAttention ? " legacy-team-setup-row-needs-attention" : ""}`}
			id={`legacy-team-device-row-${index}`}
			tabIndex={needsAttention ? -1 : undefined}
		>
			<legend>{device.displayName}</legend>
			{needsAttention ? <span className="legacy-team-setup-status">Needs attention</span> : null}
			<div className="small legacy-team-device-evidence" id={evidenceId}>
				<span>
					{device.enabled ? "Current Team device" : "Device no longer active on this Team"}
				</span>
				{existingName ? <span>{assignmentEvidenceText(device, existingName)}</span> : null}
				{!existingName && suggestedName ? <span>Suggested person: {suggestedName}</span> : null}
				<span>Decision: {DECISION_LABELS[device.decision]}</span>
			</div>
			<PersonPicker
				controlId={controlId}
				describedBy={assignmentDescription}
				detail={detail}
				disabled={assignmentControlsBlocked}
				draft={draftIdentityRef}
				newPersonName={newPersonName}
				onDraft={setDraftIdentityRef}
				onNewPersonName={setNewPersonName}
				showUnavailable={assignmentIdentityUnavailable}
			/>
			{notice || assignmentHelp ? (
				<p className="small" id={assignmentHelpId} role={notice ? "alert" : undefined}>
					{notice ?? assignmentHelp}
				</p>
			) : null}
			<div className="legacy-team-device-actions">
				<button
					aria-describedby={assignmentDescription}
					aria-disabled={assignmentBlocked ? "true" : undefined}
					className="settings-button legacy-team-setup-target"
					onClick={() => {
						if (assignmentBlocked) return;
						onAssign(
							device,
							addingPerson
								? { newPersonName: newPersonName.replace(/\s+/gu, " ").trim() }
								: { targetIdentityRef: draftIdentityRef },
						);
					}}
					type="button"
				>
					Save assignment
				</button>
				{device.enabled ? (
					<>
						<button
							aria-describedby={assignmentDescription}
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
							aria-describedby={actionDescription}
							aria-disabled={
								controlsBlocked || !device.actions.exclude.enabled ? "true" : undefined
							}
							className="settings-button legacy-team-setup-target"
							onClick={() => {
								if (!controlsBlocked && device.actions.exclude.enabled) {
									onDecision(device, "excluded");
								}
							}}
							type="button"
						>
							Exclude
						</button>
					</>
				) : (
					<button
						aria-describedby={actionDescription}
						aria-disabled={controlsBlocked || !device.actions.remove.enabled ? "true" : undefined}
						className="settings-button legacy-team-setup-target"
						onClick={() => {
							if (!controlsBlocked && device.actions.remove.enabled) onDecision(device, "removed");
						}}
						type="button"
					>
						Remove
					</button>
				)}
				{device.decision !== "unresolved" ? (
					<button
						aria-describedby={actionDescription}
						aria-disabled={
							controlsBlocked || !device.actions.clearDecision.enabled ? "true" : undefined
						}
						className="settings-button legacy-team-setup-target"
						onClick={() => {
							if (!controlsBlocked && device.actions.clearDecision.enabled) onClear(device);
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
	const devices = orderedSetupDevices(props.detail.devices);
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
				{devices.map((device, index) => (
					<DeviceRow
						{...props}
						busy={props.busyDeviceRefs.has(device.deviceRef)}
						device={device}
						index={index}
						key={device.deviceRef}
					/>
				))}
			</div>
		</section>
	);
}
