import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	revokeUnauthorizedCoordinatorPeerTrust,
	trustCoordinatorPeersWithSharedManagedScopes,
} from "./coordinator-runtime.js";
import {
	MEMORY_RETIREMENT_FEATURE,
	queueMemoryRetirement,
	type SignedRetirementPacket,
} from "./memory-retirement-delivery.js";
import {
	applyRetirementProtectedSnapshot,
	beginRetirementReset,
	RETIREMENT_RESET_PAGE_PATH,
	RETIREMENT_RESET_REQUEST_PATH,
	type RetirementResetRequest,
	receiveRetirementResetPage,
	retirementResetProgress,
	serveRetirementReset,
} from "./memory-retirement-reset.js";
import { getRetirementPeer } from "./memory-retirement-trust.js";
import { isMemoryScopeRetired } from "./memory-scope-retirement.js";
import { getVerifiedMemorySource } from "./memory-source-identity.js";
import { populateMemoryRefs } from "./ref-populate.js";
import { getCachedScopeAuthorization } from "./scope-membership-cache.js";
import { buildDirectPeerCanonicalRequest } from "./sync-auth.js";
import { applyBootstrapSnapshot, mergeBootstrapSnapshot } from "./sync-bootstrap.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import {
	getReplicationCursor,
	getSyncResetState,
	loadMemorySnapshotPageForPeer,
} from "./sync-replication.js";
import { initTestSchema } from "./test-utils.js";
import type { SyncMemorySnapshotItem, SyncResetRequired } from "./types.js";

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
const relay = identity("relay");
const features = [MEMORY_RETIREMENT_FEATURE];
const now = "2026-09-21T12:00:00.000Z";
const qualified = (n: number) =>
	`memory-source-v1:c291cmNl:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const info: SyncResetRequired = {
	reset_required: true,
	reason: "generation_mismatch",
	generation: 2,
	snapshot_id: "snapshot-2",
	baseline_cursor: "2026-09-21T12:00:00.000Z|baseline",
	retained_floor_cursor: null,
	scope_id: "old",
};
let sender: InstanceType<typeof Database>;
let receiver: InstanceType<typeof Database>;
const receiverOptions = () => ({
	localDeviceId: recipient.deviceId,
	peer: requiredPeer(receiver, recipient.deviceId, source.deviceId),
	peerFeatures: features,
	now,
});
const senderOptions = () => ({
	localDeviceId: source.deviceId,
	peer: requiredPeer(sender, source.deviceId, recipient.deviceId),
	peerFeatures: features,
	now,
});

function requiredPeer(
	db: InstanceType<typeof Database>,
	localDeviceId: string,
	peerDeviceId: string,
) {
	const peer = getRetirementPeer(db, { localDeviceId, peerDeviceId });
	if (!peer) throw new Error("fixture_pairing_missing");
	return peer;
}

function pinPeer(db: InstanceType<typeof Database>, peer: typeof source) {
	db.prepare(
		"INSERT INTO sync_peers(peer_device_id, public_key, pinned_fingerprint, created_at) VALUES (?, ?, ?, ?)",
	).run(peer.deviceId, peer.publicKey, fingerprintPublicKey(peer.publicKey), now);
}

function coordinatorPair(db: InstanceType<typeof Database>, local: string, peer: typeof source) {
	const fresh = new Date().toISOString();
	db.prepare("DELETE FROM sync_peers WHERE peer_device_id = ?").run(peer.deviceId);
	db.prepare(`INSERT OR REPLACE INTO replication_scopes
		(scope_id, label, kind, authority_type, coordinator_id, group_id, membership_epoch, status, created_at, updated_at)
		VALUES ('old', 'Old', 'managed_project', 'coordinator', 'https://coord.example.test', 'group', 1, 'active', ?, ?)`).run(
		fresh,
		fresh,
	);
	for (const device of [local, peer.deviceId]) {
		db.prepare(`INSERT OR REPLACE INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at)
			VALUES ('old', ?, 'member', 'active', 1, ?)`).run(device, fresh);
	}
	db.prepare(`INSERT INTO scope_membership_cache_state(coordinator_id, group_id, last_refresh_at, last_success_at, last_error, updated_at)
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

