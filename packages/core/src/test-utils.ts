/**
 * Test utilities for the codemem TS backend.
 */

import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import type { Database } from "./db.js";
import { recordOpCopy } from "./memory-copy-provenance.js";
import { bootstrapSchema } from "./schema-bootstrap.js";
import { LOCAL_DEFAULT_SCOPE_ID } from "./scope-resolution.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

/**
 * Create the full schema for test databases.
 */
export function initTestSchema(db: Database): void {
	bootstrapSchema(db);
}

/**
 * Insert a pairing. Sync progress is written only for a peer that has one. It
 * pins the key the test refresh helper proves by default.
 */
export function insertTestPeer(db: Database, peerDeviceId: string): void {
	db.prepare(
		`INSERT OR IGNORE INTO sync_peers(peer_device_id, public_key, pinned_fingerprint, created_at)
		 VALUES (?, ?, ?, ?)`,
	).run(
		peerDeviceId,
		CANONICAL_PUBLIC_KEY,
		fingerprintPublicKey(CANONICAL_PUBLIC_KEY),
		new Date().toISOString(),
	);
}

/** The full test schema plus a pairing for each peer the test writes sync progress for. */
export function initTestSchemaWithPeers(db: Database, peerDeviceIds: string[]): void {
	initTestSchema(db);
	for (const peerDeviceId of peerDeviceIds) insertTestPeer(db, peerDeviceId);
}

/**
 * Store the copy a hand-built outbound op was recorded from, in the op's scope,
 * at the op's revision and with the content and Project its payload names, and
 * name it as the op's copy. Sync sends an op's content only from its own copy.
 */
