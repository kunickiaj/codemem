import { join } from "node:path";
import Database from "better-sqlite3";
import type { Database as DatabaseConnection } from "../db.js";
import { bootstrapSchema } from "../schema-bootstrap.js";
import type { SemanticSearchScopeContext } from "../vectors.js";

export const MODEL = "fixture-model";
const NOW = "2026-01-01T00:00:00.000Z";

export function vector(value = 0): Float32Array {
	const result = new Float32Array(384);
	result[0] = value;
	return result;
}

export interface RankingFixture {
	db: DatabaseConnection;
	path: string;
	context: SemanticSearchScopeContext;
	memory(scopeId?: string): number;
	rawVector(memoryId: number, value: Float32Array, chunkIndex?: number, model?: string): number;
	snapshot(): { memories: unknown[]; vectors: unknown[] };
}

export function createFixture(directory: string): RankingFixture {
	const path = join(directory, "fixture.sqlite");
	const db = new Database(path);
	bootstrapSchema(db);
	db.prepare("INSERT INTO sessions(started_at, project) VALUES (?, 'fixture')").run(NOW);
	db.prepare(
		`INSERT INTO replication_scopes(scope_id, label, kind, authority_type,
		 coordinator_id, group_id, membership_epoch, status, created_at, updated_at)
		 VALUES ('hidden', 'Hidden', 'team', 'coordinator', 'fixture', 'fixture', 0, 'active', ?, ?)`,
	).run(NOW, NOW);
	const context: SemanticSearchScopeContext = {
		actorId: "local:fixture-device",
		deviceId: "fixture-device",
		scopeVisibilityDb: db,
	};
	function memory(scopeId = "local-default") {
		return Number(
			db
				.prepare(
					`INSERT INTO memory_items(session_id, kind, title, body_text, confidence, tags_text,
				 active, created_at, updated_at, metadata_json, rev, visibility, scope_id,
				 actor_id, origin_device_id)
				 VALUES (1, 'discovery', 'Fixture', 'Body', 0.5, '', 1, ?, ?, '{}', 1, 'shared', ?, ?, ?)`,
				)
				.run(NOW, NOW, scopeId, context.actorId, context.deviceId).lastInsertRowid,
		);
	}
	function rawVector(memoryId: number, value: Float32Array, chunkIndex = 0, model = MODEL) {
		return Number(
			db
				.prepare(
					`INSERT INTO memory_vectors(embedding, memory_id, chunk_index, content_hash, model)
				 VALUES (?, ?, ?, ?, ?)`,
				)
				.run(
					Buffer.from(value.buffer, value.byteOffset, value.byteLength),
					BigInt(memoryId),
					BigInt(chunkIndex),
					`hash-${memoryId}-${chunkIndex}`,
					model,
				).lastInsertRowid,
		);
	}
	function snapshot() {
		return {
			memories: db.prepare("SELECT * FROM memory_items ORDER BY id").all(),
			vectors: db.prepare("SELECT rowid, * FROM memory_vectors ORDER BY rowid").all(),
		};
	}
	return { db, path, context, memory, rawVector, snapshot };
}