function revokeLastScopeOnBothSides() {
	for (const [db, local, peer] of [
		[sender, source, recipient],
		[receiver, recipient, source],
	] as const) {
		db.prepare(
			"UPDATE scope_memberships SET status = 'revoked' WHERE device_id = 'recipient'",
		).run();
		expect(revokeUnauthorizedCoordinatorPeerTrust(db, local.deviceId)).toBe(1);
		expect(db.prepare("SELECT * FROM sync_peers").all()).toEqual([]);
		expect(requiredPeer(db, local.deviceId, peer.deviceId)).toEqual({
			deviceId: peer.deviceId,
			publicKey: peer.publicKey,
		});
		expect(
			getCachedScopeAuthorization(db, {
				deviceId: recipient.deviceId,
				scopeId: "old",
				authority: { coordinatorId: "https://coord.example.test", groupId: "group" },
			}),
		).toMatchObject({ authorized: false, freshness: "fresh" });
	}
}

function signed(
	value: unknown,
	signer: typeof source,
	destination: string,
	path: string,
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
function snapshot(
	n: number,
	scope: unknown = "old",
	metadata: Record<string, unknown> = {},
): SyncMemorySnapshotItem {
	return {
		entity_id: qualified(n),
		op_type: "upsert",
		clock_rev: 999999,
		clock_updated_at: now,
		clock_device_id: "claimed-origin",
		payload_json: JSON.stringify({
			title: "Snapshot content",
			body_text: "Stale page",
			scope_id: scope,
			visibility: "shared",
			origin_device_id: "claimed-origin",
			metadata_json: metadata,
		}),
	};
}
function queue(n: number) {
	sender.transaction(() =>
		queueMemoryRetirement(
			sender,
			{ entityId: qualified(n), sourceDeviceId: "source", retiredScopeId: "old" },
			{ localDeviceId: "source", now },
		),
	)();
}
function pageFor(request: RetirementResetRequest) {
	return serveRetirementReset(
		sender,
		signed(request, recipient, source.deviceId, RETIREMENT_RESET_REQUEST_PATH),
		senderOptions(),
	);
}
function exchange(request: RetirementResetRequest) {
	const page = pageFor(request);
	receiveRetirementResetPage(
		receiver,
		signed(page, source, recipient.deviceId, RETIREMENT_RESET_PAGE_PATH),
		receiverOptions(),
	);
	return page;
}
function start(resetInfo = info) {
	return beginRetirementReset(receiver, { ...receiverOptions(), resetInfo });
}

function seedReceiverPendingDelivery() {
	receiver
		.prepare(`INSERT INTO replication_scopes(scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at)
		VALUES ('old', 'Old', 'user', 'coordinator', 1, 'active', ?, ?)`)
		.run(now, now);
	receiver
		.prepare(`INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at)
		VALUES ('old', 'other', 'member', 'active', 1, ?)`)
		.run(now);
	receiver.transaction(() =>
		queueMemoryRetirement(
			receiver,
			{
				entityId: "memory-source-v1:cmVjaXBpZW50:00000000-0000-4000-8000-000000000010",
				sourceDeviceId: "recipient",
				retiredScopeId: "old",
			},
			{ localDeviceId: "recipient", now },
		),
	)();
}
function protectedApply(
	resetId: string,
	mode: "replace" | "merge",
	items: SyncMemorySnapshotItem[],
	resetInfo = info,
) {
	return applyRetirementProtectedSnapshot(receiver, {
		...receiverOptions(),
		resetId,
		mode,
		items,
		resetInfo,
	});
}
beforeEach(() => {
	sender = new Database(":memory:");
	receiver = new Database(":memory:");
	initTestSchema(sender);
	initTestSchema(receiver);
	pinPeer(sender, recipient);
	pinPeer(receiver, source);
	sender
		.prepare(`INSERT INTO replication_scopes(scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at)
		VALUES ('old', 'Old', 'user', 'coordinator', 1, 'active', ?, ?)`)
		.run(now, now);
	sender
		.prepare(`INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at)
		VALUES ('old', 'recipient', 'member', 'revoked', 1, ?)`)
		.run(now);
});

it("paginates a direct-source subset and merges it without deleting other authors or advancing their scope cursor", () => {
	const foreign = (name: string, n: number) => ({
		...snapshot(n),
		entity_id: `memory-source-v1:${Buffer.from(name).toString("base64url")}:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
	});
	const otherAuthors = [foreign("recipient", 1), foreign("aaa", 2), foreign("zzz", 3)];
	mergeBootstrapSnapshot(
		sender,
		"fixture",
		[snapshot(1), ...otherAuthors, snapshot(2), snapshot(3)],
		info,
	);
	mergeBootstrapSnapshot(receiver, "fixture", otherAuthors, info);
	const boundaryBefore = getSyncResetState(receiver, "old");
	const cursorBefore = getReplicationCursor(receiver, "source", "old");
	const request = start();
	exchange(request);
	const items: SyncMemorySnapshotItem[] = [];
	let pageToken: string | null = null;
	const seen = new Set<string>();
	do {
		const page = loadMemorySnapshotPageForPeer(sender, {
			scopeId: "old",
			sourceDeviceId: "source",
			generation: info.generation,
			snapshotId: info.snapshot_id,
			baselineCursor: info.baseline_cursor,
			pageToken,
			limit: 1,
		});
		items.push(...page.items);
		pageToken = page.nextPageToken;
		if (pageToken) {
			expect(seen.has(pageToken)).toBe(false);
			seen.add(pageToken);
		}
	} while (pageToken);
	expect(items.map((item) => item.entity_id)).toEqual([qualified(1), qualified(2), qualified(3)]);
	const options = {
		...receiverOptions(),
		resetId: request.resetId,
		resetInfo: info,
		items,
		contentMode: "source-only" as const,
	};
	const before = receiver.serialize();
	expect(() => applyRetirementProtectedSnapshot(receiver, { ...options, mode: "replace" })).toThrow(
		"retirement_snapshot_merge_required",
	);
	expect(receiver.serialize().equals(before)).toBe(true);
	expect(applyRetirementProtectedSnapshot(receiver, { ...options, mode: "merge" }).applied).toBe(3);
	expect(receiver.prepare("SELECT COUNT(*) FROM memory_items").pluck().get()).toBe(6);
	expect(getSyncResetState(receiver, "old")).toEqual(boundaryBefore);
	expect(getReplicationCursor(receiver, "source", "old")).toEqual(cursorBefore);
	expect(() =>
		applyRetirementProtectedSnapshot(receiver, { ...options, mode: "merge", items: otherAuthors }),
	).toThrow("retirement_snapshot_source_required");
});
afterEach(() => {
	sender.close();
	receiver.close();
});

it.each(["replace", "merge"] as const)(
	"uses only retained pins after actual final-scope revocation for %s reset",
	(mode) => {
		const retainedCopies = seedDuplicateSnapshotRows();
		coordinatorPair(sender, source.deviceId, recipient);
		coordinatorPair(receiver, recipient.deviceId, source);
		const request = start();
		revokeLastScopeOnBothSides();
		queue(1);
		sender.prepare("UPDATE memory_retirement_deliveries SET acknowledged_at = ?").run(now);
		const pins = [sender, receiver].map((db) =>
			db.prepare("SELECT * FROM memory_retirement_peer_trust").all(),
		);
		const deliveries = sender.prepare("SELECT * FROM memory_retirement_deliveries").all();
		let bytes = sender.serialize();
		sender.close();
		sender = new Database(bytes);
		initTestSchema(sender);
		bytes = receiver.serialize();
		receiver.close();
		receiver = new Database(bytes);
		initTestSchema(receiver);
		sender.prepare("DELETE FROM replication_ops").run();
		receiver.prepare("DELETE FROM replication_ops").run();
		exchange(request);
		expectRemainingCopies(retainedCopies);
		expect(protectedApply(request.resetId, mode, [snapshot(1), snapshot(1)]).applied).toBe(0);
		expect(isMemoryScopeRetired(receiver, qualified(1), "old")).toBe(true);
		expect(getVerifiedMemorySource(receiver, qualified(1))?.sourceDeviceId).toBe("source");
		expect(
			receiver
				.prepare("SELECT COUNT(*) FROM memory_items WHERE import_key = ? AND scope_id = 'new'")
				.pluck()
				.get(qualified(1)),
		).toBe(2);
		const retry = start();
		exchange(retry);
		expect(protectedApply(retry.resetId, mode, [snapshot(1)]).applied).toBe(0);
		expect(
			[sender, receiver].map((db) =>
				db.prepare("SELECT * FROM memory_retirement_peer_trust").all(),
			),
		).toEqual(pins);
		expect(sender.prepare("SELECT * FROM memory_retirement_deliveries").all()).toEqual(deliveries);
		for (const db of [sender, receiver]) {
			expect(db.prepare("SELECT * FROM sync_peers").all()).toEqual([]);
			expect(
				db
					.prepare(
						"SELECT 1 FROM sqlite_master WHERE name = 'idx_memory_retirement_deliveries_pending'",
					)
					.get(),
			).toBeTruthy();
		}
	},
);

it("requires the stored retirement pin at begin, serve, receive and protected apply", () => {
	coordinatorPair(sender, source.deviceId, recipient);
	coordinatorPair(receiver, recipient.deviceId, source);
	revokeLastScopeOnBothSides();
	queue(1);
	const request = start();
	const page = pageFor(request);
	const receiverClaim = {
		...receiverOptions(),
		peer: { deviceId: source.deviceId, publicKey: relay.publicKey },
	};
	const senderClaim = {
		...senderOptions(),
		peer: { deviceId: recipient.deviceId, publicKey: relay.publicKey },
	};
	const before = receiver.serialize();
	const senderBefore = sender.serialize();
	expect(() => beginRetirementReset(receiver, { ...receiverClaim, resetInfo: info })).toThrow(
		"retirement_peer_untrusted",
	);
	expect(() =>
		serveRetirementReset(
			sender,
			signed(request, relay, source.deviceId, RETIREMENT_RESET_REQUEST_PATH),
			senderClaim,
		),
	).toThrow("retirement_peer_untrusted");
	expect(() =>
		receiveRetirementResetPage(
			receiver,
			signed(page, relay, recipient.deviceId, RETIREMENT_RESET_PAGE_PATH),
			receiverClaim,
		),
	).toThrow("retirement_peer_untrusted");
	expect(sender.serialize().equals(senderBefore)).toBe(true);
	expect(receiver.serialize().equals(before)).toBe(true);
	exchange(request);
	const complete = receiver.serialize();
	expect(() =>
		applyRetirementProtectedSnapshot(receiver, {
			...receiverClaim,
			resetId: request.resetId,
			resetInfo: info,
			mode: "merge",
			items: [],
		}),
	).toThrow("retirement_peer_untrusted");
	expect(receiver.serialize().equals(complete)).toBe(true);
	// Later content re-pairing cannot overwrite the retained source authority.
	pinPeer(receiver, { ...relay, deviceId: source.deviceId });
	expect(() => beginRetirementReset(receiver, { ...receiverClaim, resetInfo: info })).toThrow(
		"retirement_peer_untrusted",
	);
	expect(receiverOptions().peer.publicKey).toBe(source.publicKey);
	expect(protectedApply(request.resetId, "merge", [snapshot(1)]).applied).toBe(0);
});

it("does not reconstruct reset authority from a claimed key or a different local device after revocation", () => {
	const options = receiverOptions();
	receiver.prepare("DELETE FROM sync_peers").run();
	const before = receiver.serialize();
	expect(() => beginRetirementReset(receiver, { ...options, resetInfo: info })).toThrow(
		"retirement_peer_untrusted",
	);
	expect(receiver.serialize().equals(before)).toBe(true);
	coordinatorPair(receiver, recipient.deviceId, source);
	receiver
		.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE device_id = 'recipient'")
		.run();
	expect(revokeUnauthorizedCoordinatorPeerTrust(receiver, recipient.deviceId)).toBe(1);
	expect(() =>
		beginRetirementReset(receiver, { ...options, localDeviceId: "another-local", resetInfo: info }),
	).toThrow("retirement_peer_untrusted");
});

function seedDuplicateSnapshotRows() {
	applyBootstrapSnapshot(receiver, "source", [snapshot(1), snapshot(1), snapshot(2)], info);
	applyBootstrapSnapshot(receiver, "source", [snapshot(1, "new"), snapshot(1, "new")], {
		...info,
		scope_id: "new",
	});
	const rows = receiver
		.prepare("SELECT id, import_key, scope_id FROM memory_items ORDER BY id")
		.all() as Array<{ id: number; import_key: string; scope_id: string }>;
	for (const row of rows) {
		populateMemoryRefs(receiver, row.id, [`file-${row.id}.ts`], null, [`concept-${row.id}`]);
		receiver
			.prepare(`INSERT INTO memory_vectors(memory_id, embedding, chunk_index, content_hash, model)
			VALUES (CAST(? AS INTEGER), ?, 0, 'fixture', 'fixture')`)
			.run(row.id, Buffer.from(new Float32Array(384).fill(1).buffer));
	}
	expect(
		rows.filter((row) => row.import_key === qualified(1) && row.scope_id === "old"),
	).toHaveLength(2);
	return rows
		.filter((row) => row.import_key !== qualified(1) || row.scope_id !== "old")
		.map((row) => row.id);
}

function expectRemainingCopies(ids: number[]) {
	expect(receiver.prepare("SELECT id FROM memory_items ORDER BY id").pluck().all()).toEqual(ids);
	for (const table of ["memory_file_refs", "memory_concept_refs", "memory_vectors"]) {
		expect(
			receiver.prepare(`SELECT memory_id FROM ${table} ORDER BY memory_id`).pluck().all(),
		).toEqual(ids);
	}
}

it("cleans every destructively imported duplicate before reset completion and protected merge retries", () => {
	const retained = seedDuplicateSnapshotRows();
	queue(1);
	const request = start();
	const page = exchange(request);
	expect(retirementResetProgress(receiver, request.resetId).complete).toBe(true);
	expectRemainingCopies(retained);
	expect(protectedApply(request.resetId, "merge", [snapshot(1), snapshot(1)]).applied).toBe(0);
	expectRemainingCopies(retained);
	const beforeRetry = receiver.serialize();
	receiveRetirementResetPage(
		receiver,
		signed(page, source, recipient.deviceId, RETIREMENT_RESET_PAGE_PATH),
		receiverOptions(),
	);
	expect(receiver.serialize().equals(beforeRetry)).toBe(true);
	expect(protectedApply(request.resetId, "merge", [snapshot(1)]).applied).toBe(0);
	expectRemainingCopies(retained);
});

it("rolls back all duplicate cleanup and reset state when a later copy cannot be deleted", () => {
	const retained = seedDuplicateSnapshotRows();
	queue(1);
	const request = start();
	receiver.exec(`CREATE TRIGGER fail_last_duplicate BEFORE DELETE ON memory_items
		WHEN OLD.scope_id = 'old' AND (SELECT COUNT(*) FROM memory_items WHERE import_key = OLD.import_key AND scope_id = OLD.scope_id) = 1
		BEGIN SELECT RAISE(ABORT, 'duplicate_delete_failed'); END`);
	const before = receiver.serialize();
	expect(() => exchange(request)).toThrow("duplicate_delete_failed");
	expect(receiver.serialize().equals(before)).toBe(true);
	expect(retirementResetProgress(receiver, request.resetId).complete).toBe(false);
	expect(isMemoryScopeRetired(receiver, qualified(1), "old")).toBe(false);
	receiver.exec("DROP TRIGGER fail_last_duplicate");
	exchange(request);
	expectRemainingCopies(retained);
	expect(retirementResetProgress(receiver, request.resetId).complete).toBe(true);
});

it.each(["replace", "merge"] as const)(
	"applies acknowledged controls before stale %s content while preserving durable authority and deliveries",
	(mode) => {
		queue(1);
		seedReceiverPendingDelivery();
		sender.prepare("UPDATE memory_retirement_deliveries SET acknowledged_at = ?").run(now);
		const stalePage = snapshot(1);
		const request = start();
		expect(() => protectedApply(request.resetId, mode, [stalePage])).toThrow(
			"retirement_reset_not_ready",
		);
		exchange(request);
		// Put a legitimate destination row beside the stale old-scope page.
		mergeBootstrapSnapshot(receiver, "source", [snapshot(1, "new")], { ...info, scope_id: "new" });
		const pending = receiver.prepare("SELECT * FROM memory_retirement_deliveries").all();
		const result = protectedApply(request.resetId, mode, [stalePage, snapshot(2)]);
		expect(result).toMatchObject({ ok: true, applied: 1 });
		expect(
			receiver
				.prepare("SELECT scope_id FROM memory_items WHERE import_key = ?")
				.pluck()
				.all(qualified(1)),
		).toEqual(["new"]);
		expect(isMemoryScopeRetired(receiver, qualified(1), "old")).toBe(true);
		expect(getVerifiedMemorySource(receiver, qualified(1))?.sourceDeviceId).toBe("source");
		expect(receiver.prepare("SELECT * FROM memory_retirement_deliveries").all()).toEqual(pending);
		expect(getVerifiedMemorySource(receiver, qualified(2))?.sourceDeviceId).toBe("source");
		expect(receiver.prepare("SELECT COUNT(*) FROM memory_retirement_receipts").pluck().get()).toBe(
			1,
		);
	},
);

it.each(["replace", "merge"] as const)(
	"rejects missing/mismatched scopes and metadata without old-scope resurrection in %s",
	(mode) => {
		queue(1);
		const request = start();
		exchange(request);
		for (const scope of [null, "", "  ", "old"]) {
			expect(protectedApply(request.resetId, mode, [snapshot(1, scope)]).applied).toBe(0);
		}
		expect(() => protectedApply(request.resetId, mode, [snapshot(1, "new")])).toThrow(
			"scope_mismatch",
		);
		const newInfo = { ...info, scope_id: "new" };
		const newRequest = start(newInfo);
		exchange(newRequest);
		expect(
			protectedApply(newRequest.resetId, mode, [snapshot(1, "new", { scope_id: "old" })], newInfo)
				.applied,
		).toBe(0);
		expect(receiver.prepare("SELECT COUNT(*) FROM memory_items").pluck().get()).toBe(0);
		expect(protectedApply(newRequest.resetId, mode, [snapshot(1, "new")], newInfo).applied).toBe(1);
	},
);

it("retains pending deliveries, immutable bindings and checkpoints over paginated restart/compaction and retry", () => {
	for (let n = 1; n <= 101; n++) queue(n);
	sender
		.prepare("UPDATE memory_retirement_deliveries SET acknowledged_at = ? WHERE entity_id != ?")
		.run(now, qualified(101));
	const request = start();
	const page = exchange(request);
	expect(page.controls).toHaveLength(100);
	expect(page.complete).toBe(false);
	expect(() => protectedApply(request.resetId, "replace", [snapshot(101)])).toThrow(
		"retirement_reset_not_ready",
	);
	let bytes = sender.serialize();
	sender.close();
	sender = new Database(bytes);
	bytes = receiver.serialize();
	receiver.close();
	receiver = new Database(bytes);
	sender.prepare("DELETE FROM replication_ops").run();
	receiver.prepare("DELETE FROM replication_ops").run();
	// Repeated signed page is idempotent after restart; no rewinding of the reset checkpoint.
	receiveRetirementResetPage(
		receiver,
		signed(page, source, recipient.deviceId, RETIREMENT_RESET_PAGE_PATH),
		receiverOptions(),
	);
	const progress = retirementResetProgress(receiver, request.resetId);
	expect(progress.request.offset).toBe(100);
	exchange(progress.request);
	expect(retirementResetProgress(receiver, request.resetId).complete).toBe(true);
	expect(protectedApply(request.resetId, "merge", [snapshot(101)]).applied).toBe(0);
	expect(
		sender
			.prepare("SELECT COUNT(*) FROM memory_retirement_deliveries WHERE acknowledged_at IS NULL")
			.pluck()
			.get(),
	).toBe(1);
	expect(receiver.prepare("SELECT COUNT(*) FROM memory_source_bindings").pluck().get()).toBe(101);
});

it("pins controls to source signatures, challenge and recipient rather than relay claims or origin metadata", () => {
	queue(1);
	const request = start();
	const page = pageFor(request);
	const before = receiver.serialize();
	expect(() =>
		receiveRetirementResetPage(
			receiver,
			signed(page, relay, recipient.deviceId, RETIREMENT_RESET_PAGE_PATH),
			receiverOptions(),
		),
	).toThrow("retirement_authentication_failed");
	expect(() =>
		receiveRetirementResetPage(
			receiver,
			signed(page, relay, recipient.deviceId, RETIREMENT_RESET_PAGE_PATH),
			{ ...receiverOptions(), peer: relay },
		),
	).toThrow("retirement_peer_untrusted");
	expect(() =>
		receiveRetirementResetPage(
			receiver,
			signed(page, source, "someone-else", RETIREMENT_RESET_PAGE_PATH),
			receiverOptions(),
		),
	).toThrow("retirement_authentication_failed");
	expect(receiver.serialize().equals(before)).toBe(true);
	exchange(request);
	const fresh = start();
	expect(() => protectedApply(fresh.resetId, "replace", [snapshot(1)])).toThrow(
		"retirement_reset_not_ready",
	);
	expect(() =>
		protectedApply(request.resetId, "replace", [snapshot(1)], {
			...info,
			snapshot_id: "different",
		}),
	).toThrow("retirement_reset_not_ready");
	expect(() =>
		protectedApply(request.resetId, "replace", [{ ...snapshot(1), entity_id: "historical-uuid" }]),
	).toThrow("memory_source_verification_required");
	expect(() =>
		protectedApply(request.resetId, "replace", [
			{
				...snapshot(1),
				entity_id: "memory-source-v1:cmVsYXk:00000000-0000-4000-8000-000000000001",
			},
		]),
	).toThrow("retirement_snapshot_source_required");
});

it("authenticates reset requests and never transfers another recipient's acknowledged controls", () => {
	pinPeer(sender, relay);
	queue(1);
	const request = start();
	expect(() =>
		serveRetirementReset(
			sender,
			signed(request, relay, source.deviceId, RETIREMENT_RESET_REQUEST_PATH),
			senderOptions(),
		),
	).toThrow("retirement_authentication_failed");
	const other = serveRetirementReset(
		sender,
		signed(request, relay, source.deviceId, RETIREMENT_RESET_REQUEST_PATH),
		{ ...senderOptions(), peer: relay },
	);
	expect(other.controls).toEqual([]);
	expect(other.recipientDeviceId).toBe("relay");
	expect(() =>
		serveRetirementReset(
			sender,
			signed(request, recipient, source.deviceId, RETIREMENT_RESET_REQUEST_PATH),
			{ ...senderOptions(), peerFeatures: ["reassign_scope"] },
		),
	).toThrow("retirement_feature_required");
});

it("rolls back page controls and completion on failure and retries against the same source manifest", () => {
	queue(1);
	const request = start();
	const page = pageFor(request);
	receiver.exec(
		"CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON memory_retirement_reset_receivers BEGIN SELECT RAISE(ABORT, 'checkpoint_failed'); END",
	);
	const before = receiver.serialize();
	expect(() =>
		receiveRetirementResetPage(
			receiver,
			signed(page, source, recipient.deviceId, RETIREMENT_RESET_PAGE_PATH),
			receiverOptions(),
		),
	).toThrow("checkpoint_failed");
	expect(receiver.serialize().equals(before)).toBe(true);
	receiver.exec("DROP TRIGGER reject_checkpoint");
	expect(pageFor(request)).toEqual(page);
	exchange(request);
	expect(retirementResetProgress(receiver, request.resetId).complete).toBe(true);
});

it.each(["replace", "merge"] as const)(
	"rechecks fences received after snapshot fetch and rolls back failed %s content without losing controls",
	(mode) => {
		const request = start();
		exchange(request);
		const stale = snapshot(2);
		queue(2);
		const refresh = start();
		exchange(refresh);
		expect(protectedApply(request.resetId, mode, [stale]).applied).toBe(0);
		receiver.exec(
			"CREATE TRIGGER fail_snapshot BEFORE INSERT ON memory_items BEGIN SELECT RAISE(ABORT, 'snapshot_failed'); END",
		);
		const before = receiver.serialize();
		expect(() => protectedApply(request.resetId, mode, [snapshot(3)])).toThrow("snapshot_failed");
		expect(receiver.serialize().equals(before)).toBe(true);
		expect(isMemoryScopeRetired(receiver, qualified(2), "old")).toBe(true);
		expect(getVerifiedMemorySource(receiver, qualified(3))).toBeNull();
		receiver.exec("DROP TRIGGER fail_snapshot");
		expect(protectedApply(request.resetId, mode, [snapshot(3)]).applied).toBe(1);
	},
);

it("filters retired snapshot export while preserving unrelated and valid destination content", () => {
	applyBootstrapSnapshot(sender, "recipient", [snapshot(1), snapshot(2)], info);
	queue(1);
	const boundary = getSyncResetState(sender, "old");
	const page = loadMemorySnapshotPageForPeer(sender, {
		scopeId: "old",
		peerDeviceId: "recipient",
		generation: boundary.generation,
		snapshotId: boundary.snapshot_id,
		baselineCursor: boundary.baseline_cursor,
	});
	expect(page.items.map((item) => item.entity_id)).toEqual([qualified(2)]);
	sender
		.prepare("UPDATE memory_items SET import_key = ? WHERE import_key = ?")
		.run(` ${qualified(1)} `, qualified(1));
	expect(
		loadMemorySnapshotPageForPeer(sender, {
			scopeId: "old",
			peerDeviceId: "recipient",
			generation: boundary.generation,
			snapshotId: boundary.snapshot_id,
			baselineCursor: boundary.baseline_cursor,
		}).items.map((item) => item.entity_id),
	).toEqual([qualified(2)]);
	sender
		.prepare("UPDATE memory_items SET import_key = ? WHERE import_key = ?")
		.run(qualified(1), ` ${qualified(1)} `);
	sender.prepare("UPDATE memory_items SET scope_id = 'new' WHERE import_key = ?").run(qualified(1));
	const newBoundary = getSyncResetState(sender, "new");
	const options = {
		scopeId: "new",
		peerDeviceId: "recipient",
		generation: newBoundary.generation,
		snapshotId: newBoundary.snapshot_id,
		baselineCursor: newBoundary.baseline_cursor,
	};
	expect(loadMemorySnapshotPageForPeer(sender, options).items).toHaveLength(1);
	sender
		.prepare("UPDATE memory_items SET metadata_json = ? WHERE import_key = ?")
		.run(JSON.stringify({ scope_id: "old" }), qualified(1));
	expect(loadMemorySnapshotPageForPeer(sender, options).items).toEqual([]);
});
