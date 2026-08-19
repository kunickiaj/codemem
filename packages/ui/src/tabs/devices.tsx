import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type {
	RecipientPolicyIntentGraphV1,
	RecipientPolicyReconciliationReadState,
	RecipientPolicyReconciliationStatusV1,
} from "../lib/api/sync";
import {
	commitDeviceIdentityBindings,
	DeviceIdentityBindingApiError,
	type DeviceIdentityBindingPreviewRequestV1,
	type DeviceIdentityBindingPreviewV1,
	type DeviceIdentityInventoryItemV1,
	type DeviceIdentityInventoryV1,
	previewDeviceIdentityBindings,
} from "../lib/api/sync";
import {
	deviceIdentityAttentionItems,
	deviceIdentitySetupGate,
} from "../lib/device-identity-inventory";
import { state } from "../lib/state";

export type DeviceAvailabilityState = "available" | "offline" | "unknown";
export type DevicesNavigationTarget = "advanced" | "advanced_sync" | "health" | "sharing";

export interface DeviceAvailabilityInput {
	deviceId: string;
	state: DeviceAvailabilityState;
}

export interface DevicePeerRuntimeMetadataInput {
	deviceId: string;
	runtimeVersion: string | null;
	runtimeVersionObservedAt: string | null;
}

export interface DevicesProjectInput {
	canonicalProjectIdentity: string;
	displayName: string;
}

export interface DevicesRendererOptions {
	loading?: boolean;
	loadError?: boolean;
	refreshError?: boolean;
	inventoryUnavailable?: boolean;
	onNavigate?: (target: DevicesNavigationTarget) => void;
	peerRuntimeMetadata?: DevicePeerRuntimeMetadataInput[];
	inventory?: DeviceIdentityInventoryV1;
	onCommitted?: () => boolean | undefined | Promise<boolean | undefined>;
	previewBindings?: typeof previewDeviceIdentityBindings;
	commitBindings?: typeof commitDeviceIdentityBindings;
}

export interface DeviceProjectProjection {
	canonicalProjectIdentity: string;
	displayName: string;
	state: RecipientPolicyReconciliationReadState;
	statusLabel: string;
	statusCopy: string;
	deliveredCopiesMayRemain: boolean;
}

export interface DeviceProjection {
	deviceId: string;
	displayName: string;
	identityName: string;
	availability: DeviceAvailabilityState;
	availabilityLabel: string;
	isPairedPeer: boolean;
	reportedRuntimeVersion: string | null;
	runtimeVersionObservedAt: string | null;
	directProjects: DeviceProjectProjection[];
	inheritedProjects: DeviceProjectProjection[];
	unavailableProjectCount: number;
	statusState: RecipientPolicyReconciliationReadState | "no_projects";
	statusLabel: string;
	statusCopy: string;
	deliveredCopiesMayRemain: boolean;
	action: { label: string; target: DevicesNavigationTarget } | null;
}

export interface DevicesProjection {
	devices: DeviceProjection[];
	revokedDeviceCount: number;
}

type DeviceActionFocusIdentity = {
	deviceId: string;
	target: DevicesNavigationTarget;
};

const deviceActionFocusIdentities = new WeakMap<HTMLElement, DeviceActionFocusIdentity>();

const STATUS_PRIORITY: Record<RecipientPolicyReconciliationReadState, number> = {
	active: 0,
	verifying: 1,
	pending: 2,
	waiting: 3,
	needs_attention: 4,
};

const PENDING_STATUS = {
	state: "pending",
	label: "Recipient policy pending",
	explanation: "Current access remains in place while this Project is prepared.",
	deliveredCopiesMayRemain: true,
} as const;

const AVAILABILITY_LABELS: Record<DeviceAvailabilityState, string> = {
	available: "Available",
	offline: "Offline",
	unknown: "Availability unknown",
};

