import { createHash } from "node:crypto";
import type { Database } from "./db.js";
import {
	type MemoryScopeRetirement,
	recordMemoryScopeRetirement,
} from "./memory-scope-retirement.js";
import { clearMemoryRefs } from "./ref-populate.js";
import { recordNonce, verifyDirectPeerSignature } from "./sync-auth.js";
import { supportsSyncFeature } from "./sync-capability.js";

export const MEMORY_RETIREMENT_FEATURE = "memory_scope_retirement_v1";
/** Reserved signed paths, not mounted HTTP routes. */
export const MEMORY_RETIREMENT_PATH = "/v1/memory-scope-retirements";
export const MEMORY_RETIREMENT_ACK_PATH = `${MEMORY_RETIREMENT_PATH}/ack`;
const MAX_CONTROLS = 100;

export interface RetirementControl extends MemoryScopeRetirement {
	controlId: string;
}
export interface RetirementBatch {
	feature: typeof MEMORY_RETIREMENT_FEATURE;
	recipientDeviceId: string;
	controls: RetirementControl[];
}
export interface RetirementAck {
	feature: typeof MEMORY_RETIREMENT_FEATURE;
	batchDigest: string;
}
export interface SignedRetirementPacket {
	body: string;
	timestamp: string;
	nonce: string;
	signature: string;
	recipientId: string;
}
/** Trusted pairing lookup output, never a public key supplied inside the packet. */
export interface RetirementPeer {
	deviceId: string;
	publicKey: string;
}

function controlId(control: MemoryScopeRetirement): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				MEMORY_RETIREMENT_FEATURE,
				control.entityId,
				control.sourceDeviceId,
				control.retiredScopeId,
			]),
		)
		.digest("hex");
}

function batchDigest(batch: RetirementBatch): string {
	return createHash("sha256").update(JSON.stringify(batch)).digest("hex");
}

/** Enqueue while the source's move transaction still holds its writer lock. */
export function queueMemoryRetirement(
	db: Database,
	control: MemoryScopeRetirement,
	options: { localDeviceId: string; now: string },
): void {
	recordMemoryScopeRetirement(db, control, {
		authenticatedSourceDeviceId: options.localDeviceId,
		now: options.now,
	});
	// Keep former recipients, including revoked memberships. No destination enumeration.
	const peers = db
		.prepare("SELECT device_id FROM scope_memberships WHERE scope_id = ? AND device_id != ?")
		.all(control.retiredScopeId, options.localDeviceId) as Array<{ device_id: string }>;
	for (const peer of peers) {
		db.prepare(`INSERT OR IGNORE INTO memory_retirement_deliveries
			(control_id, peer_device_id, entity_id, source_device_id, retired_scope_id) VALUES (?, ?, ?, ?, ?)`).run(
			controlId(control),
			peer.device_id,
			control.entityId,
			control.sourceDeviceId,
			control.retiredScopeId,
		);
	}
}

/** No content cursor participates; unsupported peers leave every delivery pending. */
export function pendingRetirementBatch(
	db: Database,
	options: {
		localDeviceId: string;
		peerDeviceId: string;
		peerFeatures: unknown;
	},
): RetirementBatch | null {
	if (!supportsSyncFeature(options.peerFeatures, MEMORY_RETIREMENT_FEATURE)) return null;
	const controls = db
		.prepare(`SELECT control_id AS controlId, entity_id AS entityId,
		source_device_id AS sourceDeviceId, retired_scope_id AS retiredScopeId
		FROM memory_retirement_deliveries WHERE peer_device_id = ? AND source_device_id = ?
		AND acknowledged_at IS NULL ORDER BY control_id LIMIT ?`)
		.all(options.peerDeviceId, options.localDeviceId, MAX_CONTROLS) as RetirementControl[];
	if (!controls.length) return null;
	return { feature: MEMORY_RETIREMENT_FEATURE, recipientDeviceId: options.peerDeviceId, controls };
}

export function authenticateRetirementPacket(
	packet: SignedRetirementPacket,
	options: {
		peer: RetirementPeer;
		localDeviceId: string;
		path: string;
	},
): void {
	if (Buffer.byteLength(packet.body) > 512_000) throw new Error("retirement_packet_too_large");
	const verified = verifyDirectPeerSignature({
		method: "POST",
		pathWithQuery: options.path,
		bodyBytes: Buffer.from(packet.body),
		timestamp: packet.timestamp,
		nonce: packet.nonce,
		signature: packet.signature,
		recipientId: packet.recipientId,
		expectedRecipientId: options.localDeviceId,
		publicKey: options.peer.publicKey,
	});
	if (verified.status !== "valid") throw new Error("retirement_authentication_failed");
}

export function parseRetirementBatch(body: string, recipient: string): RetirementBatch {
	const value = JSON.parse(body) as RetirementBatch;
	if (
		value?.feature !== MEMORY_RETIREMENT_FEATURE ||
		value.recipientDeviceId !== recipient ||
		!Array.isArray(value.controls) ||
		!value.controls.length ||
		value.controls.length > MAX_CONTROLS
	) {
		throw new Error("retirement_batch_invalid");
	}
	if (Object.keys(value).some((key) => !["feature", "recipientDeviceId", "controls"].includes(key)))
		throw new Error("retirement_batch_invalid");
	for (const control of value.controls) {
		if (
			!control ||
			Object.keys(control).sort().join(",") !==
				"controlId,entityId,retiredScopeId,sourceDeviceId" ||
			control.controlId !== controlId(control)
		)
			throw new Error("retirement_control_invalid");
	}
	if (new Set(value.controls.map((control) => control.controlId)).size !== value.controls.length)
		throw new Error("retirement_control_duplicate");
	return value;
}

