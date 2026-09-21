import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	revokeUnauthorizedCoordinatorPeerTrust,
	trustCoordinatorPeersWithSharedManagedScopes,
} from "./coordinator-runtime.js";
import {
	MEMORY_RETIREMENT_ACK_PATH,
	MEMORY_RETIREMENT_FEATURE,
	MEMORY_RETIREMENT_PATH,
	pendingRetirementBatch,
	queueMemoryRetirement,
	type RetirementBatch,
	receiveRetirementBatch,
	replayMemoryRetirements,
	type SignedRetirementPacket,
} from "./memory-retirement-delivery.js";
import { ensureMemoryRetirementDeliverySchema } from "./memory-retirement-delivery-schema.js";
import { getRetirementPeer } from "./memory-retirement-trust.js";
import { isMemoryScopeRetired } from "./memory-scope-retirement.js";
import { populateMemoryRefs } from "./ref-populate.js";
import { getCachedScopeAuthorization } from "./scope-membership-cache.js";
import { buildDirectPeerCanonicalRequest } from "./sync-auth.js";
import { LOCAL_SYNC_FEATURES, supportsSyncFeature } from "./sync-capability.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { initTestSchema } from "./test-utils.js";

function identity(deviceId: string) {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
	const wire = Buffer.concat([
		Buffer.from([0, 0, 0, 11]),
		Buffer.from("ssh-ed25519"),
		Buffer.from([0, 0, 0, 32]),
		raw,
	]);
	return { deviceId, privateKey, publicKey: `ssh-ed25519 ${wire.toString("base64")}` };
}
const source = identity("source");
const recipient = identity("recipient");
const attacker = identity("attacker");
const features = [MEMORY_RETIREMENT_FEATURE];
const now = "2026-09-21T12:00:00.000Z";
const control = {
	entityId: "memory-source-v1:c291cmNl:00000000-0000-4000-8000-000000000001",
	sourceDeviceId: "source",
	retiredScopeId: "old",
};
let sender: InstanceType<typeof Database>;
let receiver: InstanceType<typeof Database>;

function packet(
	value: unknown,
	signer = source,
	destination = recipient.deviceId,
	path = MEMORY_RETIREMENT_PATH,
): SignedRetirementPacket {
	const body = JSON.stringify(value);
	const timestamp = String(Math.floor(Date.now() / 1000));
	const nonce = randomUUID();
	const canonical = buildDirectPeerCanonicalRequest(
		"POST",
		path,
		timestamp,
		nonce,
		Buffer.from(body),
		destination,
	);
	return {
		body,
		timestamp,
		nonce,
		recipientId: destination,
		signature: `v3:${sign(null, canonical, signer.privateKey).toString("base64")}`,
	};
}
function receive(batch: RetirementBatch) {
	return receiveRetirementBatch(receiver, packet(batch), {
		localDeviceId: recipient.deviceId,
		peer: source,
		peerFeatures: features,
		now,
	});
}
function batch() {
	const value = pendingRetirementBatch(sender, {
		localDeviceId: source.deviceId,
		peerDeviceId: recipient.deviceId,
		peerFeatures: features,
	});
	if (!value) throw new Error("missing batch");
	return value;
}
function replay(
	exchange = async (value: RetirementBatch) =>
		packet(receive(value), recipient, source.deviceId, MEMORY_RETIREMENT_ACK_PATH),
) {
	return replayMemoryRetirements(sender, {
		localDeviceId: source.deviceId,
		peer: recipient,
		peerFeatures: features,
		now,
		exchange,
	});
}
function seedMemory(scope = "old", entityId = control.entityId): number {
	const session = receiver.prepare("INSERT INTO sessions(started_at) VALUES (?)").run(now);
	return Number(
		receiver
			.prepare(`INSERT INTO memory_items(session_id, kind, title, body_text, confidence, tags_text, active,
		created_at, updated_at, metadata_json, import_key, origin_device_id, rev, visibility, scope_id)
		VALUES (?, 'discovery', 'Old content', 'Only old recipient saw this', 0.5, '', 1, ?, ?, '{}', ?, 'source', 99, 'shared', ?)`)
			.run(session.lastInsertRowid, now, now, entityId, scope).lastInsertRowid,
	);
}

