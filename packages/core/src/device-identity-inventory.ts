import type { CoordinatorEnrollment } from "./coordinator-store-contract.js";
import type { Database } from "./db.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

export const DEVICE_IDENTITY_INVENTORY_VERSION = 1 as const;
export const DEVICE_IDENTITY_INVENTORY_LIMIT = 500;
const DEVICE_IDENTITY_EVIDENCE_LIMIT = 2_000;

export type DeviceIdentityInventoryState =
	| "configured"
	| "setup_required"
	| "pairing_required"
	| "conflicted";

export type DeviceIdentityInventorySource =
	| "local_device"
	| "sync_peer"
	| "coordinator_enrollment"
	| "identity_binding";

export interface DeviceIdentityLocalDeviceEvidence {
	deviceId: string;
	displayName: string;
	publicKey: string;
	fingerprint: string;
}

export interface DeviceIdentityPeerEvidence {
	deviceId: string;
	displayName: string;
	publicKey: string | null;
	pinnedFingerprint: string | null;
	suggestedIdentityId: string | null;
	trustProvenance: string | null;
	claimedLocalActor: boolean;
}

export interface DeviceIdentityBindingEvidence {
	deviceId: string;
	displayName: string;
	identityId: string;
	status: string;
	identityStatus: string | null;
}

export interface DeviceIdentityCoordinatorEvidence {
	availability: "available" | "unavailable";
	safeErrorCode: string | null;
	enrollments: CoordinatorEnrollment[];
}

export interface DeviceIdentityInventorySnapshot {
	localDevice: DeviceIdentityLocalDeviceEvidence | null;
	peers: DeviceIdentityPeerEvidence[];
	bindings: DeviceIdentityBindingEvidence[];
	coordinator: DeviceIdentityCoordinatorEvidence;
	localEvidenceTruncated?: boolean;
}

export interface DeviceIdentityInventoryInput {
	localDeviceId: string;
	localDisplayName?: string;
	coordinator: DeviceIdentityCoordinatorEvidence;
}

export interface DeviceIdentityInventoryItemV1 {
	version: typeof DEVICE_IDENTITY_INVENTORY_VERSION;
	deviceId: string;
	evidenceDeviceIds: string[];
	displayName: string;
	state: DeviceIdentityInventoryState;
	identityId: string | null;
	suggestedIdentityId: string | null;
	validatedFingerprint: string | null;
	isLocal: boolean;
	sources: DeviceIdentityInventorySource[];
	conflictCodes: string[];
}

export interface DeviceIdentityInventoryV1 {
	version: typeof DEVICE_IDENTITY_INVENTORY_VERSION;
	items: DeviceIdentityInventoryItemV1[];
	coordinatorEvidence: Pick<DeviceIdentityCoordinatorEvidence, "availability" | "safeErrorCode">;
	truncated: boolean;
}

interface Evidence {
	deviceId: string;
	displayName: string;
	source: DeviceIdentityInventorySource;
	fingerprint: string | null;
	fingerprintConflict: boolean;
	isLocal: boolean;
	suggestedIdentityId: string | null;
	bindingIdentityId: string | null;
	bindingStatus: string | null;
	bindingIdentityStatus: string | null;
	enrollmentEnabled: boolean | null;
	pairingProof: boolean;
}

