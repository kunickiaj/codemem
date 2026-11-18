import type { Database } from "./db.js";
import { wakeRecipientPoliciesForIdentities } from "./device-identity-binding.js";
import {
	type DeviceIdentityCoordinatorEvidence,
	type DeviceIdentityInventoryItemV1,
	type DeviceIdentityInventorySnapshot,
	type DeviceIdentityPeerEvidence,
	loadDeviceIdentityInventorySnapshot,
	projectDeviceIdentityInventory,
} from "./device-identity-inventory.js";
import { assignIdentityDeviceInTransaction } from "./identity-device-assignment.js";
import {
	LEGACY_PAIRING_ASSIGNMENT_JOB,
	legacyPairingAssignmentsConverted,
} from "./legacy-pairing-assignment-state.js";
import { assertLocalIdentityCurrent } from "./local-identity-generation.js";
import { completeMaintenanceJob, startMaintenanceJob } from "./maintenance-jobs.js";
import { isActiveUnmergedActor } from "./recipient-policy-actor-eligibility.js";
import { legacyRecipientPolicyDigest } from "./recipient-policy-identifiers.js";

/** Provenance of a binding that came from the person an older pairing named. */
export const LEGACY_PAIRING_ASSIGNMENT_PROVENANCE = "legacy_pairing_assignment";

/** The projection's own ceiling, so a large install is never judged on a partial list. */
const INVENTORY_LIMIT = 2_000;

export type LegacyPairingAssignmentReviewReason =
	| "assignment_contradiction"
	| "device_alias"
	| "device_retired"
	| "evidence_conflict"
	| "identity_unavailable"
	| "key_unproven"
	| "pairing_required"
	| "suggestion_conflict";

export interface LegacyPairingAssignmentConversionInput {
	localActorId: string;
	localDeviceId: string;
	/** The same coordinator evidence Devices uses to decide what a device can be bound to. */
	coordinator: DeviceIdentityCoordinatorEvidence;
	/**
	 * Makes sure the local person exists as an Identity. Called inside the
	 * conversion's transaction, and only once it is certain to finish, so a
	 * conversion that waits leaves the Identity records as they were. Returns
	 * false when the local Identity cannot be recorded.
	 */
	ensureLocalIdentity?: () => boolean;
	now?: () => string;
}

export interface LegacyPairingAssignmentConversionResult {
	status: "converted" | "already_converted" | "waiting";
	waitingReason:
		| "coordinator_evidence_unavailable"
		| "device_inventory_truncated"
		| "local_identity_conflict"
		| null;
	converted: Array<{ deviceId: string; identityId: string }>;
	/** Devices that stay unbound and show in Devices with the older person as a suggestion. */
	review: Array<{ deviceId: string; reason: LegacyPairingAssignmentReviewReason }>;
	/** Devices that already had a binding, which the older assignment never overrides. */
	alreadyBound: string[];
}

interface AssignedPeer {
	deviceId: string;
	displayName: string;
	hasPublicKey: boolean;
	/** Null when the pairing claims the local person and also names someone else. */
	targetIdentityId: string | null;
}

type Outcome =
	| { kind: "bind"; identityId: string }
	| { kind: "bound" }
	| { kind: "review"; reason: LegacyPairingAssignmentReviewReason };

function result(
	status: LegacyPairingAssignmentConversionResult["status"],
	waitingReason: LegacyPairingAssignmentConversionResult["waitingReason"] = null,
): LegacyPairingAssignmentConversionResult {
	return { status, waitingReason, converted: [], review: [], alreadyBound: [] };
}

function hasLegacyAssignment(peer: DeviceIdentityPeerEvidence): boolean {
	return peer.claimedLocalActor || peer.suggestedIdentityId != null;
}

/** A claim as the user's own device names the local person, whatever `actor_id` is missing. */
function assignedIdentity(peer: DeviceIdentityPeerEvidence, localActorId: string): string | null {
	if (!peer.claimedLocalActor) return peer.suggestedIdentityId;
	const named = peer.suggestedIdentityId;
	return named == null || named === localActorId ? localActorId : null;
}