function seedIndexedMemory(scope = "old", entityId = control.entityId): number {
	const id = seedMemory(scope, entityId);
	populateMemoryRefs(receiver, id, [`file-${id}.ts`], null, [`concept-${id}`]);
	receiver
		.prepare(`INSERT INTO memory_vectors(memory_id, embedding, chunk_index, content_hash, model)
		VALUES (CAST(? AS INTEGER), ?, 0, 'fixture', 'fixture')`)
		.run(id, Buffer.from(new Float32Array(384).fill(id).buffer));
	return id;
}

function expectIndexedMemories(ids: number[]) {
	expect(receiver.prepare("SELECT id FROM memory_items ORDER BY id").pluck().all()).toEqual(ids);
	for (const table of ["memory_file_refs", "memory_concept_refs", "memory_vectors"]) {
		expect(
			receiver.prepare(`SELECT memory_id FROM ${table} ORDER BY memory_id`).pluck().all(),
		).toEqual(ids);
	}
}

it("acknowledges duplicate retirement copies only after all matching content and indexes are removed", async () => {
	seedIndexedMemory();
	seedIndexedMemory();
	const destination = seedIndexedMemory("new");
	const unrelated = seedIndexedMemory("old", "unrelated");
	await expect(
		replay(async (outbound) => {
			const ack = receive(outbound);
			expectIndexedMemories([destination, unrelated]);
			expect(receiver.inTransaction).toBe(false);
			expect(
				receiver.prepare("SELECT COUNT(*) FROM memory_retirement_receipts").pluck().get(),
			).toBe(1);
			return packet(ack, recipient, source.deviceId, MEMORY_RETIREMENT_ACK_PATH);
		}),
	).resolves.toEqual({ acknowledged: 1, status: "acknowledged" });
	expect(
		sender.prepare("SELECT acknowledged_at FROM memory_retirement_deliveries").pluck().get(),
	).toBe(now);
});

it("rolls back the whole delivery when the final duplicate deletion fails and permits the same packet retry", async () => {
	const second = {
		...control,
		entityId: "memory-source-v1:c291cmNl:00000000-0000-4000-8000-000000000002",
	};
	sender.transaction(() =>
		queueMemoryRetirement(sender, second, { localDeviceId: source.deviceId, now }),
	)();
	const offered = batch();
	for (const item of offered.controls) {
		seedIndexedMemory("old", item.entityId);
		seedIndexedMemory("old", item.entityId);
	}
	const destination = seedIndexedMemory("new");
	const unrelated = seedIndexedMemory("old", "unrelated");
	const last = offered.controls.at(-1);
	if (!last) throw new Error("missing control");
	receiver.exec(`CREATE TRIGGER fail_final_copy BEFORE DELETE ON memory_items
		WHEN OLD.import_key = '${last.entityId}' AND OLD.scope_id = 'old'
		AND (SELECT COUNT(*) FROM memory_items WHERE import_key = OLD.import_key AND scope_id = 'old') = 1
		BEGIN SELECT RAISE(ABORT, 'final_copy_failed'); END`);
	const signed = packet(offered);
	const exchange = async () => {
		const ack = receiveRetirementBatch(receiver, signed, {
			localDeviceId: recipient.deviceId,
			peer: source,
			peerFeatures: features,
			now,
		});
		return packet(ack, recipient, source.deviceId, MEMORY_RETIREMENT_ACK_PATH);
	};
	const before = receiver.serialize();
	await expect(replay(exchange)).rejects.toThrow("final_copy_failed");
	expect(receiver.serialize().equals(before)).toBe(true);
	expect(batch()).toEqual(offered);
	expect(receiver.prepare("SELECT COUNT(*) FROM memory_retirement_receipts").pluck().get()).toBe(0);
	for (const item of offered.controls)
		expect(isMemoryScopeRetired(receiver, item.entityId, "old")).toBe(false);
	receiver.exec("DROP TRIGGER fail_final_copy");
	await expect(replay(exchange)).resolves.toEqual({ acknowledged: 2, status: "acknowledged" });
	expectIndexedMemories([destination, unrelated]);
	expect(receiver.prepare("SELECT COUNT(*) FROM memory_retirement_receipts").pluck().get()).toBe(2);
});
beforeEach(() => {
	sender = new Database(":memory:");
	receiver = new Database(":memory:");
	initTestSchema(sender);
	initTestSchema(receiver);
	sender
		.prepare(`INSERT INTO replication_scopes(scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at)
		VALUES ('old', 'Old', 'user', 'coordinator', 1, 'active', ?, ?)`)
		.run(now, now);
	sender
		.prepare(`INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at)
		VALUES ('old', 'recipient', 'member', 'revoked', 1, ?)`)
		.run(now);
	sender.transaction(() =>
		queueMemoryRetirement(sender, control, { localDeviceId: source.deviceId, now }),
	)();
});
afterEach(() => {
	sender.close();
	receiver.close();
});