function clean(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function fingerprint(
	publicKey: string | null,
	claimed: string | null,
): {
	value: string | null;
	conflict: boolean;
} {
	if (!publicKey) return { value: claimed, conflict: false };
	const derived = fingerprintPublicKey(publicKey);
	if (claimed && claimed !== derived) return { value: null, conflict: true };
	return { value: claimed ?? derived, conflict: false };
}

function localEvidence(value: DeviceIdentityLocalDeviceEvidence): Evidence {
	const validated = fingerprint(clean(value.publicKey), clean(value.fingerprint));
	return {
		deviceId: value.deviceId,
		displayName: value.displayName,
		source: "local_device",
		fingerprint: validated.value,
		fingerprintConflict: validated.conflict,
		isLocal: true,
		suggestedIdentityId: null,
		bindingIdentityId: null,
		bindingStatus: null,
		bindingIdentityStatus: null,
		enrollmentEnabled: null,
		pairingProof: true,
	};
}

function peerEvidence(value: DeviceIdentityPeerEvidence): Evidence {
	const validated = fingerprint(clean(value.publicKey), clean(value.pinnedFingerprint));
	return {
		deviceId: value.deviceId,
		displayName: value.displayName,
		source: "sync_peer",
		fingerprint: validated.value,
		fingerprintConflict: validated.conflict,
		isLocal: false,
		suggestedIdentityId: clean(value.suggestedIdentityId),
		bindingIdentityId: null,
		bindingStatus: null,
		bindingIdentityStatus: null,
		enrollmentEnabled: null,
		pairingProof: clean(value.trustProvenance) !== "coordinator_policy" || value.claimedLocalActor,
	};
}

function bindingEvidence(value: DeviceIdentityBindingEvidence): Evidence {
	return {
		deviceId: value.deviceId,
		displayName: value.displayName,
		source: "identity_binding",
		fingerprint: null,
		fingerprintConflict: false,
		isLocal: false,
		suggestedIdentityId: null,
		bindingIdentityId: value.identityId,
		bindingStatus: value.status,
		bindingIdentityStatus: value.identityStatus,
		enrollmentEnabled: null,
		pairingProof: false,
	};
}

function enrollmentEvidence(value: CoordinatorEnrollment): Evidence {
	const validated = fingerprint(clean(value.public_key), clean(value.fingerprint));
	return {
		deviceId: value.device_id,
		displayName: clean(value.display_name) ?? "Enrolled device",
		source: "coordinator_enrollment",
		fingerprint: validated.value,
		fingerprintConflict: validated.conflict,
		isLocal: false,
		suggestedIdentityId: clean(value.identity_id),
		bindingIdentityId: null,
		bindingStatus: null,
		bindingIdentityStatus: null,
		enrollmentEnabled: value.enabled === 1,
		pairingProof: false,
	};
}

function evidence(snapshot: DeviceIdentityInventorySnapshot): Evidence[] {
	return [
		...(snapshot.localDevice ? [localEvidence(snapshot.localDevice)] : []),
		...snapshot.peers.map(peerEvidence),
		...snapshot.bindings.map(bindingEvidence),
		...(snapshot.coordinator.availability === "available"
			? snapshot.coordinator.enrollments.map(enrollmentEvidence)
			: []),
	].filter((item) => clean(item.deviceId) != null);
}

function groups(items: Evidence[]): Evidence[][] {
	const parent = items.map((_, index) => index);
	const root = (index: number): number => {
		const next = parent[index] ?? index;
		if (next === index) return index;
		parent[index] = root(next);
		return parent[index] ?? index;
	};
	const union = (left: number, right: number): void => {
		const leftRoot = root(left);
		const rightRoot = root(right);
		if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
	};
	const byDeviceId = new Map<string, number>();
	const byFingerprint = new Map<string, number>();
	items.forEach((item, index) => {
		const deviceMatch = byDeviceId.get(item.deviceId);
		if (deviceMatch == null) byDeviceId.set(item.deviceId, index);
		else union(index, deviceMatch);
		if (!item.fingerprint || item.fingerprintConflict) return;
		const fingerprintMatch = byFingerprint.get(item.fingerprint);
		if (fingerprintMatch == null) byFingerprint.set(item.fingerprint, index);
		else union(index, fingerprintMatch);
	});
	const grouped = new Map<number, Evidence[]>();
	items.forEach((item, index) => {
		const key = root(index);
		grouped.set(key, [...(grouped.get(key) ?? []), item]);
	});
	return [...grouped.values()];
}

const SOURCE_ORDER: DeviceIdentityInventorySource[] = [
	"local_device",
	"identity_binding",
	"sync_peer",
	"coordinator_enrollment",
];

function preferred(group: Evidence[], source: DeviceIdentityInventorySource): Evidence | null {
	return group.find((item) => item.source === source) ?? null;
}

function projectGroup(group: Evidence[]): DeviceIdentityInventoryItemV1 {
	const deviceIds = [...new Set(group.map((item) => item.deviceId))].toSorted();
	const fingerprints = new Set(
		group.flatMap((item) =>
			item.fingerprint && !item.fingerprintConflict ? [item.fingerprint] : [],
		),
	);
	const activeBindings = group.filter(
		(item) => item.source === "identity_binding" && item.bindingStatus === "active",
	);
	const bindingIdentityIds = new Set(
		activeBindings.flatMap((item) => (item.bindingIdentityId ? [item.bindingIdentityId] : [])),
	);
	const suggestedIdentityIds = new Set(
		group.flatMap((item) => (item.suggestedIdentityId ? [item.suggestedIdentityId] : [])),
	);
	const conflictCodes = [
		group.some((item) => item.fingerprintConflict) ? "fingerprint_invalid" : null,
		fingerprints.size > 1 ? "fingerprint_conflict" : null,
		bindingIdentityIds.size > 1 ? "identity_binding_conflict" : null,
		group.some(
			(item) =>
				item.source === "identity_binding" &&
				item.bindingStatus === "active" &&
				item.bindingIdentityStatus !== "active",
		)
			? "identity_inactive"
			: null,
		group.some((item) => item.source === "identity_binding" && item.bindingStatus !== "active")
			? "identity_binding_revoked"
			: null,
		group.some(
			(item) => item.source === "coordinator_enrollment" && item.enrollmentEnabled === false,
		)
			? "coordinator_enrollment_disabled"
			: null,
	].filter((code): code is string => code != null);
	const hasPairingProof = group.some((item) => item.pairingProof);
	const hasCoordinatorEvidence = group.some(
		(item) =>
			item.source === "coordinator_enrollment" ||
			(item.source === "sync_peer" && !item.pairingProof),
	);
	const state: DeviceIdentityInventoryState =
		conflictCodes.length > 0
			? "conflicted"
			: activeBindings.length > 0
				? "configured"
				: hasCoordinatorEvidence && !hasPairingProof
					? "pairing_required"
					: "setup_required";
	const selected = SOURCE_ORDER.map((source) => preferred(group, source)).find(
		(item): item is Evidence => item != null,
	);
	const sources = SOURCE_ORDER.filter((source) => group.some((item) => item.source === source));
	return {
		version: DEVICE_IDENTITY_INVENTORY_VERSION,
		deviceId: selected?.deviceId ?? deviceIds[0] ?? "",
		evidenceDeviceIds: deviceIds,
		displayName: selected?.displayName || "Device",
		state,
		identityId:
			state === "configured" && bindingIdentityIds.size === 1
				? ([...bindingIdentityIds][0] ?? null)
				: null,
		suggestedIdentityId:
			activeBindings.length === 0 && suggestedIdentityIds.size === 1
				? ([...suggestedIdentityIds][0] ?? null)
				: null,
		validatedFingerprint: fingerprints.size === 1 ? ([...fingerprints][0] ?? null) : null,
		isLocal: group.some((item) => item.isLocal),
		sources,
		conflictCodes: [...new Set(conflictCodes)].toSorted(),
	};
}

export function projectDeviceIdentityInventory(
	snapshot: DeviceIdentityInventorySnapshot,
	options: { limit?: number } = {},
): DeviceIdentityInventoryV1 {
	const limit = Math.max(1, Math.min(options.limit ?? DEVICE_IDENTITY_INVENTORY_LIMIT, 2_000));
	const projected = groups(evidence(snapshot))
		.map(projectGroup)
		.toSorted(
			(left, right) =>
				Number(right.isLocal) - Number(left.isLocal) ||
				left.displayName.localeCompare(right.displayName) ||
				left.deviceId.localeCompare(right.deviceId),
		);
	return {
		version: DEVICE_IDENTITY_INVENTORY_VERSION,
		items: projected.slice(0, limit),
		coordinatorEvidence: {
			availability: snapshot.coordinator.availability,
			safeErrorCode: snapshot.coordinator.safeErrorCode,
		},
		truncated: snapshot.localEvidenceTruncated === true || projected.length > limit,
	};
}

export function loadDeviceIdentityInventorySnapshot(
	db: Database,
	input: DeviceIdentityInventoryInput,
): DeviceIdentityInventorySnapshot {
	const localRow = db
		.prepare(
			`SELECT device_id, public_key, fingerprint FROM sync_device
			 WHERE device_id = ? LIMIT 1`,
		)
		.get(input.localDeviceId) as
		| { device_id: string; public_key: string; fingerprint: string }
		| undefined;
	const peerRows = db
		.prepare(
			`SELECT peer_device_id, name, public_key, pinned_fingerprint, actor_id,
			 trust_provenance, claimed_local_actor
			 FROM sync_peers ORDER BY peer_device_id LIMIT ?`,
		)
		.all(DEVICE_IDENTITY_EVIDENCE_LIMIT + 1);
	const peers = peerRows
		.slice(0, DEVICE_IDENTITY_EVIDENCE_LIMIT)
		.map((row): DeviceIdentityPeerEvidence => {
			const value = row as Record<string, unknown>;
			return {
				deviceId: String(value.peer_device_id ?? ""),
				displayName: clean(value.name) ?? "Peer device",
				publicKey: clean(value.public_key),
				pinnedFingerprint: clean(value.pinned_fingerprint),
				suggestedIdentityId: clean(value.actor_id),
				trustProvenance: clean(value.trust_provenance),
				claimedLocalActor: value.claimed_local_actor === 1,
			};
		});
	const bindingRows = db
		.prepare(
			`SELECT device.device_id, device.display_name, device.identity_id, device.status,
			 actor.status AS identity_status
			 FROM identity_devices device
			 LEFT JOIN actors actor ON actor.actor_id = device.identity_id
			 ORDER BY CASE
			  WHEN device.device_id = ? THEN 0
			  WHEN device.device_id IN (
			   SELECT peer_device_id FROM sync_peers ORDER BY peer_device_id LIMIT ?
			  ) THEN 1
			  ELSE 2
			 END, device.device_id LIMIT ?`,
		)
		.all(input.localDeviceId, DEVICE_IDENTITY_EVIDENCE_LIMIT, DEVICE_IDENTITY_EVIDENCE_LIMIT + 2);
	const bindings = bindingRows
		.slice(0, DEVICE_IDENTITY_EVIDENCE_LIMIT + 1)
		.map((row): DeviceIdentityBindingEvidence => {
			const value = row as Record<string, unknown>;
			return {
				deviceId: String(value.device_id ?? ""),
				displayName: clean(value.display_name) ?? "Registered device",
				identityId: String(value.identity_id ?? ""),
				status: String(value.status ?? ""),
				identityStatus: clean(value.identity_status),
			};
		});
	return {
		localDevice: localRow
			? {
					deviceId: localRow.device_id,
					displayName: clean(input.localDisplayName) ?? "This device",
					publicKey: localRow.public_key,
					fingerprint: localRow.fingerprint,
				}
			: null,
		peers,
		bindings,
		coordinator: input.coordinator,
		localEvidenceTruncated:
			peerRows.length > DEVICE_IDENTITY_EVIDENCE_LIMIT ||
			bindingRows.length > DEVICE_IDENTITY_EVIDENCE_LIMIT + 1,
	};
}

export function listDeviceIdentityInventory(
	db: Database,
	input: DeviceIdentityInventoryInput,
	options: { limit?: number } = {},
): DeviceIdentityInventoryV1 {
	return projectDeviceIdentityInventory(loadDeviceIdentityInventorySnapshot(db, input), options);
}