function uniqueSorted(values: Iterable<string>): string[] {
	return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function projectStatus(
	projectId: string,
	statusesByProject: Map<string, RecipientPolicyReconciliationStatusV1["items"][number]>,
) {
	return statusesByProject.get(projectId) ?? PENDING_STATUS;
}

function overallStatus(projects: DeviceProjectProjection[]) {
	return projects.reduce<DeviceProjectProjection | null>((current, project) => {
		if (!current || STATUS_PRIORITY[project.state] > STATUS_PRIORITY[current.state]) return project;
		return current;
	}, null);
}

function actionForDevice(
	availability: DeviceAvailabilityState,
	status: RecipientPolicyReconciliationReadState | "no_projects",
): DeviceProjection["action"] {
	if (status === "needs_attention") return { label: "Review sharing", target: "sharing" };
	if (availability !== "available") return { label: "Check device health", target: "health" };
	if (status === "waiting" || status === "pending" || status === "verifying") {
		return { label: "View sharing status", target: "sharing" };
	}
	return null;
}

export function projectDevices(
	intent: RecipientPolicyIntentGraphV1,
	reconciliation: RecipientPolicyReconciliationStatusV1,
	projects: DevicesProjectInput[],
	availabilityInput: DeviceAvailabilityInput[],
	peerRuntimeMetadataInput: DevicePeerRuntimeMetadataInput[] = [],
): DevicesProjection {
	const identityNames = new Map(
		intent.identities
			.filter((item) => item.status === "active" && item.mergedIntoIdentityId === null)
			.map((item) => [item.identityId, item.displayName]),
	);
	const projectNames = new Map(
		projects.map((item) => [item.canonicalProjectIdentity, item.displayName]),
	);
	const availability = new Map(availabilityInput.map((item) => [item.deviceId, item.state]));
	const peerRuntimeMetadata = new Map(
		peerRuntimeMetadataInput.map((item) => [item.deviceId, item]),
	);
	const statuses = new Map(
		reconciliation.items.map((item) => [item.canonicalProjectIdentity, item]),
	);

	const devices = intent.identityDevices
		.filter((device) => device.status === "active" && identityNames.has(device.identityId))
		.map((device): DeviceProjection => {
			const runtimeMetadata = peerRuntimeMetadata.get(device.deviceId);
			const directProjectIds = uniqueSorted(
				intent.projectRecipients
					.filter(
						(item) =>
							item.status === "active" &&
							item.recipientKind === "identity" &&
							item.identityId === device.identityId,
					)
					.map((item) => item.canonicalProjectIdentity),
			);
			const toProject = (projectId: string) => {
				const displayName = projectNames.get(projectId);
				if (!displayName) return null;
				const status = projectStatus(projectId, statuses);
				return {
					canonicalProjectIdentity: projectId,
					displayName,
					state: status.state,
					statusLabel: status.label,
					statusCopy: status.explanation,
					deliveredCopiesMayRemain: status.deliveredCopiesMayRemain,
				} satisfies DeviceProjectProjection;
			};
			const directProjects = directProjectIds.flatMap((projectId) => {
				const project = toProject(projectId);
				return project ? [project] : [];
			});
			// Team eligibility is intentionally absent until this surface receives
			// authoritative effective-device facts rather than membership intent.
			const inheritedProjects: DeviceProjectProjection[] = [];
			const allProjects = [...directProjects, ...inheritedProjects];
			const status = overallStatus(allProjects);
			const deviceAvailability = availability.get(device.deviceId) ?? "unknown";
			return {
				deviceId: device.deviceId,
				displayName: device.displayName,
				identityName: identityNames.get(device.identityId) ?? "Identity unavailable",
				availability: deviceAvailability,
				availabilityLabel: AVAILABILITY_LABELS[deviceAvailability],
				isPairedPeer: runtimeMetadata !== undefined,
				reportedRuntimeVersion: runtimeMetadata?.runtimeVersion ?? null,
				runtimeVersionObservedAt: runtimeMetadata?.runtimeVersionObservedAt ?? null,
				directProjects,
				inheritedProjects,
				unavailableProjectCount: directProjectIds.length - directProjects.length,
				statusState: status?.state ?? "no_projects",
				statusLabel: status?.statusLabel ?? "No directly shared Projects",
				statusCopy:
					status?.statusCopy ??
					"Team access is not shown here without authoritative per-device eligibility.",
				deliveredCopiesMayRemain: allProjects.some((project) => project.deliveredCopiesMayRemain),
				action: actionForDevice(deviceAvailability, status?.state ?? "no_projects"),
			};
		})
		.sort(
			(left, right) =>
				left.displayName.localeCompare(right.displayName) ||
				left.identityName.localeCompare(right.identityName),
		);
	return {
		devices,
		revokedDeviceCount: intent.identityDevices.filter(
			(device) => device.status === "revoked" && identityNames.has(device.identityId),
		).length,
	};
}

function ProjectList({ empty, projects }: { empty: string; projects: DeviceProjectProjection[] }) {
	if (projects.length === 0) return <p className="small">{empty}</p>;
	return (
		<ul>
			{projects.map((project) => (
				<li key={project.canonicalProjectIdentity}>
					<strong>{project.displayName}</strong>
					<span className="small">
						{" "}
						— {project.statusLabel}. {project.statusCopy}
					</span>
				</li>
			))}
		</ul>
	);
}

interface SetupChoice {
	targetIdentityId: string;
	confirmed: boolean;
	selected: boolean;
	explicit: boolean;
	itemSignature: string;
}

export function deviceIdentitySetupError(error: unknown): string {
	if (!(error instanceof DeviceIdentityBindingApiError)) {
		return "Identity setup is unavailable. Refresh Devices and try again.";
	}
	const exactMessages: Record<string, string> = {
		binding_preview_busy: "Identity setup is busy. Wait a moment, then retry.",
		binding_commit_busy: "Identity setup is busy. Wait a moment, then retry.",
		binding_evidence_stale:
			"Device information changed after review. Refresh Devices, review the current details, and try again.",
		binding_retry_stale:
			"Device information changed after review. Refresh Devices, review the current details, and try again.",
		binding_rebind_stale:
			"Device information changed after review. Refresh Devices, review the current details, and try again.",
		binding_unchanged_stale:
			"Device information changed after review. Refresh Devices, review the current details, and try again.",
		binding_write_stale:
			"Device information changed after review. Refresh Devices, review the current details, and try again.",
		device_pairing_required: "Pair this device before assigning an Identity.",
		device_rebind_confirmation_required:
			"Reassignment requires a separate confirmation of the previous and target Identities.",
		device_inventory_incomplete:
			"The complete device inventory is unavailable. Refresh after coordinator evidence is available.",
		device_inventory_truncated:
			"The complete device inventory is unavailable. Refresh after coordinator evidence is available.",
		binding_write_conflict:
			"Device evidence conflicts with this setup. Refresh Devices or use Advanced review.",
		binding_commit_conflict:
			"Device evidence conflicts with this setup. Refresh Devices or use Advanced review.",
		device_evidence_conflict:
			"Device evidence conflicts with this setup. Refresh Devices or use Advanced review.",
		target_identity_unavailable:
			"A selected device or Identity is no longer available. Refresh Devices and choose again.",
		device_unavailable:
			"A selected device or Identity is no longer available. Refresh Devices and choose again.",
		device_not_found:
			"A selected device or Identity is no longer available. Refresh Devices and choose again.",
		deciding_identity_unavailable:
			"The deciding Identity is unavailable. Open Identity administration to restore or replace it, then try again.",
	};
	const exactMessage = exactMessages[error.errorCode];
	if (exactMessage) return exactMessage;
	if (error.statusCode === 503) return "Identity setup is busy. Wait a moment, then retry.";
	if (error.statusCode === 409) {
		return "Device evidence conflicts with this setup. Refresh Devices or use Advanced review.";
	}
	if (error.statusCode === 404) {
		return "A selected device or Identity is no longer available. Refresh Devices and choose again.";
	}
	return "Identity setup could not be completed. Refresh Devices and try again.";
}

function newSetupChoice(
	item: DeviceIdentityInventoryItemV1,
	identityIds: Set<string>,
): SetupChoice {
	return {
		targetIdentityId:
			item.state === "setup_required" &&
			item.suggestedIdentityId &&
			identityIds.has(item.suggestedIdentityId)
				? item.suggestedIdentityId
				: "",
		confirmed: false,
		selected: false,
		explicit: false,
		itemSignature: setupItemSignature(item),
	};
}

function setupItemSignature(item: DeviceIdentityInventoryItemV1): string {
	return JSON.stringify({
		deviceId: item.deviceId,
		evidenceDeviceIds: [...item.evidenceDeviceIds].sort(),
		state: item.state,
		identityId: item.identityId,
		suggestedIdentityId: item.suggestedIdentityId,
		validatedFingerprint: item.validatedFingerprint,
		isLocal: item.isLocal,
		sources: [...item.sources].sort(),
		conflictCodes: [...item.conflictCodes].sort(),
	});
}

function previewMatchesBindings(
	preview: DeviceIdentityBindingPreviewV1,
	request: DeviceIdentityBindingPreviewRequestV1,
	items: DeviceIdentityInventoryItemV1[],
	expectedAction: "bind" | "rebind",
): boolean {
	if (preview.status !== "ready" || preview.outcomes.length !== request.bindings.length) {
		return false;
	}
	const matchedOutcomes = new Set<number>();
	return request.bindings.every((binding) => {
		const item = items.find((candidate) => candidate.deviceId === binding.deviceId);
		const outcomeIndex = preview.outcomes.findIndex(
			(outcome, index) =>
				!matchedOutcomes.has(index) &&
				item?.evidenceDeviceIds.includes(outcome.deviceId) === true &&
				outcome.targetIdentityId === binding.targetIdentityId &&
				outcome.action === expectedAction,
		);
		if (outcomeIndex < 0) return false;
		matchedOutcomes.add(outcomeIndex);
		return true;
	});
}

const DEVICE_COMMIT_STATUS_ID = "devices-commit-status";

function setDeviceCommitStatus(message: string): void {
	const status = document.getElementById(DEVICE_COMMIT_STATUS_ID);
	if (status) status.textContent = message;
}

function SetupWorkflow({
	intent,
	inventory,
	items,
	options,
}: {
	intent: RecipientPolicyIntentGraphV1;
	inventory: DeviceIdentityInventoryV1;
	items: DeviceIdentityInventoryItemV1[];
	options: DevicesRendererOptions;
}) {
	const identities = intent.identities.filter(
		(identity) => identity.status === "active" && identity.mergedIntoIdentityId === null,
	);
	const identityNames = new Map(
		identities.map((identity) => [identity.identityId, identity.displayName]),
	);
	const identityIds = new Set(identityNames.keys());
	const [choices, setChoices] = useState<Record<string, SetupChoice>>(() =>
		Object.fromEntries(items.map((item) => [item.deviceId, newSetupChoice(item, identityIds)])),
	);
	const [reviewed, setReviewed] = useState<{
		preview: DeviceIdentityBindingPreviewV1;
		request: DeviceIdentityBindingPreviewRequestV1;
	} | null>(null);
	const [reviewConfirmed, setReviewConfirmed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [errorMessage, setErrorMessage] = useState("");
	const reviewHeading = useRef<HTMLHeadingElement>(null);
	const reviewRevision = useRef(0);
	const previewApi = options.previewBindings ?? previewDeviceIdentityBindings;
	const commitApi = options.commitBindings ?? commitDeviceIdentityBindings;
	const inventoryUnavailable = options.inventoryUnavailable === true;
	const previewReady =
		reviewed !== null && previewMatchesBindings(reviewed.preview, reviewed.request, items, "bind");
	const selectedItems = useMemo(
		() =>
			items.filter((item) => item.state === "setup_required" && choices[item.deviceId]?.selected),
		[choices, items],
	);
	const inventorySignature = JSON.stringify({
		items: inventory.items.map(setupItemSignature),
		coordinatorEvidence: inventory.coordinatorEvidence,
		truncated: inventory.truncated,
	});
	const identitySignature = identities
		.map((identity) => `${identity.identityId}:${identity.displayName}`)
		.sort()
		.join("|");

	useEffect(() => {
		if (reviewed) reviewHeading.current?.focus();
	}, [reviewed]);

	useEffect(() => {
		reviewRevision.current += 1;
		setBusy(false);
		setChoices((current) =>
			Object.fromEntries(
				items.map((item) => {
					const existing = current[item.deviceId];
					if (!existing) return [item.deviceId, newSetupChoice(item, identityIds)];
					if (item.state !== "setup_required") {
						return [item.deviceId, newSetupChoice(item, identityIds)];
					}
					const targetStillActive =
						existing.targetIdentityId !== "" && identityIds.has(existing.targetIdentityId);
					if (
						existing.itemSignature === setupItemSignature(item) &&
						existing.explicit &&
						targetStillActive
					) {
						return [item.deviceId, existing];
					}
					if (existing.explicit && targetStillActive) {
						return [
							item.deviceId,
							{
								...existing,
								confirmed: false,
								selected: false,
								itemSignature: setupItemSignature(item),
							},
						];
					}
					return [item.deviceId, newSetupChoice(item, identityIds)];
				}),
			),
		);
		setReviewed(null);
		setReviewConfirmed(false);
	}, [inventorySignature, identitySignature]);

	const update = (deviceId: string, changes: Partial<SetupChoice>) => {
		reviewRevision.current += 1;
		setBusy(false);
		setChoices((current) => ({
			...current,
			[deviceId]: { ...current[deviceId], ...changes } as SetupChoice,
		}));
		setReviewed(null);
		setReviewConfirmed(false);
		setErrorMessage("");
		setDeviceCommitStatus("");
	};

	const request = (
		selected: DeviceIdentityInventoryItemV1[],
	): DeviceIdentityBindingPreviewRequestV1 => ({
		bindings: selected.map((item) => {
			const choice = choices[item.deviceId];
			return {
				deviceId: item.deviceId,
				targetIdentityId: choice?.targetIdentityId ?? "",
				confirmed: choice?.confirmed === true,
			};
		}),
	});

	const review = async (selected: DeviceIdentityInventoryItemV1[]) => {
		if (inventoryUnavailable) {
			setErrorMessage("Refresh device ownership information before reviewing Identity setup.");
			return;
		}
		if (selected.some((item) => item.state !== "setup_required")) {
			setErrorMessage("Only devices that require Identity setup can be reviewed here.");
			return;
		}
		const blocked = selected.find((item) => deviceIdentitySetupGate(inventory, item).blocked);
		if (blocked) {
			setErrorMessage(
				deviceIdentitySetupGate(inventory, blocked).recovery ?? "Identity setup is unavailable.",
			);
			return;
		}
		if (
			selected.length === 0 ||
			selected.some((item) => {
				const choice = choices[item.deviceId];
				return !choice?.targetIdentityId || !choice.confirmed;
			})
		) {
			setErrorMessage(
				"Choose and explicitly confirm an Identity for every selected device before review.",
			);
			return;
		}
		setBusy(true);
		setErrorMessage("");
		setDeviceCommitStatus("");
		const revision = reviewRevision.current;
		try {
			const previewRequest = request(selected);
			const preview = await previewApi(previewRequest);
			if (revision === reviewRevision.current) {
				if (!previewMatchesBindings(preview, previewRequest, selected, "bind")) {
					setErrorMessage("Identity setup preview was incomplete. Refresh and try again.");
				} else {
					setReviewed({ preview, request: previewRequest });
				}
			}
		} catch (error) {
			if (revision === reviewRevision.current) setErrorMessage(deviceIdentitySetupError(error));
		}
		if (revision === reviewRevision.current) setBusy(false);
	};

	const commit = async () => {
		if (!reviewed || !reviewConfirmed || inventoryUnavailable || !previewReady) return;
		setBusy(true);
		setErrorMessage("");
		try {
			await commitApi({
				...reviewed.request,
				reviewedInventoryDigest: reviewed.preview.reviewedInventoryDigest,
			});
			setReviewed(null);
			setReviewConfirmed(false);
			setDeviceCommitStatus("Identity setup completed.");
			const refreshed = await options.onCommitted?.();
			setDeviceCommitStatus(
				refreshed === false
					? "Identity setup completed, but refreshing Devices and Sharing failed. Refresh to see current state."
					: refreshed === true
						? "Identity setup completed. Devices and Sharing were refreshed."
						: "Identity setup completed.",
			);
			document.getElementById("devices-heading")?.focus();
		} catch (error) {
			setErrorMessage(deviceIdentitySetupError(error));
		}
		setBusy(false);
	};

	const setupRequired = items.filter((item) => item.state === "setup_required");
	if (items.length === 0) return null;
	return (
		<>
			{errorMessage ? <p role="alert">{errorMessage}</p> : null}
			{setupRequired.length > 1 ? (
				<div className="device-identity-setup-summary">
					<strong>{setupRequired.length.toLocaleString()} devices need Identity setup</strong>
					<button
						className="settings-button"
						disabled={busy || inventoryUnavailable || selectedItems.length === 0}
						onClick={() => void review(selectedItems)}
						type="button"
					>
						Review {selectedItems.length.toLocaleString()} selected
					</button>
				</div>
			) : null}
			<ul className="recipient-policy-sharing-grid recipient-policy-sharing-responsive-grid">
				{items.map((item, index) => {
					const choice = choices[item.deviceId];
					const gate = deviceIdentitySetupGate(inventory, item);
					const setupBlocked = gate.blocked || inventoryUnavailable;
					const targetIdentity = choice?.targetIdentityId
						? (identityNames.get(choice.targetIdentityId) ?? "Unavailable Identity")
						: "";
					const titleId = `device-inventory-title-${index}`;
					return (
						<li key={item.deviceId}>
							<article
								aria-labelledby={titleId}
								className="peer-card peer-card--padded recipient-policy-sharing-card device-identity-setup-card"
								id={`device-identity-card-${item.deviceId}`}
								tabIndex={-1}
							>
								<div className="peer-title recipient-policy-sharing-card-title">
									<h3 id={titleId}>
										{item.displayName}
										{item.isLocal ? " (this device)" : ""}
									</h3>
									<span className="badge actor-badge">
										{item.state === "setup_required"
											? "Setup required"
											: item.state === "pairing_required"
												? "Pairing required"
												: item.state === "conflicted"
													? "Review required"
													: "Configured"}
									</span>
								</div>
								{item.state === "setup_required" ? (
									<fieldset>
										<legend>Assign an existing Identity</legend>
										{identities.length === 0 ? (
											<>
												<p>
													No active Identity is available. Create or restore an Identity before
													setup.
												</p>
												<button
													className="settings-button"
													onClick={() => options.onNavigate?.("advanced_sync")}
													type="button"
												>
													Open Identity administration
												</button>
											</>
										) : null}
										<label>
											<input
												checked={choice?.selected ?? false}
												disabled={setupBlocked}
												onInput={(event) =>
													update(item.deviceId, { selected: event.currentTarget.checked })
												}
												type="checkbox"
											/>{" "}
											Include in reviewed setup
										</label>
										<label htmlFor={`${titleId}-identity`}>Identity</label>
										<select
											disabled={setupBlocked}
											id={`${titleId}-identity`}
											onInput={(event) =>
												update(item.deviceId, {
													targetIdentityId: event.currentTarget.value,
													confirmed: false,
													explicit: true,
												})
											}
											value={choice?.targetIdentityId ?? ""}
										>
											<option value="">Choose Identity…</option>
											{identities.map((identity) => (
												<option key={identity.identityId} value={identity.identityId}>
													{identity.displayName}
												</option>
											))}
										</select>
										{item.suggestedIdentityId && identityNames.has(item.suggestedIdentityId) ? (
											<p className="small">
												Suggested from historical device information. Confirm it before setup.
											</p>
										) : null}
										<label>
											<input
												checked={choice?.confirmed ?? false}
												disabled={setupBlocked || !choice?.targetIdentityId}
												onInput={(event) =>
													update(item.deviceId, {
														confirmed: event.currentTarget.checked,
														selected: event.currentTarget.checked || choice?.selected === true,
														explicit: event.currentTarget.checked || choice?.explicit === true,
													})
												}
												type="checkbox"
											/>{" "}
											Confirm {item.displayName} belongs to{" "}
											{targetIdentity || "the selected Identity"}
										</label>
										<button
											className="settings-button"
											disabled={busy || setupBlocked}
											onClick={() => void review([item])}
											type="button"
										>
											Review setup
										</button>
										{gate.recovery ? <p className="small">{gate.recovery}</p> : null}
									</fieldset>
								) : item.state === "pairing_required" ? (
									<>
										<p>
											Pair this device first. Pairing establishes trust but does not choose its
											Identity.
										</p>
										<button
											className="settings-button"
											onClick={() => options.onNavigate?.("advanced_sync")}
											type="button"
										>
											Go to pairing
										</button>
									</>
								) : item.state === "conflicted" ? (
									<>
										<p>
											Device evidence conflicts. Review and repair it before assigning an Identity.
										</p>
										<button
											className="settings-button"
											onClick={() => options.onNavigate?.("advanced_sync")}
											type="button"
										>
											Open Advanced review
										</button>
									</>
								) : null}
							</article>
						</li>
					);
				})}
			</ul>
			{reviewed ? (
				<section
					aria-labelledby="device-identity-review-heading"
					className="peer-card peer-card--padded device-identity-review-panel"
				>
					<h3 id="device-identity-review-heading" ref={reviewHeading} tabIndex={-1}>
						Review Identity setup
					</h3>
					<ul>
						{reviewed.preview.outcomes.map((outcome) => (
							<li key={outcome.deviceId}>
								<strong>{outcome.displayName}:</strong>{" "}
								{outcome.previousIdentityId
									? (identityNames.get(outcome.previousIdentityId) ?? "Unavailable Identity")
									: "No Identity"}{" "}
								→ {identityNames.get(outcome.targetIdentityId) ?? "Unavailable Identity"}
							</li>
						))}
					</ul>
					<p>
						Identity setup records device ownership only. It does not grant Projects, Team
						membership, or sync access.
					</p>
					<label>
						<input
							checked={reviewConfirmed}
							disabled={inventoryUnavailable}
							onInput={(event) => setReviewConfirmed(event.currentTarget.checked)}
							type="checkbox"
						/>{" "}
						I reviewed every device and target Identity
					</label>
					<div className="peer-actions">
						<button
							className="settings-button"
							disabled={busy}
							onClick={() => {
								setReviewed(null);
								setReviewConfirmed(false);
							}}
							type="button"
						>
							Back
						</button>
						<button
							className="settings-button sync-dialog-confirm"
							disabled={busy || inventoryUnavailable || !reviewConfirmed || !previewReady}
							onClick={() => void commit()}
							type="button"
						>
							Confirm Identity setup
						</button>
					</div>
				</section>
			) : null}
		</>
	);
}

function ConfiguredRebind({
	intent,
	inventory,
	item,
	options,
	previousIdentityName,
}: {
	intent: RecipientPolicyIntentGraphV1;
	inventory: DeviceIdentityInventoryV1;
	item: DeviceIdentityInventoryItemV1;
	options: DevicesRendererOptions;
	previousIdentityName: string;
}) {
	const identities = intent.identities.filter(
		(identity) =>
			identity.status === "active" &&
			identity.mergedIntoIdentityId === null &&
			identity.identityId !== item.identityId,
	);
	const [open, setOpen] = useState(false);
	const [targetIdentityId, setTargetIdentityId] = useState("");
	const [confirmed, setConfirmed] = useState(false);
	const [reviewed, setReviewed] = useState<{
		preview: DeviceIdentityBindingPreviewV1;
		request: DeviceIdentityBindingPreviewRequestV1;
	} | null>(null);
	const [reviewConfirmed, setReviewConfirmed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const reviewRevision = useRef(0);
	const previousIdentity = previousIdentityName;
	const identityNames = new Map(
		intent.identities.map((identity) => [identity.identityId, identity.displayName]),
	);
	const reviewedOutcome =
		reviewed?.preview.status === "ready" && reviewed.preview.outcomes.length === 1
			? reviewed.preview.outcomes[0]
			: null;
	const previewReady =
		reviewed !== null &&
		previewMatchesBindings(reviewed.preview, reviewed.request, [item], "rebind");
	const gate = deviceIdentitySetupGate(inventory, item);
	const rebindBlocked = gate.blocked || options.inventoryUnavailable === true;
	const triggerId = `configured-rebind-trigger-${item.deviceId}`;
	const targetIdentity =
		identities.find((identity) => identity.identityId === targetIdentityId)?.displayName ?? "";
	const identitySignature = identities
		.map((identity) => identity.identityId)
		.sort()
		.join("|");
	const itemSignature = setupItemSignature(item);
	useEffect(() => {
		reviewRevision.current += 1;
		setBusy(false);
		if (
			targetIdentityId &&
			!identities.some((identity) => identity.identityId === targetIdentityId)
		) {
			setTargetIdentityId("");
			setConfirmed(false);
		}
		setReviewed(null);
		setReviewConfirmed(false);
	}, [identitySignature, itemSignature]);
	const review = async () => {
		if (rebindBlocked) {
			setError(gate.recovery ?? "Identity reassignment is unavailable.");
			return;
		}
		if (!targetIdentityId || !confirmed) {
			setError("Choose a target Identity and confirm the reassignment before review.");
			return;
		}
		setBusy(true);
		setError("");
		setDeviceCommitStatus("");
		const revision = reviewRevision.current;
		try {
			const request: DeviceIdentityBindingPreviewRequestV1 = {
				bindings: [{ deviceId: item.deviceId, targetIdentityId, confirmed, allowRebind: true }],
			};
			const preview = await (options.previewBindings ?? previewDeviceIdentityBindings)(request);
			if (revision === reviewRevision.current) {
				if (preview.status !== "ready") {
					setError(
						deviceIdentitySetupError(
							new DeviceIdentityBindingApiError(
								409,
								preview.errorCode ?? "binding_preview_unavailable",
								preview,
							),
						),
					);
				} else if (!previewMatchesBindings(preview, request, [item], "rebind")) {
					setError("Identity reassignment preview was incomplete. Refresh and try again.");
				} else {
					setReviewed({ preview, request });
				}
			}
		} catch (caught) {
			if (revision === reviewRevision.current) setError(deviceIdentitySetupError(caught));
		}
		if (revision === reviewRevision.current) setBusy(false);
	};
	const commit = async () => {
		if (!reviewed || !reviewConfirmed || rebindBlocked || !previewReady) return;
		setBusy(true);
		setError("");
		try {
			await (options.commitBindings ?? commitDeviceIdentityBindings)({
				...reviewed.request,
				reviewedInventoryDigest: reviewed.preview.reviewedInventoryDigest,
			});
			setOpen(false);
			setTargetIdentityId("");
			setConfirmed(false);
			setReviewed(null);
			setReviewConfirmed(false);
			setDeviceCommitStatus("Identity reassignment completed.");
			const refreshed = await options.onCommitted?.();
			setDeviceCommitStatus(
				refreshed === false
					? "Identity reassignment completed, but refreshing Devices and Sharing failed. Refresh to see current state."
					: refreshed === true
						? "Identity reassignment completed. Devices and Sharing were refreshed."
						: "Identity reassignment completed.",
			);
			(document.getElementById(triggerId) ?? document.getElementById("devices-heading"))?.focus();
		} catch (caught) {
			setError(deviceIdentitySetupError(caught));
		}
		setBusy(false);
	};
	return (
		<div className="device-identity-rebind">
			<button
				aria-expanded={open}
				className="settings-button"
				disabled={rebindBlocked}
				id={triggerId}
				onClick={() => {
					reviewRevision.current += 1;
					setBusy(false);
					setOpen(!open);
					setReviewed(null);
					setReviewConfirmed(false);
					setError("");
					setDeviceCommitStatus("");
				}}
				type="button"
			>
				Change Identity…
			</button>
			{gate.recovery ? <p className="small">{gate.recovery}</p> : null}
			{open ? (
				<fieldset>
					<legend>Reassign this configured device</legend>
					<p>
						<strong>Suggested current Identity (unconfirmed):</strong> {previousIdentity}
					</p>
					<label htmlFor={`configured-rebind-${item.deviceId}`}>Target Identity</label>
					<select
						disabled={rebindBlocked}
						id={`configured-rebind-${item.deviceId}`}
						onInput={(event) => {
							reviewRevision.current += 1;
							setBusy(false);
							setTargetIdentityId(event.currentTarget.value);
							setConfirmed(false);
							setReviewed(null);
							setReviewConfirmed(false);
						}}
						value={targetIdentityId}
					>
						<option value="">Choose a different Identity…</option>
						{identities.map((identity) => (
							<option key={identity.identityId} value={identity.identityId}>
								{identity.displayName}
							</option>
						))}
					</select>
					<label>
						<input
							checked={confirmed}
							disabled={rebindBlocked || !targetIdentityId}
							onInput={(event) => {
								reviewRevision.current += 1;
								setBusy(false);
								setConfirmed(event.currentTarget.checked);
								setReviewed(null);
								setReviewConfirmed(false);
							}}
							type="checkbox"
						/>{" "}
						Confirm reassigning {item.displayName} to {targetIdentity || "the selected Identity"}
					</label>
					<button
						className="settings-button"
						disabled={busy || rebindBlocked}
						onClick={() => void review()}
						type="button"
					>
						Review reassignment
					</button>
					{reviewed ? (
						<div className="device-identity-rebind-review">
							<h4>Review reassignment</h4>
							<p>
								{reviewedOutcome?.displayName}:{" "}
								{reviewedOutcome?.previousIdentityId
									? (identityNames.get(reviewedOutcome.previousIdentityId) ??
										"Unavailable Identity")
									: "No Identity"}{" "}
								→{" "}
								{identityNames.get(reviewedOutcome?.targetIdentityId ?? "") ??
									"Unavailable Identity"}
							</p>
							<p className="small">
								This changes device ownership only. It does not grant Projects, Team membership, or
								sync access.
							</p>
							<label>
								<input
									checked={reviewConfirmed}
									disabled={rebindBlocked}
									onInput={(event) => setReviewConfirmed(event.currentTarget.checked)}
									type="checkbox"
								/>{" "}
								I reviewed the previous and target Identities
							</label>
							<button
								className="settings-button sync-dialog-confirm"
								disabled={busy || rebindBlocked || !reviewConfirmed || !previewReady}
								onClick={() => void commit()}
								type="button"
							>
								Reassign Identity
							</button>
						</div>
					) : null}
					{error ? (
						<p aria-live="assertive" role="alert">
							{error}
						</p>
					) : null}
				</fieldset>
			) : null}
		</div>
	);
}

function DevicesView({
	intent,
	options,
	projection,
}: {
	intent: RecipientPolicyIntentGraphV1;
	options: DevicesRendererOptions;
	projection: DevicesProjection;
}) {
	if (options.loading) {
		return (
			<p aria-live="polite" className="small" role="status">
				Loading Devices…
			</p>
		);
	}
	if (options.loadError) {
		return (
			<p aria-live="assertive" role="alert">
				Devices are unavailable. Refresh and try again.
			</p>
		);
	}
	const refreshError = options.refreshError ? (
		<p aria-live="assertive" role="alert">
			Refresh failed; showing previous device information.
		</p>
	) : null;
	const visibleProjectedDevices = projection.devices.filter(
		(device) =>
			!options.inventory?.items.some(
				(item) => item.state !== "configured" && item.evidenceDeviceIds.includes(device.deviceId),
			),
	);
	const projectedDeviceIds = new Set(visibleProjectedDevices.map((device) => device.deviceId));
	const inventoryUnavailable = options.inventoryUnavailable ? (
		<p aria-live="polite" className="small" role="status">
			Device ownership information is temporarily unavailable. Existing device details remain
			visible, but Identity setup is disabled until a refresh succeeds.
		</p>
	) : null;
	const setupItems = deviceIdentityAttentionItems(options.inventory);
	const configuredFallbackItems =
		options.inventory?.items.filter(
			(item) =>
				item.state === "configured" &&
				!item.evidenceDeviceIds.some((deviceId) => projectedDeviceIds.has(deviceId)),
		) ?? [];
	const configuredFallbackWorkflow = options.inventory ? (
		<ul className="recipient-policy-sharing-grid recipient-policy-sharing-responsive-grid">
			{configuredFallbackItems.map((item, index) => {
				const titleId = `configured-inventory-title-${index}`;
				const previousIdentityName =
					intent.identities.find((identity) => identity.identityId === item.identityId)
						?.displayName ?? "Unavailable Identity";
				return (
					<li key={item.deviceId}>
						<article
							aria-labelledby={titleId}
							className="peer-card peer-card--padded recipient-policy-sharing-card"
							id={`device-identity-card-${item.deviceId}`}
							tabIndex={-1}
						>
							<div className="peer-title recipient-policy-sharing-card-title">
								<h3 id={titleId}>{item.displayName}</h3>
								<span className="badge actor-badge">Configured · Availability unknown</span>
							</div>
							<p>
								<strong>Owning Identity:</strong> {previousIdentityName}
							</p>
							<ConfiguredRebind
								intent={intent}
								inventory={options.inventory}
								item={item}
								options={options}
								previousIdentityName={previousIdentityName}
							/>
						</article>
					</li>
				);
			})}
		</ul>
	) : null;
	const inventoryWorkflow = options.inventory ? (
		<>
			{options.inventory.truncated ? (
				<p aria-live="assertive" role="alert">
					The device inventory is incomplete. Identity setup is unavailable until a complete refresh
					succeeds.
				</p>
			) : null}
			{options.inventory.coordinatorEvidence.availability === "unavailable" ? (
				<p className="small" role="status">
					Coordinator device information is temporarily unavailable. Local devices remain visible,
					but some setup actions may require a refresh.
				</p>
			) : null}
			<SetupWorkflow
				intent={intent}
				inventory={options.inventory}
				items={setupItems}
				options={options}
			/>
		</>
	) : null;
	if (visibleProjectedDevices.length === 0) {
		return (
			<>
				{refreshError}
				{inventoryUnavailable}
				{inventoryWorkflow}
				{configuredFallbackWorkflow}
				<p className="small" role="status">
					{configuredFallbackItems.length > 0
						? "No additional active devices are registered."
						: setupItems.length > 0
							? "No configured devices are registered."
							: "No active devices are registered."}
					{projection.revokedDeviceCount > 0
						? ` ${projection.revokedDeviceCount.toLocaleString()} revoked ${projection.revokedDeviceCount === 1 ? "device is" : "devices are"} not shown.`
						: ""}
				</p>
			</>
		);
	}
	return (
		<>
			{refreshError}
			{inventoryUnavailable}
			{inventoryWorkflow}
			{configuredFallbackWorkflow}
			<ul className="recipient-policy-sharing-grid recipient-policy-sharing-responsive-grid">
				{visibleProjectedDevices.map((device, index) => {
					const titleId = `devices-card-title-${index}`;
					const action = device.action;
					const matchedInventoryItem = options.inventory?.items.find(
						(item) =>
							item.state === "configured" && item.evidenceDeviceIds.includes(device.deviceId),
					);
					const inventoryItem = matchedInventoryItem;
					return (
						<li key={device.deviceId}>
							<article
								aria-labelledby={titleId}
								className="peer-card peer-card--padded recipient-policy-sharing-card"
								id={`device-identity-card-${device.deviceId}`}
								tabIndex={-1}
							>
								<div className="peer-title recipient-policy-sharing-card-title">
									<h3 id={titleId}>{device.displayName}</h3>
									<span className="badge actor-badge">
										{options.inventoryUnavailable ? "Device" : "Configured"} ·{" "}
										{device.availabilityLabel}
									</span>
								</div>
								<dl className="recipient-policy-sharing-details">
									<div>
										<dt>Owning Identity</dt>
										<dd>{device.identityName}</dd>
									</div>
									<div>
										<dt>Availability</dt>
										<dd>{device.availabilityLabel}</dd>
									</div>
									{device.isPairedPeer ? (
										<div>
											<dt>Codemem version</dt>
											<dd>{device.reportedRuntimeVersion ?? "Not reported"}</dd>
										</div>
									) : null}
									<div>
										<dt>Sharing status</dt>
										<dd>
											<strong>{device.statusLabel}</strong> — {device.statusCopy}
										</dd>
									</div>
								</dl>
								<section aria-labelledby={`${titleId}-direct`}>
									<h4 id={`${titleId}-direct`}>Direct Projects</h4>
									<ProjectList
										empty="No Projects are shared directly."
										projects={device.directProjects}
									/>
								</section>
								<section aria-labelledby={`${titleId}-teams`}>
									<h4 id={`${titleId}-teams`}>Projects through Teams</h4>
									<ProjectList
										empty="Per-device Team access is not shown because Team membership alone does not prove this device receives the Team’s Projects."
										projects={device.inheritedProjects}
									/>
								</section>
								{device.unavailableProjectCount > 0 ? (
									<p className="small" role="status">
										Some Project names are unavailable and are not shown.
									</p>
								) : null}
								{device.deliveredCopiesMayRemain ? (
									<p className="small">
										<strong>Delivered copies:</strong> Changing access stops future delivery, but
										copies already delivered may remain on this device or in backups.
									</p>
								) : null}
								{action && options.onNavigate ? (
									<button
										aria-label={`${action.label} for ${device.displayName}`}
										className="settings-button recipient-policy-sharing-target-24"
										onClick={() => options.onNavigate?.(action.target)}
										ref={(element) => {
											if (element) {
												deviceActionFocusIdentities.set(element, {
													deviceId: device.deviceId,
													target: action.target,
												});
											}
										}}
										type="button"
									>
										{action.label}
									</button>
								) : null}
								{inventoryItem && options.inventory ? (
									<ConfiguredRebind
										intent={intent}
										inventory={options.inventory}
										item={inventoryItem}
										options={options}
										previousIdentityName={device.identityName}
									/>
								) : null}
							</article>
						</li>
					);
				})}
			</ul>
			{projection.revokedDeviceCount > 0 ? (
				<p className="small" role="status">
					{projection.revokedDeviceCount.toLocaleString()} revoked{" "}
					{projection.revokedDeviceCount === 1 ? "device is" : "devices are"} not included in the
					active list.
				</p>
			) : null}
		</>
	);
}

export function mountDevices(
	mount: HTMLElement,
	intent: RecipientPolicyIntentGraphV1,
	reconciliation: RecipientPolicyReconciliationStatusV1,
	projects: DevicesProjectInput[],
	availability: DeviceAvailabilityInput[],
	options: DevicesRendererOptions = {},
): void {
	const focusedElement = document.activeElement;
	const focusedAction =
		focusedElement instanceof HTMLElement && mount.contains(focusedElement)
			? deviceActionFocusIdentities.get(focusedElement)
			: undefined;
	const projection = projectDevices(
		intent,
		reconciliation,
		projects,
		availability,
		options.peerRuntimeMetadata,
	);
	render(
		<section
			aria-labelledby="devices-heading"
			className="recipient-policy-sharing recipient-policy-sharing-responsive-surface"
		>
			<div className="recipient-policy-sharing-header">
				<h2 id="devices-heading" tabIndex={-1}>
					Devices
				</h2>
				<p className="small">
					See where Codemem runs and which Projects each active device receives.
				</p>
			</div>
			<DevicesView intent={intent} options={options} projection={projection} />
			<p aria-live="polite" id={DEVICE_COMMIT_STATUS_ID} role="status" />
		</section>,
		mount,
	);
	setDeviceCommitStatus("");
	if (!options.loading && state.pendingDeviceIdentityFocus !== undefined) {
		const deviceId = state.pendingDeviceIdentityFocus;
		const inventoryItem = options.inventory?.items.find(
			(item) => item.deviceId === deviceId || item.evidenceDeviceIds.includes(deviceId ?? ""),
		);
		const target =
			(deviceId ? document.getElementById(`device-identity-card-${deviceId}`) : null) ??
			(inventoryItem
				? document.getElementById(`device-identity-card-${inventoryItem.deviceId}`)
				: null) ??
			document.getElementById("device-identity-review-heading");
		if (target) {
			state.pendingDeviceIdentityFocus = undefined;
			target.focus();
			return;
		} else if (!options.inventoryUnavailable) {
			state.pendingDeviceIdentityFocus = undefined;
			(
				document.getElementById("devices-heading") ?? document.getElementById("tabBtn-devices")
			)?.focus();
			return;
		}
	}
	if (!focusedAction) return;
	const matchingAction = [...mount.querySelectorAll<HTMLElement>("button")].find((element) => {
		const identity = deviceActionFocusIdentities.get(element);
		return (
			identity?.deviceId === focusedAction.deviceId && identity.target === focusedAction.target
		);
	});
	(matchingAction ?? document.getElementById("tabBtn-devices"))?.focus();
}
