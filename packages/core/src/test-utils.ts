/**
 * Test utilities for the codemem TS backend.
 */

import type { Database } from "./db.js";
import { bootstrapSchema } from "./schema-bootstrap.js";
import { LOCAL_DEFAULT_SCOPE_ID } from "./scope-resolution.js";

/**
 * Create the full schema for test databases.
 */
export function initTestSchema(db: Database): void {
	bootstrapSchema(db);
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