export function insertTestMemoryForOp(
	db: Database,
	op: {
		op_id?: string;
		entity_id: string;
		scope_id?: string | null;
		payload_json?: string | null;
		clock_rev?: number;
	},
): number {
	const payload = (op.payload_json ? JSON.parse(op.payload_json) : {}) as Record<string, unknown>;
	const text = (field: string, fallback: string | null = null) =>
		typeof payload[field] === "string" ? (payload[field] as string) : fallback;
	const list = (field: string) =>
		Array.isArray(payload[field]) ? JSON.stringify(payload[field]) : null;
	const now = new Date().toISOString();
	const session = db
		.prepare("INSERT INTO sessions(started_at, project, user, tool_version) VALUES (?, ?, ?, ?)")
		.run(now, text("project"), "test-user", "test");
	const info = db
		.prepare(
			`INSERT INTO memory_items(session_id, kind, title, subtitle, body_text, narrative, tags_text,
			 facts, concepts, files_read, files_modified, actor_id, visibility, workspace_id,
			 workspace_kind, active, deleted_at, created_at, updated_at, metadata_json, import_key, scope_id, rev)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
		)
		.run(
			Number(session.lastInsertRowid),
			text("kind", "discovery"),
			text("title", "Fixture memory"),
			text("subtitle"),
			text("body_text", "fixture content"),
			text("narrative"),
			text("tags_text", ""),
			list("facts"),
			list("concepts"),
			list("files_read"),
			list("files_modified"),
			text("actor_id"),
			Object.hasOwn(payload, "visibility") ? text("visibility") : "shared",
			text("workspace_id"),
			text("workspace_kind"),
			typeof payload.active === "number" ? payload.active : 1,
			text("deleted_at"),
			now,
			now,
			op.entity_id,
			op.scope_id ?? null,
			op.clock_rev ?? 1,
		);
	const memoryId = Number(info.lastInsertRowid);
	// The op names the copy it was recorded from, as recorded ops do.
	if (op.op_id) recordOpCopy(db, op.op_id, memoryId);
	return memoryId;
}

/**
 * Insert a minimal test session and return its ID.
 */
export function insertTestSession(db: Database): number {
	const now = new Date().toISOString();
	const info = db
		.prepare(
			"INSERT INTO sessions(started_at, cwd, project, user, tool_version) VALUES (?, ?, ?, ?, ?)",
		)
		.run(now, "/tmp/test", "test-project", "test-user", "test");
	return Number(info.lastInsertRowid);
}

export interface MixedScopeFixture {
	sessionId: number;
	deviceId: string;
	authorizedScopeId: string;
	unauthorizedScopeId: string;
	personalId: number;
	authorizedId: number;
	unauthorizedId: number;
	visibleIds: number[];
	allIds: number[];
	visibleTitles: string[];
	unauthorizedTitle: string;
	query: string;
}

/**
 * Seed one mixed-domain dataset for scope-leak regression tests.
 *
 * The local-default "personal" row and the authorized work row must be visible;
 * the OSS row is in an active coordinator scope without local membership and
 * must never appear through read/export surfaces.
 */
export function seedMixedScopeFixture(db: Database, deviceId = "local"): MixedScopeFixture {
	const now = "2026-04-01T00:00:00.000Z";
	const authorizedScopeId = "fixture-work-authorized";
	const unauthorizedScopeId = "fixture-oss-hidden";
	const query = "mixedscopeleak";
	db.prepare(
		"INSERT OR IGNORE INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
	).run(deviceId, "fixture-public-key", "fixture-fingerprint", now);
	db.prepare(
		`INSERT OR REPLACE INTO replication_scopes(
			scope_id, label, kind, authority_type, coordinator_id, group_id,
			membership_epoch, status, created_at, updated_at
		 ) VALUES (?, ?, 'team', 'coordinator', 'fixture-coordinator', 'fixture-group', 0, 'active', ?, ?)`,
	).run(authorizedScopeId, "Authorized work fixture", now, now);
	db.prepare(
		`INSERT OR REPLACE INTO replication_scopes(
			scope_id, label, kind, authority_type, coordinator_id, group_id,
			membership_epoch, status, created_at, updated_at
		 ) VALUES (?, ?, 'team', 'coordinator', 'fixture-coordinator', 'fixture-group', 0, 'active', ?, ?)`,
	).run(unauthorizedScopeId, "Hidden OSS fixture", now, now);
	db.prepare(
		`INSERT OR REPLACE INTO scope_memberships(
			scope_id, device_id, role, status, membership_epoch,
			coordinator_id, group_id, updated_at
		 ) VALUES (?, ?, 'member', 'active', 0, 'fixture-coordinator', 'fixture-group', ?)`,
	).run(authorizedScopeId, deviceId, now);

	const session = db
		.prepare(
			`INSERT INTO sessions(started_at, cwd, project, user, tool_version, metadata_json, import_key)
			 VALUES (?, '/tmp/mixed-domain-fixture', 'mixed-domain-fixture', 'test-user', 'test', '{}', 'fixture-session')`,
		)
		.run(now);
	const sessionId = Number(session.lastInsertRowid);
	const insertMemory = (input: {
		title: string;
		body: string;
		kind: string;
		createdAt: string;
		scopeId: string;
		importKey: string;
	}) => {
		const info = db
			.prepare(
				`INSERT INTO memory_items(
					session_id, kind, title, body_text, confidence, tags_text, active,
					created_at, updated_at, metadata_json, rev, visibility, scope_id, import_key
				 ) VALUES (?, ?, ?, ?, 0.9, '', 1, ?, ?, '{}', 1, 'shared', ?, ?)`,
			)
			.run(
				sessionId,
				input.kind,
				input.title,
				input.body,
				input.createdAt,
				input.createdAt,
				input.scopeId,
				input.importKey,
			);
		return Number(info.lastInsertRowid);
	};
	const personalTitle = "Personal mixed-domain fixture memory";
	const authorizedTitle = "Authorized work mixed-domain fixture memory";
	const unauthorizedTitle = "Hidden OSS mixed-domain fixture memory";
	const personalId = insertMemory({
		title: personalTitle,
		body: `${query} personal visible context`,
		kind: "discovery",
		createdAt: "2026-04-01T00:00:01.000Z",
		scopeId: LOCAL_DEFAULT_SCOPE_ID,
		importKey: "fixture-memory-personal",
	});
	const unauthorizedId = insertMemory({
		title: unauthorizedTitle,
		body: `${query} hidden oss context`,
		kind: "feature",
		createdAt: "2026-04-01T00:00:02.000Z",
		scopeId: unauthorizedScopeId,
		importKey: "fixture-memory-hidden-oss",
	});
	const authorizedId = insertMemory({
		title: authorizedTitle,
		body: `${query} authorized work context`,
		kind: "decision",
		createdAt: "2026-04-01T00:00:03.000Z",
		scopeId: authorizedScopeId,
		importKey: "fixture-memory-authorized-work",
	});
	return {
		sessionId,
		deviceId,
		authorizedScopeId,
		unauthorizedScopeId,
		personalId,
		authorizedId,
		unauthorizedId,
		visibleIds: [personalId, authorizedId],
		allIds: [personalId, unauthorizedId, authorizedId],
		visibleTitles: [personalTitle, authorizedTitle],
		unauthorizedTitle,
		query,
	};
}

// Re-export for test convenience
export { MemoryStore } from "./store.js";