function coordinatorPair(db: InstanceType<typeof Database>, local: string, peer: typeof source) {
	const fresh = new Date().toISOString();
	db.prepare(`INSERT OR REPLACE INTO replication_scopes
		(scope_id, label, kind, authority_type, coordinator_id, group_id, membership_epoch, status, created_at, updated_at)
		VALUES ('old', 'Old', 'managed_project', 'coordinator', 'https://coord.example.test', 'group', 1, 'active', ?, ?)`).run(
		fresh,
		fresh,
	);
	for (const device of [local, peer.deviceId]) {
		db.prepare(`INSERT OR REPLACE INTO scope_memberships
			(scope_id, device_id, role, status, membership_epoch, updated_at)
			VALUES ('old', ?, 'member', 'active', 1, ?)`).run(device, fresh);
	}
	db.prepare(`INSERT INTO scope_membership_cache_state
		(coordinator_id, group_id, last_refresh_at, last_success_at, last_error, updated_at)
		VALUES ('https://coord.example.test', 'group', ?, ?, NULL, ?)`).run(fresh, fresh, fresh);
	expect(
		trustCoordinatorPeersWithSharedManagedScopes(db, local, [
			{
				device_id: peer.deviceId,
				public_key: peer.publicKey,
				fingerprint: fingerprintPublicKey(peer.publicKey),
				coordinator_id: "https://coord.example.test",
				groups: ["group"],
			},
		]),
	).toBe(1);
}

function revokePair() {
	coordinatorPair(sender, source.deviceId, recipient);
	coordinatorPair(receiver, recipient.deviceId, source);
	for (const [db, local, peer] of [
		[sender, source, recipient],
		[receiver, recipient, source],
	] as const) {
		db.prepare(
			"UPDATE scope_memberships SET status = 'revoked' WHERE device_id = 'recipient'",
		).run();
		expect(revokeUnauthorizedCoordinatorPeerTrust(db, local.deviceId)).toBe(1);
		expect(db.prepare("SELECT * FROM sync_peers").all()).toEqual([]);
		expect(
			getRetirementPeer(db, { localDeviceId: local.deviceId, peerDeviceId: peer.deviceId }),
		).toEqual({ deviceId: peer.deviceId, publicKey: peer.publicKey });
		expect(
			getRetirementPeer(db, { localDeviceId: "different-local", peerDeviceId: peer.deviceId }),
		).toBeNull();
		expect(
			getCachedScopeAuthorization(db, {
				deviceId: recipient.deviceId,
				scopeId: "old",
				authority: { coordinatorId: "https://coord.example.test", groupId: "group" },
			}),
		).toMatchObject({ authorized: false, freshness: "fresh" });
	}
}

function retainedPeer(db: InstanceType<typeof Database>, local: string, peer: string) {
	const pairing = getRetirementPeer(db, { localDeviceId: local, peerDeviceId: peer });
	if (!pairing) throw new Error("retirement_pairing_missing");
	return pairing;
}