function assignedPeers(
	snapshot: DeviceIdentityInventorySnapshot,
	input: LegacyPairingAssignmentConversionInput,
): AssignedPeer[] {
	return snapshot.peers
		.filter((peer) => peer.deviceId !== input.localDeviceId && hasLegacyAssignment(peer))
		.map((peer) => ({
			deviceId: peer.deviceId,
			displayName: peer.displayName,
			hasPublicKey: peer.publicKey != null,
			targetIdentityId: assignedIdentity(peer, input.localActorId),
		}))
		.toSorted((left, right) => left.deviceId.localeCompare(right.deviceId));
}

/**
 * The inventory with each pairing's suggestion replaced by the person its older
 * assignment names. The projection then reports one suggestion per device only
 * when the pairing and the coordinator agree.
 */
function inventoryItemsByDevice(
	snapshot: DeviceIdentityInventorySnapshot,
	peers: AssignedPeer[],
): Map<string, DeviceIdentityInventoryItemV1> | null {
	const targets = new Map(peers.map((peer) => [peer.deviceId, peer.targetIdentityId]));
	const inventory = projectDeviceIdentityInventory(
		{
			...snapshot,
			peers: snapshot.peers.map((peer) =>
				targets.has(peer.deviceId)
					? { ...peer, suggestedIdentityId: targets.get(peer.deviceId) ?? null }
					: peer,
			),
		},
		{ limit: INVENTORY_LIMIT },
	);
	if (inventory.truncated) return null;
	const byDevice = new Map<string, DeviceIdentityInventoryItemV1>();
	for (const item of inventory.items) {
		for (const deviceId of item.evidenceDeviceIds) byDevice.set(deviceId, item);
	}
	return byDevice;
}

const STATE_REVIEW_REASONS: Partial<
	Record<DeviceIdentityInventoryItemV1["state"], LegacyPairingAssignmentReviewReason>
> = {
	retired: "device_retired",
	conflicted: "evidence_conflict",
	pairing_required: "pairing_required",
	service: "evidence_conflict",
};

/** Why a device with no binding of its own still cannot be bound without a person. */
function reviewReason(
	db: Database,
	peer: AssignedPeer,
	item: DeviceIdentityInventoryItemV1 | undefined,
): LegacyPairingAssignmentReviewReason | null {
	if (peer.targetIdentityId == null) return "assignment_contradiction";
	if (!item) return "evidence_conflict";
	const stateReason = STATE_REVIEW_REASONS[item.state];
	if (stateReason) return stateReason;
	// Another device ID with the same key: only a person can say which ID is the device.
	if (item.evidenceDeviceIds.length !== 1 || item.state !== "setup_required") return "device_alias";
	if (item.suggestedIdentityId !== peer.targetIdentityId) return "suggestion_conflict";
	if (!peer.hasPublicKey || item.validatedFingerprint == null) return "key_unproven";
	if (!isActiveUnmergedActor(db, peer.targetIdentityId)) return "identity_unavailable";
	return null;
}

function outcome(
	db: Database,
	peer: AssignedPeer,
	item: DeviceIdentityInventoryItemV1 | undefined,
): Outcome {
	// A binding in any state wins, including one that device removal ended.
	const bound = db.prepare("SELECT 1 FROM identity_devices WHERE device_id = ?").get(peer.deviceId);
	if (bound) return { kind: "bound" };
	const reason = reviewReason(db, peer, item);
	if (reason) return { kind: "review", reason };
	return { kind: "bind", identityId: peer.targetIdentityId as string };
}

function bind(db: Database, peer: AssignedPeer, identityId: string, now: string): void {
	const relationship = { deviceId: peer.deviceId, identityId };
	assignIdentityDeviceInTransaction(db, {
		deviceId: peer.deviceId,
		targetIdentityId: identityId,
		expectation: { kind: "absent" },
		insert: {
			displayName: peer.displayName || "Unnamed device",
			provenance: LEGACY_PAIRING_ASSIGNMENT_PROVENANCE,
			revision: legacyRecipientPolicyDigest("legacy-pairing-assignment-revision-v1", relationship),
			migrationState: "user_managed",
			sourceFingerprint: legacyRecipientPolicyDigest(
				"legacy-pairing-assignment-source-v1",
				relationship,
			),
			idempotencyKey: legacyRecipientPolicyDigest("legacy-pairing-assignment-row-v1", relationship),
		},
		now,
	});
}