function cleanupRetiredMemory(db: Database, control: RetirementControl): void {
	const row = db
		.prepare("SELECT id FROM memory_items WHERE import_key = ? AND scope_id = ?")
		.get(control.entityId, control.retiredScopeId) as { id: number } | undefined;
	if (!row) return;
	clearMemoryRefs(db, row.id);
	if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'memory_vectors'").get()) {
		db.prepare("DELETE FROM memory_vectors WHERE memory_id = ?").run(row.id);
	}
	db.prepare("DELETE FROM memory_items WHERE id = ?").run(row.id);
}

/** Internal transaction stage shared by live delivery and authenticated reset pages. */
export function applyAuthenticatedRetirementControls(
	db: Database,
	controls: RetirementControl[],
	sourceDeviceId: string,
	now: string,
): void {
	if (!db.inTransaction) throw new Error("memory_retirement_transaction_required");
	for (const control of controls) {
		recordMemoryScopeRetirement(db, control, { authenticatedSourceDeviceId: sourceDeviceId, now });
		cleanupRetiredMemory(db, control);
		db.prepare(
			"INSERT OR IGNORE INTO memory_retirement_receipts(control_id, source_device_id, received_at) VALUES (?, ?, ?)",
		).run(control.controlId, sourceDeviceId, now);
	}
}

/** Internal receiver adapter: direct-source v3 signature is mandatory, even for absent rows. */
export function receiveRetirementBatch(
	db: Database,
	packet: SignedRetirementPacket,
	options: {
		localDeviceId: string;
		peer: RetirementPeer;
		peerFeatures: unknown;
		now: string;
	},
): RetirementAck {
	if (db.inTransaction) throw new Error("retirement_outer_transaction_forbidden");
	if (!supportsSyncFeature(options.peerFeatures, MEMORY_RETIREMENT_FEATURE))
		throw new Error("retirement_feature_required");
	authenticateRetirementPacket(packet, { ...options, path: MEMORY_RETIREMENT_PATH });
	const batch = parseRetirementBatch(packet.body, options.localDeviceId);
	db.transaction(() => {
		if (!recordNonce(db, options.peer.deviceId, packet.nonce, options.now))
			throw new Error("retirement_nonce_replayed");
		applyAuthenticatedRetirementControls(db, batch.controls, options.peer.deviceId, options.now);
	}).immediate();
	return { feature: MEMORY_RETIREMENT_FEATURE, batchDigest: batchDigest(batch) };
}

function acknowledgeBatch(
	db: Database,
	batch: RetirementBatch,
	packet: SignedRetirementPacket,
	options: {
		localDeviceId: string;
		peer: RetirementPeer;
		now: string;
	},
): void {
	if (db.inTransaction) throw new Error("retirement_outer_transaction_forbidden");
	authenticateRetirementPacket(packet, { ...options, path: MEMORY_RETIREMENT_ACK_PATH });
	const ack = JSON.parse(packet.body) as RetirementAck;
	if (ack.feature !== MEMORY_RETIREMENT_FEATURE || ack.batchDigest !== batchDigest(batch))
		throw new Error("retirement_ack_mismatch");
	db.transaction(() => {
		if (!recordNonce(db, options.peer.deviceId, packet.nonce, options.now))
			throw new Error("retirement_nonce_replayed");
		for (const control of batch.controls) {
			db.prepare(`UPDATE memory_retirement_deliveries SET acknowledged_at = COALESCE(acknowledged_at, ?)
				WHERE control_id = ? AND peer_device_id = ? AND source_device_id = ?`).run(
				options.now,
				control.controlId,
				options.peer.deviceId,
				options.localDeviceId,
			);
		}
	}).immediate();
}

/** Transport must sign the request for the recipient. Ack signature is checked here.
 * Not called by sync-pass: snapshot and cross-process admission remain activation gates.
 */
export async function replayMemoryRetirements(
	db: Database,
	options: {
		localDeviceId: string;
		peer: RetirementPeer;
		peerFeatures: unknown;
		now: string;
		exchange: (batch: RetirementBatch) => Promise<SignedRetirementPacket>;
	},
): Promise<{ acknowledged: number; status: "unsupported" | "idle" | "acknowledged" }> {
	if (db.inTransaction) throw new Error("retirement_outer_transaction_forbidden");
	if (!supportsSyncFeature(options.peerFeatures, MEMORY_RETIREMENT_FEATURE))
		return { acknowledged: 0, status: "unsupported" };
	const batch = pendingRetirementBatch(db, { ...options, peerDeviceId: options.peer.deviceId });
	if (!batch) return { acknowledged: 0, status: "idle" };
	const packet = await options.exchange(structuredClone(batch));
	acknowledgeBatch(db, batch, packet, options);
	return { acknowledged: batch.controls.length, status: "acknowledged" };
}
