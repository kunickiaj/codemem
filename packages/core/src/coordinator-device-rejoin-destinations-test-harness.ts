import { expect, it } from "vitest";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import { readDeviceRejoinDestinations } from "./coordinator-device-rejoin-destinations.js";

type Fixture = Pick<AuthLinkBackend, "first"> & {
	run(sql: string, ...values: (string | number | null)[]): Promise<unknown>;
};

const KEY_ID = "a".repeat(64);
const ATTEMPT = { coordinatorId: "coordinator", attemptId: "attempt" };

async function seedAttempt(
	db: Fixture,
	groups: { group: string; identity?: string | null; archived?: boolean; alias?: boolean }[],
) {
	await db.run(
		`INSERT INTO coordinator_device_ownership_bindings
		(device_id, key_id, coordinator_id, identity_id, binding_id, provenance, source_ref, bound_at)
		VALUES ('device', ?, 'coordinator', 'identity', 'binding', 'owner_enrollment', 'fixture', 'then')`,
		KEY_ID,
	);
	const own: [number, string, string, string][] = [];
	const aliases: number[] = [];
	for (const [index, { group, identity, archived, alias }] of groups.entries()) {
		await db.run(
			"INSERT INTO groups(group_id, created_at, archived_at) VALUES (?, 'then', ?)",
			group,
			archived ? "then" : null,
		);
		const seq = index + 1;
		await db.run(
			`INSERT INTO coordinator_device_removals
			(removal_seq, removal_id, group_id, device_id, public_key, fingerprint, key_id, identity_id, removed_at)
			VALUES (?, 'removal', ?, ?, 'fixture-key', 'fixture-fingerprint', ?, ?, 'then')`,
			seq,
			group,
			alias ? "alias" : "device",
			KEY_ID,
			identity === undefined ? "identity" : identity,
		);
		if (alias) aliases.push(seq);
		else own.push([seq, group, "fixture-key", "fixture-fingerprint"]);
	}
	await db.run(
		`INSERT INTO coordinator_device_rejoin_attempts (
		coordinator_id, attempt_id, origin, device_id, public_key, key_id, fingerprint, identity_id, binding_id,
		issuer, auth_config_revision, removal_digest, own_tombstones_json, alias_removal_seqs_json,
		browser_start_hash, loopback_redirect, created_at_ms, expires_at_ms)
		VALUES ('coordinator', 'attempt', 'https://coordinator.example.test', 'device', 'fixture-key', ?,
		'fixture-fingerprint', 'identity', 'binding', 'issuer', 'revision', 'digest', ?, ?, ?,
		'http://127.0.0.1:12345/codemem/auth/complete', 1, 600001)`,
		KEY_ID,
		JSON.stringify(own),
		JSON.stringify(aliases),
		"b".repeat(64),
	);
}

function seedGrant(
	db: Fixture,
	group: string,
	status: "active" | "revoked",
	coordinator = "coordinator",
) {
	return db.run(
		`INSERT INTO coordinator_identity_group_grants
		(coordinator_id, identity_id, group_id, status, revision, source_kind, source_receipt_id, created_at, revoked_at)
		VALUES (?, 'identity', ?, ?, 3, 'controller_attestation', 'fixture', 'then', ?)`,
		coordinator,
		group,
		status,
		status === "revoked" ? "then" : null,
	);
}

function seedExclusion(db: Fixture, group: string) {
	return db.run(
		`INSERT INTO coordinator_legacy_team_completions
		(group_id, candidate_ref, manifest_version, manifest_json, completed_at, created_at)
		VALUES (?, 'fixture', 1, ?, 'then', 'then')`,
		group,
		JSON.stringify({
			coordinator_id: "coordinator",
			device_decisions: [
				{ decision: "excluded", device_id: "device", key_fingerprint: "fixture-fingerprint" },
			],
		}),
	);
}

