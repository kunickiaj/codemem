import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "../../packages/core/src/db.js";
import {
	cacheMember,
	cacheScope,
	refreshTestScopeRows,
} from "../../packages/core/src/scope-membership-cache-test-fixtures.js";
import {
	getEffectiveCachedScopeAuthorization,
	upsertCachedScopeMemberships,
} from "../../packages/core/src/scope-membership-cache.js";
import { ensureDeviceIdentity, loadPublicKey } from "../../packages/core/src/sync-identity.js";
import { recordReplicationOp } from "../../packages/core/src/sync-replication.js";
import { initTestSchema, insertTestSession } from "../../packages/core/src/test-utils.js";
import {
	prepareScopeServingStore,
	storeScopeServingEnvelope,
} from "../../packages/core/src/scope-serving-proof-store.js";

export const scopes = ["fixture-team", "fixture-project"];
export const groupId = "fixture-group";
export function peer(home: string, coordinator: string) {
	mkdirSync(home);
	const dbPath = join(home, "fixture.sqlite");
	const keysDir = join(home, "keys");
	const db = connect(dbPath);
	initTestSchema(db);
	const [deviceId, fingerprint] = ensureDeviceIdentity(db, { keysDir });
	const publicKey = loadPublicKey(keysDir);
	assert.ok(publicKey);
	const config = join(home, "config.json");
	writeFileSync(
		config,
		JSON.stringify({ sync_coordinator_url: coordinator, sync_coordinator_group: groupId }),
	);
	return {
		db,
		dbPath,
		deviceId,
		keysDir,
		publicKey,
		fingerprint,
		env: {
			HOME: home,
			PATH: process.env.PATH,
			CODEMEM_CONFIG: config,
			CODEMEM_DB: dbPath,
			CODEMEM_KEYS_DIR: keysDir,
			CODEMEM_SYNC_KEY_STORE: "file",
			CODEMEM_EMBEDDING_DISABLED: "1",
		},
	};
}
export type Peer = ReturnType<typeof peer>;

export async function prime(p: Peer, other: Peer, coordinatorId: string) {
	p.db
		.prepare(
			"INSERT INTO sync_peers(peer_device_id,public_key,pinned_fingerprint,created_at) VALUES (?,?,?,?)",
		)
		.run(other.deviceId, other.publicKey, other.fingerprint, new Date().toISOString());
	for (const scopeId of scopes) {
		const scope = cacheScope({
			scope_id: scopeId,
			kind: scopeId === scopes[0] ? "team" : "managed_project",
			coordinator_id: coordinatorId,
			group_id: groupId,
		});
		p.db
			.prepare(`INSERT INTO replication_scopes(scope_id,label,kind,authority_type,coordinator_id,group_id,membership_epoch,status,created_at,updated_at)
			VALUES (@scope_id,@label,@kind,@authority_type,@coordinator_id,@group_id,@membership_epoch,@status,@created_at,@updated_at)`)
			.run(scope);
		upsertCachedScopeMemberships(p.db, [
			cacheMember(scope, p.deviceId),
			cacheMember(scope, other.deviceId),
		]);
	}
	await refreshTestScopeRows(p.db, {
		[p.deviceId]: p.publicKey,
		[other.deviceId]: other.publicKey,
	});
}

export function seedCanaries(p: Peer) {
	const sessionId = insertTestSession(p.db);
	const now = new Date().toISOString();
	return scopes.map((scopeId) => {
		const key = `memory-source-v1:${Buffer.from(p.deviceId).toString("base64url")}:${randomUUID()}`;
		const row = p.db
			.prepare(`INSERT INTO memory_items(session_id,kind,title,body_text,confidence,active,created_at,updated_at,
			metadata_json,rev,visibility,scope_id,import_key,origin_device_id)
			VALUES (?,'discovery','Synthetic transfer check',?,1,1,?,?,'{}',1,'shared',?,?,?)`)
			.run(sessionId, `offline-proof-synthetic-body:${key}`, now, now, scopeId, key, p.deviceId);
		recordReplicationOp(p.db, {
			memoryId: Number(row.lastInsertRowid),
			opType: "upsert",
			deviceId: p.deviceId,
			scopeId,
		});
		return key;
	});
}

export function transition(p: Peer, other: Peer, coordinatorId: string, generation: string) {
	const prepared = { coordinatorId, groupId, generation };
	// Put even legacy-decodable bytes in the new table. Isolation must follow
	// from where the released clients look, not from malformed test bytes.
	const proofs = scopes.flatMap((scopeId) =>
		[p, other].map((member) => {
			const { keyId } = getEffectiveCachedScopeAuthorization(p.db, {
				scopeId,
				deviceId: member.deviceId,
				expectedPublicKey: member.publicKey,
			});
			assert.ok(keyId);
			const evidence = p.db
				.prepare(`SELECT evidence_json FROM scope_membership_authorization_evidence
			WHERE coordinator_id=? AND group_id=? AND scope_id=? AND device_id=?`)
				.pluck()
				.get(coordinatorId, groupId, scopeId, member.deviceId);
			assert.equal(typeof evidence, "string");
			return { scopeId, deviceId: member.deviceId, keyId, envelope: Buffer.from(String(evidence)) };
		}),
	);
	prepareScopeServingStore(p.db, prepared);
	for (const proof of proofs) storeScopeServingEnvelope(p.db, { ...prepared, ...proof });
	assert.equal(p.db.prepare("SELECT count(*) FROM scope_serving_proofs_v2").pluck().get(), 4);
}