function markConverted(db: Database, converted: number, review: number): void {
	startMaintenanceJob(db, {
		kind: LEGACY_PAIRING_ASSIGNMENT_JOB,
		title: "Convert older device assignments",
		progressTotal: converted + review,
		progressUnit: "devices",
	});
	completeMaintenanceJob(db, LEGACY_PAIRING_ASSIGNMENT_JOB, {
		progressCurrent: converted,
		metadata: { converted, review },
	});
}

interface ConversionPlan {
	peers: AssignedPeer[];
	items: Map<string, DeviceIdentityInventoryItemV1>;
}

/** The devices to decide, or the reason the conversion cannot decide yet. */
function conversionPlan(
	db: Database,
	input: LegacyPairingAssignmentConversionInput,
): ConversionPlan | LegacyPairingAssignmentConversionResult {
	// Without the coordinator's enrollments nothing is decided and the older columns stay in
	// force. That covers an install with no coordinator and a device without the admin secret:
	// Devices cannot bind a paired device there either, so the older assignment must keep working.
	if (input.coordinator.availability !== "available") {
		return result("waiting", "coordinator_evidence_unavailable");
	}
	const snapshot = loadDeviceIdentityInventorySnapshot(db, {
		localDeviceId: input.localDeviceId,
		coordinator: input.coordinator,
	});
	if (snapshot.localEvidenceTruncated) return result("waiting", "device_inventory_truncated");
	const peers = assignedPeers(snapshot, input);
	const items = inventoryItemsByDevice(snapshot, peers);
	if (!items) return result("waiting", "device_inventory_truncated");
	if (peers.length > 0 && input.ensureLocalIdentity && !input.ensureLocalIdentity()) {
		return result("waiting", "local_identity_conflict");
	}
	return { peers, items };
}

function applyPlan(
	db: Database,
	plan: ConversionPlan,
	now: string,
): LegacyPairingAssignmentConversionResult {
	const conversion = result("converted");
	for (const peer of plan.peers) {
		const decided = outcome(db, peer, plan.items.get(peer.deviceId));
		if (decided.kind === "bound") conversion.alreadyBound.push(peer.deviceId);
		if (decided.kind === "review") {
			conversion.review.push({ deviceId: peer.deviceId, reason: decided.reason });
		}
		if (decided.kind !== "bind") continue;
		bind(db, peer, decided.identityId, now);
		conversion.converted.push({ deviceId: peer.deviceId, identityId: decided.identityId });
	}
	return conversion;
}

function convertInTransaction(
	db: Database,
	input: LegacyPairingAssignmentConversionInput,
): LegacyPairingAssignmentConversionResult {
	// A process that still runs as a person this database has switched away from must not decide.
	assertLocalIdentityCurrent(db, input.localActorId);
	if (legacyPairingAssignmentsConverted(db)) return result("already_converted");
	const plan = conversionPlan(db, input);
	if ("status" in plan) return plan;

	const now = (input.now ?? (() => new Date().toISOString()))();
	const conversion = applyPlan(db, plan, now);
	wakeRecipientPoliciesForIdentities(
		db,
		conversion.converted.map((item) => item.identityId),
		now,
	);
	markConverted(db, conversion.converted.length, conversion.review.length);
	return conversion;
}

/**
 * One-time conversion of the person assigned on a pairing into an Identity
 * binding (ADR 0007 Decision 6). A device is bound only when Devices would let
 * a person bind it with the same suggestion and nothing else contradicts it.
 * Every other assignment stays in place as the suggestion on that device's
 * review item. Runs in one transaction and records its completion, after which
 * the older columns no longer decide which devices are this person's own. It
 * runs only with the coordinator's enrollments in hand, so it never runs on an
 * install without a coordinator or on a device without the admin secret.
 */
export function convertLegacyPairingAssignments(
	db: Database,
	input: LegacyPairingAssignmentConversionInput,
): LegacyPairingAssignmentConversionResult {
	return db.transaction(() => convertInTransaction(db, input)).immediate();
}