function effects(db: Fixture) {
	return db.first({
		sql: `SELECT
		(SELECT json_group_array(state) FROM coordinator_device_rejoin_attempts) AS attempts,
		(SELECT count(*) FROM coordinator_device_rejoin_audit_log) AS audit,
		(SELECT count(*) FROM enrolled_devices) AS enrollment,
		(SELECT count(*) FROM coordinator_device_removals WHERE lifted_at IS NULL) AS removals`,
		values: [],
	});
}

export function registerRejoinDestinationTests(
	withFixture: (use: (db: Fixture) => Promise<void>) => Promise<void>,
) {
	it("classifies only own tombstone groups with current grant and exclusion evidence", () =>
		withFixture(async (db) => {
			await seedAttempt(db, [
				{ group: "revoked" },
				{ group: "same-identity" },
				{ group: "active", identity: "previous" },
				{ group: "archived", archived: true },
				{ group: "excluded" },
				{ group: "other", identity: "previous" },
				{ group: "null-identity", identity: null },
				{ group: "alias", alias: true },
			]);
			await seedGrant(db, "active", "active");
			await seedGrant(db, "revoked", "revoked");
			await seedGrant(db, "excluded", "active");
			await seedGrant(db, "archived", "active");
			await seedGrant(db, "alias", "active");
			await seedGrant(db, "other", "active", "another-coordinator");
			await seedExclusion(db, "excluded");
			const before = await effects(db);
			expect(await readDeviceRejoinDestinations(db, ATTEMPT)).toEqual({
				destinations: [
					{ groupId: "active", grantRevision: 3 },
					{ groupId: "same-identity", grantRevision: null },
				],
				nonDestinations: [
					{ groupId: "archived", reason: "archived" },
					{ groupId: "excluded", reason: "excluded" },
					{ groupId: "null-identity", reason: "identity_changed" },
					{ groupId: "other", reason: "identity_changed" },
					{ groupId: "revoked", reason: "grant_revoked" },
				],
			});
			expect(await effects(db)).toEqual(before);
		}));
	registerStaleTests(withFixture);
}

function registerStaleTests(withFixture: (use: (db: Fixture) => Promise<void>) => Promise<void>) {
	it("distinguishes no destination from changed or missing evidence", () =>
		withFixture(async (db) => {
			await seedAttempt(db, [{ group: "archived", archived: true }]);
			expect(await readDeviceRejoinDestinations(db, ATTEMPT)).toEqual({
				destinations: [],
				nonDestinations: [{ groupId: "archived", reason: "archived" }],
			});
			expect(
				await readDeviceRejoinDestinations(db, { ...ATTEMPT, coordinatorId: "other" }),
			).toBeNull();
			await db.run(
				`UPDATE coordinator_device_removals SET lifted_at = 'later', lifted_by_invite_id = 'fixture'`,
			);
			expect(await readDeviceRejoinDestinations(db, ATTEMPT)).toBeNull();
		}));

	it("rejects a new same-key alias instead of evaluating a stale attempt", () =>
		withFixture(async (db) => {
			await seedAttempt(db, [{ group: "own" }]);
			await db.run(
				`INSERT INTO coordinator_device_removals
			(removal_id, group_id, device_id, public_key, fingerprint, key_id, removed_at)
			VALUES ('later-removal', 'other', 'alias', 'fixture-key', 'fixture-fingerprint', ?, 'later')`,
				KEY_ID,
			);
			expect(await readDeviceRejoinDestinations(db, ATTEMPT)).toBeNull();
		}));

	it("rejects an otherwise eligible group after permanent block", () =>
		withFixture(async (db) => {
			await seedAttempt(db, [{ group: "own" }]);
			await db.run(
				`INSERT INTO coordinator_device_revocations
			(subject_kind, subject_value, revocation_id, evidence_group_id, evidence_device_id,
			 evidence_public_key, evidence_fingerprint, created_at)
			VALUES ('ed25519_key', ?, 'block', 'own', 'device', 'fixture-key', 'fixture-fingerprint', 'later')`,
				KEY_ID,
			);
			expect(await readDeviceRejoinDestinations(db, ATTEMPT)).toBeNull();
		}));
}