it.each(["before", "after"])(
	"replays offline retirement queued %s final-scope revocation using only retained pins",
	async (timing) => {
		if (timing === "after") sender.prepare("DELETE FROM memory_retirement_deliveries").run();
		seedMemory();
		revokePair();
		if (timing === "after") {
			sender.transaction(() =>
				queueMemoryRetirement(sender, control, { localDeviceId: source.deviceId, now }),
			)();
		}
		const senderBytes = sender.serialize();
		const receiverBytes = receiver.serialize();
		sender.close();
		receiver.close();
		sender = new Database(senderBytes);
		receiver = new Database(receiverBytes);
		initTestSchema(sender);
		initTestSchema(receiver);
		sender.prepare("DELETE FROM replication_ops").run();
		receiver.prepare("DELETE FROM replication_ops").run();
		const senderOptions = {
			localDeviceId: source.deviceId,
			peer: retainedPeer(sender, source.deviceId, recipient.deviceId),
			peerFeatures: features,
			now,
		};
		const receiverOptions = {
			localDeviceId: recipient.deviceId,
			peer: retainedPeer(receiver, recipient.deviceId, source.deviceId),
			peerFeatures: features,
			now,
		};
		await expect(
			replayMemoryRetirements(sender, {
				...senderOptions,
				exchange: async (outbound) => {
					receiveRetirementBatch(receiver, packet(outbound), receiverOptions);
					throw new Error("lost_ack");
				},
			}),
		).rejects.toThrow("lost_ack");
		expect(batch().controls).toHaveLength(1);
		await expect(
			replayMemoryRetirements(sender, {
				...senderOptions,
				exchange: async (outbound) => {
					const ack = receiveRetirementBatch(receiver, packet(outbound), receiverOptions);
					return packet(ack, recipient, source.deviceId, MEMORY_RETIREMENT_ACK_PATH);
				},
			}),
		).resolves.toEqual({ acknowledged: 1, status: "acknowledged" });
		expect(receiver.prepare("SELECT id FROM memory_items").all()).toEqual([]);
		expect(isMemoryScopeRetired(receiver, control.entityId, "old")).toBe(true);
		for (const [db, local, peer] of [
			[sender, source, recipient],
			[receiver, recipient, source],
		] as const) {
			expect(db.prepare("SELECT * FROM sync_peers").all()).toEqual([]);
			expect(retainedPeer(db, local.deviceId, peer.deviceId).publicKey).toBe(peer.publicKey);
		}
	},
);

it("rejects forged keys and foreign namespaces after revocation without consuming pending deliveries", async () => {
	revokePair();
	const options = {
		localDeviceId: recipient.deviceId,
		peer: retainedPeer(receiver, recipient.deviceId, source.deviceId),
		peerFeatures: features,
		now,
	};
	const before = receiver.serialize();
	expect(() => receiveRetirementBatch(receiver, packet(batch(), attacker), options)).toThrow(
		"retirement_authentication_failed",
	);
	const foreign = {
		...control,
		entityId: "memory-source-v1:YXR0YWNrZXI:00000000-0000-4000-8000-000000000001",
	};
	const controlId = createHash("sha256")
		.update(
			JSON.stringify([
				MEMORY_RETIREMENT_FEATURE,
				foreign.entityId,
				foreign.sourceDeviceId,
				foreign.retiredScopeId,
			]),
		)
		.digest("hex");
	expect(() =>
		receiveRetirementBatch(
			receiver,
			packet({ ...batch(), controls: [{ ...foreign, controlId }] }),
			options,
		),
	).toThrow("memory_source_sender_mismatch");
	expect(receiver.serialize().equals(before)).toBe(true);
	await expect(
		replayMemoryRetirements(sender, {
			localDeviceId: source.deviceId,
			peer: retainedPeer(sender, source.deviceId, recipient.deviceId),
			peerFeatures: features,
			now,
			exchange: async (outbound) =>
				packet(
					receiveRetirementBatch(receiver, packet(outbound), options),
					attacker,
					source.deviceId,
					MEMORY_RETIREMENT_ACK_PATH,
				),
		}),
	).rejects.toThrow("retirement_authentication_failed");
	expect(batch().controls).toHaveLength(1);
});

