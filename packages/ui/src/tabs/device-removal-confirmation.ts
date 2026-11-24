import { fetchJson, payloadError } from "../lib/api/internal";
import { openSyncConfirmDialog } from "./sync/sync-dialogs";

export interface DeviceRemovalPreview {
	device_id: string;
	rejoin: "invitation" | "sign_in" | "none";
	expected_digest: string;
	key_id: string | null;
	coordinator_origin: string;
	older_device_names?: string[];
}

interface LocalRemovalPreview {
	mode: "local" | "already_removed";
	device_id: string;
	expected_digest: string;
}

export interface DeviceRemovalConfirmationDependencies {
	preview: (deviceId: string) => Promise<unknown>;
	confirm: typeof openSyncConfirmDialog;
}

export class DeviceRemovalPreviewError extends Error {
	readonly code = "device_removal_preview_invalid";

	constructor() {
		super("The device removal preview is invalid.");
		this.name = "DeviceRemovalPreviewError";
	}
}

function isCoordinatorOrigin(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value;
	} catch {
		return false;
	}
}

function validatePreview(
	value: unknown,
	deviceId: string,
): DeviceRemovalPreview | LocalRemovalPreview {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new DeviceRemovalPreviewError();
	}
	const preview = value as Record<string, unknown>;
	if (preview.mode === "local" || preview.mode === "already_removed") {
		if (
			preview.device_id !== deviceId ||
			typeof preview.expected_digest !== "string" ||
			!/^[a-f0-9]{64}$/u.test(preview.expected_digest)
		)
			throw new DeviceRemovalPreviewError();
		return { mode: preview.mode, device_id: deviceId, expected_digest: preview.expected_digest };
	}
	if (
		preview.device_id !== deviceId ||
		(preview.rejoin !== "invitation" &&
			preview.rejoin !== "sign_in" &&
			preview.rejoin !== "none") ||
		typeof preview.expected_digest !== "string" ||
		!/^[a-f0-9]{64}$/.test(preview.expected_digest) ||
		(preview.key_id !== null && typeof preview.key_id !== "string") ||
		!isCoordinatorOrigin(preview.coordinator_origin)
	) {
		throw new DeviceRemovalPreviewError();
	}
	const olderDeviceNames = readOlderDeviceNames(preview.older_device_names);
	return {
		device_id: deviceId,
		rejoin: preview.rejoin as DeviceRemovalPreview["rejoin"],
		expected_digest: preview.expected_digest,
		key_id: preview.key_id as string | null,
		coordinator_origin: preview.coordinator_origin,
		...(olderDeviceNames.length ? { older_device_names: olderDeviceNames } : {}),
	};
}

function readOlderDeviceNames(value: unknown): string[] {
	if (
		!Array.isArray(value) ||
		value.length > 500 ||
		!value.every((item) => typeof item === "string" && item.trim().length > 0)
	)
		return [];
	return value;
}

export function removalCompatibilityNotice(name: string, names: readonly string[]) {
	return `Devices that haven't reported Remove support may still sync with ${name}: ${names.join(", ")}. Update those devices or unpair ${name} on each of them.`;
}

function rejoinDescription(name: string, rejoin: DeviceRemovalPreview["rejoin"]): string {
	switch (rejoin) {
		case "invitation":
			return `To bring ${name} back, create a new invitation in Sharing and accept it on ${name}.`;
		case "sign_in":
			return `To bring ${name} back, sign in with Google on ${name}. Whoever can sign in to that account on ${name} can bring it back.`;
		case "none":
			return `${name} is linked to a Google account and cannot be added back after you remove it. It would have to be set up as a new device.`;
	}
}

function confirmDescription(
	name: string,
	rejoin: DeviceRemovalPreview["rejoin"],
	olderDeviceNames: readonly string[],
): string {
	const body = `Devices that support Remove stop syncing with ${name} when they next check the coordinator. Memories already on ${name} stay there, and memories it already sent stay on your devices. Your other devices keep syncing with each other. ${rejoinDescription(name, rejoin)}`;
	if (olderDeviceNames.length === 0) return body;
	return `${body}\n\n${removalCompatibilityNotice(name, olderDeviceNames)}`;
}

const defaultDependencies: DeviceRemovalConfirmationDependencies = {
	preview: (deviceId) =>
		fetchJson<unknown>(`/api/sync/devices/${encodeURIComponent(deviceId)}/remove/preview`, {
			method: "POST",
		}),
	confirm: openSyncConfirmDialog,
};

/** Reviews a read-only server preview. The caller owns any later removal request. */
export async function runDeviceRemovalConfirmation(
	device: { deviceId: string; displayName: string; olderDeviceNames?: readonly string[] },
	dependencies: Partial<DeviceRemovalConfirmationDependencies> = {},
): Promise<DeviceRemovalPreview | LocalRemovalPreview | null> {
	if (!device.deviceId.trim()) throw new DeviceRemovalPreviewError();
	const { preview, confirm } = { ...defaultDependencies, ...dependencies };
	const reviewed = validatePreview(await preview(device.deviceId), device.deviceId);
	if ("mode" in reviewed) {
		const name = device.displayName;
		const confirmed = await confirm({
			title: `Remove ${name} from this device?`,
			description:
				reviewed.mode === "already_removed"
					? `${name} is already removed from the coordinator. This device will clear its pairing and sync progress. Memories already on either device stay.`
					: `This device stops syncing with ${name} and forgets its sync progress. Your other devices keep syncing with ${name} until you remove it on each of them. Memories already on either device stay.`,
			confirmLabel: "Remove from this device",
			cancelLabel: "Keep device",
			autoFocusAction: "cancel",
			tone: "danger",
		});
		return confirmed === true ? reviewed : null;
	}
	const confirmed = await confirm({
		title: `Remove ${device.displayName}?`,
		description: confirmDescription(device.displayName, reviewed.rejoin, [
			...new Set([...(reviewed.older_device_names ?? []), ...(device.olderDeviceNames ?? [])]),
		]),
		confirmLabel: "Remove device",
		cancelLabel: "Keep device",
		autoFocusAction: "cancel",
		tone: "danger",
	});
	return confirmed === true ? reviewed : null;
}