it("rolls back retained trust together with a failed policy revocation", () => {
	coordinatorPair(sender, source.deviceId, recipient);
	sender
		.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE device_id = 'recipient'")
		.run();
	sender.exec(
		"CREATE TRIGGER fail_revoke BEFORE DELETE ON sync_peers BEGIN SELECT RAISE(ABORT, 'revoke_failed'); END",
	);
	const before = sender.serialize();
	expect(() => revokeUnauthorizedCoordinatorPeerTrust(sender, source.deviceId)).toThrow(
		"revoke_failed",
	);
	expect(sender.serialize().equals(before)).toBe(true);
	expect(sender.prepare("SELECT * FROM memory_retirement_peer_trust").all()).toEqual([]);
});

it("does not replace historical retirement authority when a device ID is later paired with a new key", () => {
	revokePair();
	sender
		.prepare(`INSERT INTO sync_peers(peer_device_id, public_key, pinned_fingerprint, created_at,
		trust_provenance, discovered_via_coordinator_id, discovered_via_group_id)
		VALUES (?, ?, ?, ?, 'coordinator_policy', 'https://coord.example.test', 'group')`)
		.run(recipient.deviceId, attacker.publicKey, fingerprintPublicKey(attacker.publicKey), now);
	expect(retainedPeer(sender, source.deviceId, recipient.deviceId).publicKey).toBe(
		recipient.publicKey,
	);
	expect(revokeUnauthorizedCoordinatorPeerTrust(sender, source.deviceId)).toBe(1);
	expect(retainedPeer(sender, source.deviceId, recipient.deviceId).publicKey).toBe(
		recipient.publicKey,
	);
	expect(
		getRetirementPeer(sender, { localDeviceId: source.deviceId, peerDeviceId: "never-paired" }),
	).toBeNull();
});

it.each([null, "mismatched"])(
	"does not retain an incomplete or inconsistent fingerprint (%s)",
	(fingerprint) => {
		coordinatorPair(sender, source.deviceId, recipient);
		expect(retainedPeer(sender, source.deviceId, recipient.deviceId).publicKey).toBe(
			recipient.publicKey,
		);
		sender.prepare("UPDATE sync_peers SET pinned_fingerprint = ?").run(fingerprint);
		expect(
			getRetirementPeer(sender, {
				localDeviceId: source.deviceId,
				peerDeviceId: recipient.deviceId,
			}),
		).toBeNull();
		sender
			.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE device_id = 'recipient'")
			.run();
		expect(revokeUnauthorizedCoordinatorPeerTrust(sender, source.deviceId)).toBe(1);
		expect(
			getRetirementPeer(sender, {
				localDeviceId: source.deviceId,
				peerDeviceId: recipient.deviceId,
			}),
		).toBeNull();
	},
);

it("uses the peer/source/ack index for bounded pending polls amid retained acknowledged history", () => {
	sender.exec("DROP INDEX idx_memory_retirement_deliveries_pending");
	const insert = sender.prepare(`INSERT INTO memory_retirement_deliveries
		(control_id, peer_device_id, entity_id, source_device_id, retired_scope_id, acknowledged_at)
		VALUES (?, ?, 'entity', ?, 'old', ?)`);
	sender.transaction(() => {
		for (let index = 0; index < 10_000; index++) {
			insert.run(`acked-${index}`, "recipient", "source", now);
			insert.run(`other-peer-${index}`, "other", "source", null);
			insert.run(`other-source-${index}`, "recipient", "other-source", null);
		}
	})();
	ensureMemoryRetirementDeliverySchema(sender);
	ensureMemoryRetirementDeliverySchema(sender);
	sender.exec("ANALYZE");
	const plan = sender
		.prepare(`EXPLAIN QUERY PLAN SELECT control_id, entity_id, source_device_id, retired_scope_id
		FROM memory_retirement_deliveries WHERE peer_device_id = ? AND source_device_id = ?
		AND acknowledged_at IS NULL ORDER BY control_id LIMIT ?`)
		.all("recipient", "source", 100) as { detail: string }[];
	expect(plan.map((row) => row.detail).join("\n")).toContain(
		"USING INDEX idx_memory_retirement_deliveries_pending (peer_device_id=? AND source_device_id=? AND acknowledged_at=?)",
	);
	expect(plan.some((row) => /SCAN|TEMP B-TREE/.test(row.detail))).toBe(false);
	expect(batch().controls).toHaveLength(1);
});

it("recognizes retirement separately but never advertises the unfinished feature", () => {
	expect(supportsSyncFeature(["reassign_scope"], MEMORY_RETIREMENT_FEATURE)).toBe(false);
	expect(supportsSyncFeature(features, MEMORY_RETIREMENT_FEATURE)).toBe(true);
	expect(LOCAL_SYNC_FEATURES).not.toContain(MEMORY_RETIREMENT_FEATURE);
});

it("never targets destination-only memberships or accepts content in a signed control", () => {
	sender
		.prepare(`INSERT INTO replication_scopes(scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at)
		VALUES ('new', 'New', 'user', 'coordinator', 1, 'active', ?, ?)`)
		.run(now, now);
	sender
		.prepare(`INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at)
		VALUES ('new', 'destination-only', 'member', 'active', 1, ?)`)
		.run(now);
	sender.transaction(() =>
		queueMemoryRetirement(sender, control, { localDeviceId: source.deviceId, now }),
	)();
	expect(
		pendingRetirementBatch(sender, {
			localDeviceId: source.deviceId,
			peerDeviceId: "destination-only",
			peerFeatures: features,
		}),
	).toBeNull();
	const value = batch();
	const polluted = {
		...value,
		controls: value.controls.map((item) => ({ ...item, body: "must not travel" })),
	};
	const before = receiver.serialize();
	expect(() =>
		receiveRetirementBatch(receiver, packet(polluted), {
			localDeviceId: recipient.deviceId,
			peer: source,
			peerFeatures: features,
			now,
		}),
	).toThrow("retirement_control_invalid");
	expect(receiver.serialize().equals(before)).toBe(true);
});

it("delivers payload-free controls to a revoked old recipient and acknowledges only after cleanup commits", async () => {
	const retired = seedMemory();
	const other = seedMemory("old", "unrelated");
	populateMemoryRefs(receiver, retired, ["old.ts"], null, ["retired"]);
	populateMemoryRefs(receiver, other, ["other.ts"], null, ["unrelated"]);
	receiver
		.prepare(
			"INSERT INTO memory_vectors(memory_id, embedding, chunk_index, content_hash, model) VALUES (CAST(? AS INTEGER), ?, 0, 'retired', 'fixture'), (CAST(? AS INTEGER), ?, 0, 'other', 'fixture')",
		)
		.run(
			retired,
			Buffer.from(new Float32Array(384).fill(1).buffer),
			other,
			Buffer.from(new Float32Array(384).fill(2).buffer),
		);
	const value = batch();
	expect(Object.keys(value.controls[0] ?? {}).sort()).toEqual([
		"controlId",
		"entityId",
		"retiredScopeId",
		"sourceDeviceId",
	]);
	expect(JSON.stringify(value)).not.toContain("new");
	await expect(
		replay(async (outbound) => {
			expect(sender.inTransaction).toBe(false);
			const ack = receive(outbound);
			expect(receiver.inTransaction).toBe(false);
			expect(receiver.prepare("SELECT id FROM memory_items").all()).toEqual([{ id: other }]);
			expect(receiver.prepare("SELECT memory_id FROM memory_file_refs").all()).toEqual([
				{ memory_id: other },
			]);
			expect(receiver.prepare("SELECT memory_id FROM memory_concept_refs").all()).toEqual([
				{ memory_id: other },
			]);
			expect(receiver.prepare("SELECT memory_id FROM memory_vectors").all()).toEqual([
				{ memory_id: other },
			]);
			expect(isMemoryScopeRetired(receiver, control.entityId, "old")).toBe(true);
			return packet(ack, recipient, source.deviceId, MEMORY_RETIREMENT_ACK_PATH);
		}),
	).resolves.toEqual({ acknowledged: 1, status: "acknowledged" });
	expect(
		pendingRetirementBatch(sender, {
			localDeviceId: source.deviceId,
			peerDeviceId: recipient.deviceId,
			peerFeatures: features,
		}),
	).toBeNull();
});