interface DeviceRemovalProgress {
	device_id: string;
	group_id: string;
	display_name: string | null;
	state: "applied" | "pending" | "older";
}

export interface DeviceRemovalResult {
	state: "removed";
	removal_id: string;
	removal_seq: number;
	evidence: "receipt" | "listing";
	local_cleanup: "applied" | "deferred";
	refresh_pending: boolean;
	progress?: DeviceRemovalProgress[] | null;
}

interface LocalRemovalResult {
	state: "removed";
	mode: "local" | "already_removed";
}

const removalErrorCodes = [
	"invalid_input",
	"coordinator_admin_required",
	"coordinator_update_required",
	"device_removal_unavailable",
	"local_identity_unverified",
	"cannot_remove_this_device",
	"removal_preview_stale",
	"removal_target_not_enrolled",
	"removal_target_unavailable",
	"removal_outcome_unknown",
] as const;

export type DeviceRemovalErrorCode = (typeof removalErrorCodes)[number];

export class DeviceRemovalCommitError extends Error {
	constructor(
		readonly code: DeviceRemovalErrorCode,
		readonly statusCode: number,
	) {
		super(code);
		this.name = "DeviceRemovalCommitError";
	}
}

function readProgress(raw: unknown): DeviceRemovalProgress[] | null {
	if (!Array.isArray(raw) || raw.length > 500) return null;
	const rows: DeviceRemovalProgress[] = [];
	for (const value of raw) {
		if (!value || typeof value !== "object") return null;
		const { device_id, group_id, display_name, state } = value as Record<string, unknown>;
		if (
			typeof device_id !== "string" ||
			typeof group_id !== "string" ||
			(display_name !== null && typeof display_name !== "string") ||
			(state !== "applied" && state !== "pending" && state !== "older")
		)
			return null;
		rows.push({
			device_id,
			group_id,
			display_name: typeof display_name === "string" ? display_name : null,
			state,
		});
	}
	return rows;
}

function validateRemovalResult(value: unknown): DeviceRemovalResult {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new DeviceRemovalCommitError("removal_outcome_unknown", 200);
	}
	const result = value as Record<string, unknown>;
	if (
		result.state !== "removed" ||
		typeof result.removal_id !== "string" ||
		!result.removal_id.trim() ||
		!Number.isSafeInteger(result.removal_seq) ||
		(result.removal_seq as number) < 1 ||
		(result.evidence !== "receipt" && result.evidence !== "listing") ||
		(result.local_cleanup !== "applied" && result.local_cleanup !== "deferred") ||
		typeof result.refresh_pending !== "boolean"
	) {
		throw new DeviceRemovalCommitError("removal_outcome_unknown", 200);
	}
	return {
		state: "removed",
		removal_id: result.removal_id,
		removal_seq: result.removal_seq as number,
		evidence: result.evidence,
		local_cleanup: result.local_cleanup,
		refresh_pending: result.refresh_pending,
		...(Object.hasOwn(result, "progress") ? { progress: readProgress(result.progress) } : {}),
	};
}

async function commitDeviceRemoval(
	deviceId: string,
	preview: DeviceRemovalPreview | LocalRemovalPreview,
): Promise<DeviceRemovalResult | LocalRemovalResult> {
	let response: Response;
	let payload: unknown;
	try {
		response = await fetch(`/api/sync/devices/${encodeURIComponent(deviceId)}/remove`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(
				"mode" in preview
					? { mode: preview.mode, expected_digest: preview.expected_digest }
					: {
							coordinator_origin: preview.coordinator_origin,
							expected_digest: preview.expected_digest,
						},
			),
		});
		payload = await response.json();
	} catch {
		// A lost response cannot tell us whether the coordinator applied the removal.
		throw new DeviceRemovalCommitError("removal_outcome_unknown", 0);
	}
	if (response.status !== 200) {
		const code = payloadError(payload);
		const knownCode = removalErrorCodes.find((candidate) => candidate === code);
		throw new DeviceRemovalCommitError(knownCode ?? "removal_outcome_unknown", response.status);
	}
	if ("mode" in preview) {
		if (
			payload &&
			typeof payload === "object" &&
			"mode" in payload &&
			payload.mode === preview.mode &&
			"state" in payload &&
			payload.state === "removed"
		)
			return { state: "removed", mode: preview.mode };
		throw new DeviceRemovalCommitError("removal_outcome_unknown", 200);
	}
	return validateRemovalResult(payload);
}

/** Unmounted entry point. A caller must refresh Devices before retrying an unknown outcome. */
export async function confirmAndCommitDeviceRemoval(
	device: Parameters<typeof runDeviceRemovalConfirmation>[0],
	dependencies: Partial<DeviceRemovalConfirmationDependencies> = {},
): Promise<DeviceRemovalResult | LocalRemovalResult | null> {
	const reviewed = await runDeviceRemovalConfirmation(device, dependencies);
	if (!reviewed) return null;
	return commitDeviceRemoval(reviewed.device_id, reviewed);
}