it("preserves unretired destination rows and authenticates absent identities", async () => {
	const destination = seedMemory("new");
	await replay();
	expect(receiver.prepare("SELECT id, scope_id FROM memory_items").get()).toEqual({
		id: destination,
		scope_id: "new",
	});
	receiver.prepare("DELETE FROM memory_items").run();
	receive(batchForRetry());
	expect(isMemoryScopeRetired(receiver, control.entityId, "old")).toBe(true);
});
function batchForRetry(): RetirementBatch {
	sender.prepare("UPDATE memory_retirement_deliveries SET acknowledged_at = NULL").run();
	return batch();
}

it("replays after lost ack, restart and content log compaction; unsupported peers never advance control state", async () => {
	const value = batch();
	await expect(
		replay(async (outbound) => {
			receive(outbound);
			throw new Error("lost_ack");
		}),
	).rejects.toThrow("lost_ack");
	const bytes = sender.serialize();
	sender.close();
	sender = new Database(bytes);
	const receiverBytes = receiver.serialize();
	receiver.close();
	receiver = new Database(receiverBytes);
	sender.prepare("DELETE FROM replication_ops").run();
	receiver.prepare("DELETE FROM replication_ops").run();
	expect(batch()).toEqual(value);
	await expect(
		replayMemoryRetirements(sender, {
			localDeviceId: source.deviceId,
			peer: recipient,
			peerFeatures: ["reassign_scope"],
			now,
			exchange: async () => {
				throw new Error("must not send");
			},
		}),
	).resolves.toEqual({ acknowledged: 0, status: "unsupported" });
	expect(batch()).toEqual(value);
	await expect(replay()).resolves.toMatchObject({ acknowledged: 1 });
	expect(receiver.prepare("SELECT COUNT(*) FROM memory_retirement_receipts").pluck().get()).toBe(1);
});

it("rejects signatures from a forged sender and valid signatures claiming another source", () => {
	const value = batch();
	const before = receiver.serialize();
	const options = { localDeviceId: recipient.deviceId, peer: source, peerFeatures: features, now };
	expect(() => receiveRetirementBatch(receiver, packet(value, attacker), options)).toThrow(
		"retirement_authentication_failed",
	);
	expect(() =>
		receiveRetirementBatch(receiver, packet(value, attacker), { ...options, peer: attacker }),
	).toThrow("memory_retirement_sender_mismatch");
	expect(() =>
		receiveRetirementBatch(receiver, packet(value, source, "different-recipient"), options),
	).toThrow("retirement_authentication_failed");
	expect(receiver.serialize().equals(before)).toBe(true);
});

it("rolls back cleanup, ledger, receipts and nonce together if a later control fails", () => {
	seedMemory();
	const value = batch();
	const invalid = {
		...control,
		entityId: "legacy-unverified",
		controlId: createHash("sha256")
			.update(JSON.stringify([MEMORY_RETIREMENT_FEATURE, "legacy-unverified", "source", "old"]))
			.digest("hex"),
	};
	// Queue validates namespace ownership before adding any delivery.
	expect(() =>
		sender.transaction(() =>
			queueMemoryRetirement(
				sender,
				{ ...control, entityId: "legacy-unverified" },
				{ localDeviceId: source.deviceId, now },
			),
		)(),
	).toThrow("memory_source_verification_required");
	const before = receiver.serialize();
	expect(() => receive({ ...value, controls: [...value.controls, invalid] })).toThrow(
		"memory_source_verification_required",
	);
	expect(receiver.serialize().equals(before)).toBe(true);
	receiver.exec(
		"CREATE TRIGGER fail_receipt BEFORE INSERT ON memory_retirement_receipts BEGIN SELECT RAISE(ABORT, 'receipt_failed'); END",
	);
	const withTrigger = receiver.serialize();
	expect(() => receive(value)).toThrow("receipt_failed");
	expect(receiver.serialize().equals(withTrigger)).toBe(true);
	receiver.exec("DROP TRIGGER fail_receipt");
	expect(isMemoryScopeRetired(receiver, control.entityId, "old")).toBe(false);
	expect(receiver.prepare("SELECT COUNT(*) FROM memory_items").pluck().get()).toBe(1);
});

it("rejects wrong-peer or wrong-batch acks and rolls back failed acknowledgements", async () => {
	await expect(
		replay(async (outbound) =>
			packet(receive(outbound), attacker, source.deviceId, MEMORY_RETIREMENT_ACK_PATH),
		),
	).rejects.toThrow("retirement_authentication_failed");
	await expect(
		replay(async () =>
			packet(
				{ feature: MEMORY_RETIREMENT_FEATURE, batchDigest: "wrong" },
				recipient,
				source.deviceId,
				MEMORY_RETIREMENT_ACK_PATH,
			),
		),
	).rejects.toThrow("retirement_ack_mismatch");
	expect(batch().controls).toHaveLength(1);
	sender.exec(
		"CREATE TRIGGER fail_ack BEFORE UPDATE ON memory_retirement_deliveries BEGIN SELECT RAISE(ABORT, 'ack_failed'); END",
	);
	const before = sender.serialize();
	await expect(replay()).rejects.toThrow("ack_failed");
	expect(sender.serialize().equals(before)).toBe(true);
	sender.exec("DROP TRIGGER fail_ack");
	await expect(replay()).resolves.toMatchObject({ acknowledged: 1 });
});

it("rejects packet nonce reuse but accepts an idempotent control retry with fresh signature", () => {
	const value = batch();
	const signed = packet(value);
	const options = { localDeviceId: recipient.deviceId, peer: source, peerFeatures: features, now };
	receiveRetirementBatch(receiver, signed, options);
	expect(() => receiveRetirementBatch(receiver, signed, options)).toThrow(
		"retirement_nonce_replayed",
	);
	expect(receive(value)).toHaveProperty("batchDigest");
});

it("acknowledges only the offered batch when more controls arrive while transport is paused", async () => {
	const second = {
		...control,
		entityId: "memory-source-v1:c291cmNl:00000000-0000-4000-8000-000000000002",
	};
	await replay(async (offered) => {
		sender.transaction(() =>
			queueMemoryRetirement(sender, second, { localDeviceId: source.deviceId, now }),
		)();
		return packet(receive(offered), recipient, source.deviceId, MEMORY_RETIREMENT_ACK_PATH);
	});
	expect(batch().controls.map((item) => item.entityId)).toEqual([second.entityId]);
	await replay();
	expect(isMemoryScopeRetired(receiver, second.entityId, "old")).toBe(true);
});

it("rolls back queued deliveries with the source move and refuses outer receiver transactions", () => {
	const second = {
		...control,
		entityId: "memory-source-v1:c291cmNl:00000000-0000-4000-8000-000000000002",
	};
	const before = sender.serialize();
	expect(() =>
		sender.transaction(() => {
			queueMemoryRetirement(sender, second, { localDeviceId: source.deviceId, now });
			throw new Error("move_failed");
		})(),
	).toThrow("move_failed");
	expect(sender.serialize().equals(before)).toBe(true);
	expect(() => receiver.transaction(() => receive(batch()))()).toThrow(
		"retirement_outer_transaction_forbidden",
	);
});
