import { expect, it } from "vitest";
import {
	changeFixture,
	changeTable,
	config,
	hash,
	input,
	protectedTables,
} from "../../cloudflare-coordinator-worker/test/account-change-fixture.js";
import { otherKey } from "../../cloudflare-coordinator-worker/test/device-claim-eligibility-fixture.js";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import { setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";

const test = it.extend<{ f: Awaited<ReturnType<typeof fixture>> }>({
	f: async ({ task: _task }, use) => {
		const f = await fixture();
		try {
			await use(f);
		} finally {
			await f.store.close();
		}
	},
});
async function fixture(authority: "device_claim" | "controller_attestation" = "device_claim") {
	const base = setupStore("SQLite", { authClock: () => 1791028800000 });
	const hooks: { beforeBatch?: () => void; afterBatch?: () => void } = {};
	const db = sqliteD1(base.db, {
		beforeBatch: () => {
			const hook = hooks.beforeBatch;
			hooks.beforeBatch = undefined;
			hook?.();
		},
	});
	const batch = db.batch?.bind(db);
	if (!batch) throw new Error("fixture batch unavailable");
	// Raw private fixture capability: V2's production backend must reject the fence.
	const backend: AuthLinkBackend = {
		first: ({ sql, values }) =>
			db
				.prepare(sql)
				.bind(...values)
				.first(),
		run: async ({ sql, values }) => base.db.prepare(sql).run(...values).changes,
		batch: async (statements) => {
			const result = await batch(
				statements.map(({ sql, values }) => db.prepare(sql).bind(...values)),
			);
			const hook = hooks.afterBatch;
			hooks.afterBatch = undefined;
			hook?.();
			return result;
		},
	};
	const f = await changeFixture(base.store, backend, authority);
	const rows = (table: string) =>
		base.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
	const snapshot = () =>
		[
			...protectedTables,
			"coordinator_auth_link_profiles",
			"coordinator_auth_account_profiles",
			changeTable,
		].map(rows);
	return { ...base, ...f, rows, snapshot, hooks };
}

test("device-claim disconnect commits exact archive, revokes sessions, purges display and retains only an immutable receipt", async ({
	f,
}) => {
	await f.prepare();
	const birth = f.db
		.prepare("SELECT rowid AS original_rowid,* FROM coordinator_auth_account_links")
		.get();
	const claims = f.rows("coordinator_auth_device_claims");
	const result = await f.operations.finalize(f.proof(), config);
	expect(result).toMatchObject({ intent: "disconnect", completedAtMs: f.clock.now });
	expect(f.rows("coordinator_auth_account_connection_history")).toEqual([
		{
			...(birth as object),
			ended_at_ms: f.clock.now,
			end_attempt_id: "change-1",
			successor_link_id: null,
		},
	]);
	expect(f.rows("coordinator_auth_account_links")).toEqual([]);
	expect(f.rows("coordinator_auth_device_claims")).toEqual(claims);
	expect(f.rows("coordinator_auth_sessions")).toMatchObject([{ revoked_at_ms: f.clock.now }]);
	expect(f.rows("coordinator_auth_link_profiles")).toEqual([]);
	expect(f.rows(changeTable)).toMatchObject([
		{
			state: "completed",
			nonce: null,
			pkce_verifier: null,
			display_name: null,
			email: null,
			email_verified: null,
			picture_url: null,
		},
	]);
	const committed = f.snapshot();
	expect(await f.operations.finalize(f.proof(), config)).toEqual(result);
	expect(
		await f.operations.finalize({ ...f.proof(), completionSecretHash: hash(999) }, config),
	).toBeNull();
	expect(await f.operations.cancel(f.request(), config)).toBe(false);
	for (const query of [
		`UPDATE ${changeTable} SET intent = 'refresh'`,
		`DELETE FROM ${changeTable}`,
		`INSERT OR REPLACE INTO ${changeTable} SELECT * FROM ${changeTable}`,
	])
		expect(() => f.db.exec(query)).toThrow();
	expect(f.snapshot()).toEqual(committed);
});

it("active attested original key also completes management, without requiring the birth config revision", async () => {
	const f = await fixture("controller_attestation");
	try {
		const rotated = { ...config, revision: hash(700) };
		expect(await f.operations.create(f.request(), rotated)).toBe(true);
		expect(await f.operations.claimBrowser(f.materials(), rotated)).toBe(true);
		expect(await f.operations.consumeCallback(f.materials(), rotated)).not.toBeNull();
		expect(await f.operations.recordVerifiedCallback(f.verified(), rotated)).toBe(true);
		expect(
			await f.operations.confirmDisconnect(
				{ ...f.materials(), completionSecretHash: f.proof().completionSecretHash },
				rotated,
			),
		).toBe(true);
		expect(await f.operations.finalize(f.proof(), rotated)).toMatchObject({ intent: "disconnect" });
	} finally {
		await f.store.close();
	}
});

test("browser start code and exact state/binder consume once, erasing nonce/PKCE without incrementing on retries", async ({
	f,
}) => {
	expect(await f.operations.create(f.request(), config)).toBe(true);
	expect(
		await f.operations.claimBrowser({ ...f.materials(), browserStartHash: hash(999) }, config),
	).toBe(false);
	expect(f.rows("coordinator_auth_account_connection_orders")).toEqual([
		{ coordinator_id: config.coordinatorId, last_order: 1 },
	]);
	expect(await f.operations.claimBrowser(f.materials(), config)).toBe(true);
	expect(await f.operations.claimBrowser(f.materials(), config)).toBe(false);
	expect(f.rows("coordinator_auth_account_connection_orders")).toMatchObject([{ last_order: 2 }]);
	expect(
		await f.operations.consumeCallback({ ...f.materials(), binderHash: hash(999) }, config),
	).toBeNull();
	expect(await f.operations.consumeCallback(f.materials(), config)).toMatchObject({
		nonce: "n".repeat(43),
		pkceVerifier: "p".repeat(43),
	});
	expect(await f.operations.consumeCallback(f.materials(), config)).toBeNull();
	expect(f.rows(changeTable)).toMatchObject([
		{ state: "consumed", nonce: null, pkce_verifier: null },
	]);
});

test("signed-only finalize, unconsumed provider metadata, wrong Google account and missing disconnect confirmation have no effects", async ({
	f,
}) => {
	expect(await f.operations.create(f.request(), config)).toBe(true);
	expect(await f.operations.recordVerifiedCallback(f.verified(), config)).toBe(false);
	expect(await f.operations.finalize(f.proof(), config)).toBeNull();
	await f.operations.claimBrowser(f.materials(), config);
	await f.operations.consumeCallback(f.materials(), config);
	const before = f.snapshot();
	expect(
		await f.operations.recordVerifiedCallback({ ...f.verified(), subject: "different" }, config),
	).toBe(false);
	expect(
		await f.operations.recordVerifiedCallback(
			{ ...f.verified(), issuer: "https://other.example.test" },
			config,
		),
	).toBe(false);
	expect(f.snapshot()).toEqual(before);
	expect(await f.operations.recordVerifiedCallback(f.verified(), config)).toBe(true);
	expect(await f.operations.finalize(f.proof(), config)).toBeNull();
	expect(f.rows(changeTable)).toMatchObject([{ state: "verified", completion_secret_hash: null }]);
});

test("wrong key, same-Identity shared reader, revoked key and enrollment snapshot changes cannot manage", async ({
	f,
}) => {
	expect(
		await f.operations.create(
			{ ...f.request(), signer: { ...input.signer, publicKey: "invalid" } },
			config,
		),
	).toBe(false);
	await f.exec(
		"UPDATE enrolled_devices SET identity_id = ? WHERE device_id = 'unrelated-device'",
		input.identityId,
	);
	expect(
		await f.operations.create(
			{
				...f.request(),
				signer: {
					...input.signer,
					deviceId: "unrelated-device",
					publicKey: otherKey,
					fingerprint: "b".repeat(64),
				},
			},
			config,
		),
	).toBe(false);
	await f.prepare();
	await f.exec(
		"UPDATE enrolled_devices SET identity_id = ? WHERE device_id = ?",
		input.identityId,
		input.signer.deviceId,
	);
	expect(await f.operations.finalize(f.proof(), config)).toBeNull();
	await f.exec(
		"UPDATE enrolled_devices SET identity_id = NULL WHERE device_id = ?",
		input.signer.deviceId,
	);
	await f.exec(
		"INSERT INTO coordinator_device_revocations (subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,created_at) SELECT 'ed25519_key',key_id,'revoked',group_id,device_id,public_key,fingerprint,'now' FROM coordinator_auth_device_claims",
	);
	expect(await f.operations.finalize(f.proof(), config)).toBeNull();
	expect(f.rows(changeTable)).toMatchObject([{ state: "confirmed" }]);
});

test("current group archive, requester contradiction and config change are rechecked in winning SQL", async ({
	f,
}) => {
	await f.prepare();
	await f.exec("UPDATE groups SET archived_at = 'now'");
	expect(await f.operations.finalize(f.proof(), config)).toBeNull();
	await f.exec("UPDATE groups SET archived_at = NULL");
	await f.exec(
		"UPDATE enrolled_devices SET identity_id = 'other' WHERE device_id = ?",
		input.signer.deviceId,
	);
	expect(await f.operations.finalize(f.proof(), config)).toBeNull();
	await f.exec(
		"UPDATE enrolled_devices SET identity_id = NULL WHERE device_id = ?",
		input.signer.deviceId,
	);
	expect(await f.operations.finalize(f.proof(), { ...config, revision: hash(999) })).toBeNull();
	expect(
		await f.operations.finalize({ ...f.proof(), runtimeVerifierHash: hash(999) }, config),
	).toBeNull();
});

test("target replacement rejects a previously confirmed management proof", async ({ f }) => {
	await f.prepare();
	await f.exec("UPDATE coordinator_auth_account_links SET link_id = 'replacement'");
	expect(await f.operations.finalize(f.proof(), config)).toBeNull();
	expect(f.rows("coordinator_auth_account_connection_history")).toEqual([]);
});

it("revoking the active source attestation rejects create and a previously confirmed finalization", async () => {
	const f = await fixture("controller_attestation");
	try {
		await f.prepare();
		await f.exec("UPDATE coordinator_auth_controller_attestations SET revoked_at = 'now'");
		expect(await f.operations.create(f.request(2), config)).toBe(false);
		const before = f.snapshot();
		expect(await f.operations.finalize(f.proof(), config)).toBeNull();
		expect(f.snapshot()).toEqual(before);
	} finally {
		await f.store.close();
	}
});

test("winning SQL rejects a requester disabled after authority capture but before its batch", async ({
	f,
}) => {
	await f.prepare();
	f.hooks.beforeBatch = () =>
		f.db.exec("UPDATE enrolled_devices SET enabled = 0 WHERE device_id = 'device-a'");
	expect(await f.operations.finalize(f.proof(), config)).toBeNull();
	expect(f.rows(changeTable)).toMatchObject([{ state: "confirmed" }]);
	expect(f.rows("coordinator_auth_account_connection_history")).toEqual([]);
});

test("a late archive/delete failure rolls back proof state, archive, sessions and profile deletion", async ({
	f,
}) => {
	await f.prepare();
	f.db.exec(
		"CREATE TRIGGER fail_delete BEFORE DELETE ON coordinator_auth_link_profiles BEGIN SELECT RAISE(ABORT,'injected'); END",
	);
	const before = f.snapshot();
	expect(await f.operations.finalize(f.proof(), config)).toBeNull();
	expect(f.snapshot()).toEqual(before);
	f.db.exec("DROP TRIGGER fail_delete");
	f.db.exec(
		"CREATE TRIGGER ignore_session_revoke BEFORE UPDATE ON coordinator_auth_sessions BEGIN SELECT RAISE(IGNORE); END",
	);
	expect(await f.operations.finalize(f.proof(), config)).toBeNull();
	expect(f.snapshot()).toEqual(before);
	f.db.exec("DROP TRIGGER ignore_session_revoke");
	f.db.exec(
		"CREATE TRIGGER ignore_profile_delete BEFORE DELETE ON coordinator_auth_link_profiles BEGIN SELECT RAISE(IGNORE); END",
	);
	expect(await f.operations.finalize(f.proof(), config)).toBeNull();
	expect(f.snapshot()).toEqual(before);
	f.db.exec("DROP TRIGGER ignore_profile_delete");
	expect(await f.operations.finalize(f.proof(), config)).not.toBeNull();
});

test("refresh sanitizes display only, keeps genuine birth metadata and all authority/session rows unchanged", async ({
	f,
}) => {
	await f.prepare(1, "refresh", {
		displayName: "Fresh",
		email: "person@example.test",
		emailVerified: true,
		pictureUrl: "javascript:alert(1)",
		access_token: "never retain",
	});
	const protectedBefore = protectedTables.map(f.rows);
	const birthProfile = f.rows("coordinator_auth_link_profiles")[0];
	expect(await f.operations.finalize(f.proof(), config)).toMatchObject({ intent: "refresh" });
	expect(protectedTables.map(f.rows)).toEqual(protectedBefore);
	expect(f.rows("coordinator_auth_link_profiles")).toEqual([
		{
			...birthProfile,
			display_name: "Fresh",
			email: "person@example.test",
			email_verified: 1,
			picture_url: null,
			source_change_attempt_id: "change-1",
			source_order: 2,
		},
	]);
	expect(f.rows(changeTable)).toMatchObject([
		{ state: "completed", email: null, display_name: null },
	]);
	expect(JSON.stringify(f.snapshot())).not.toContain("never retain");
	await f.prepare(2, "refresh", {});
	await f.operations.finalize(f.proof(2), config);
	expect(f.rows("coordinator_auth_link_profiles")).toMatchObject([
		{
			display_name: null,
			email: null,
			email_verified: null,
			picture_url: null,
			source_change_attempt_id: "change-2",
			source_order: 3,
		},
	]);
});

test("refresh completion order cannot overwrite a newer-started snapshot; ignored writes cannot falsely complete", async ({
	f,
}) => {
	await f.prepare(1, "refresh");
	await f.prepare(2, "refresh", { displayName: "Newer" });
	await f.operations.finalize(f.proof(2), config);
	await f.operations.finalize(f.proof(1), config);
	expect(f.rows("coordinator_auth_link_profiles")).toMatchObject([
		{ display_name: "Newer", source_order: 3 },
	]);
	await f.prepare(3, "refresh");
	f.db.exec(
		"CREATE TRIGGER ignore_profile BEFORE INSERT ON coordinator_auth_link_profiles BEGIN SELECT RAISE(IGNORE); END",
	);
	expect(await f.operations.finalize(f.proof(3), config)).toBeNull();
	expect(f.rows(changeTable)).toMatchObject([
		{ state: "completed" },
		{ state: "completed" },
		{ state: "confirmed" },
	]);
});

test("expiry and cancellation erase staging without changing link authority; replay has no effects", async ({
	f,
}) => {
	await f.prepare(1, "refresh");
	const protectedBefore = protectedTables.map(f.rows);
	expect(await f.operations.cancel(f.request(), config)).toBe(true);
	const cancelled = f.snapshot();
	expect(await f.operations.cancel(f.request(), config)).toBe(false);
	expect(await f.operations.finalize(f.proof(), config)).toBeNull();
	expect(f.snapshot()).toEqual(cancelled);
	expect(f.rows(changeTable)).toMatchObject([
		{ state: "cancelled", email: null, display_name: null },
	]);
	await f.prepare(2, "refresh");
	f.clock.now += 600000;
	const expired = f.snapshot();
	expect(await f.operations.finalize(f.proof(2), config)).toBeNull();
	expect(f.snapshot()).toEqual(expired);
	expect(protectedTables.map(f.rows)).toEqual(protectedBefore);
});

test("history barrier uses the added Identity covering index instead of scanning coordinator history", async ({
	f,
}) => {
	const plan = f.db
		.prepare(
			"EXPLAIN QUERY PLAN SELECT 1 FROM coordinator_auth_account_connection_history WHERE coordinator_id = ? AND identity_id = ? AND revoked_at_ms IS NOT NULL",
		)
		.all(config.coordinatorId, input.identityId);
	expect(JSON.stringify(plan)).toContain(
		"COVERING INDEX account_connection_history_identity_revoked",
	);
	f.db.exec("DROP INDEX account_connection_history_identity_revoked");
	const oldPlan = f.db
		.prepare(
			"EXPLAIN QUERY PLAN SELECT 1 FROM coordinator_auth_account_connection_history WHERE coordinator_id = ? AND identity_id = ? AND revoked_at_ms IS NOT NULL",
		)
		.all(config.coordinatorId, input.identityId);
	expect(JSON.stringify(oldPlan)).not.toContain("identity_id=?");
});

test("expected Identity pins create/finalize/status; exact lost-reply retries preserve commitments and deadline", async ({
	f,
}) => {
	const before = f.snapshot();
	expect(
		await f.operations.create({ ...f.request(), expectedIdentityId: "another-identity" }, config),
	).toBe(false);
	expect(f.snapshot()).toEqual(before);
	f.hooks.afterBatch = () => {
		throw new Error("lost local reply after commit");
	};
	expect(await f.operations.create(f.request(), config)).toBe(true);
	const created = f.snapshot();
	f.clock.now += 10;
	expect(await f.operations.create(f.request(), config)).toBe(true);
	for (const patch of [
		{ intent: "refresh" },
		{ expectedIdentityId: "another-identity" },
		{ browserStartHash: hash(888) },
		{ runtimeVerifierHash: hash(888) },
	]) {
		expect(await f.operations.create({ ...f.request(), ...patch }, config)).toBe(false);
	}
	expect(await f.operations.create(f.request(), { ...config, revision: hash(888) })).toBe(false);
	expect(f.snapshot()).toEqual(created);
	const status = await f.operations.readStatus(f.request(), config);
	expect(status).toEqual({
		attemptId: "change-1",
		intent: "disconnect",
		state: "pending",
		expiresAtMs: f.rows(changeTable)[0]?.expires_at_ms,
		identityId: input.identityId,
	});
	expect(
		await f.operations.readStatus({ ...f.request(), expectedIdentityId: "wrong" }, config),
	).toBeNull();
	await f.operations.claimBrowser(f.materials(), config);
	await f.operations.consumeCallback(f.materials(), config);
	await f.operations.recordVerifiedCallback(f.verified(), config);
	await f.operations.confirmDisconnect(
		{ ...f.materials(), completionSecretHash: f.proof().completionSecretHash },
		config,
	);
	expect(
		await f.operations.finalize({ ...f.proof(), expectedIdentityId: "wrong" }, config),
	).toBeNull();
	expect(await f.operations.finalize(f.proof(), config)).not.toBeNull();
});

test("LINK and CHANGE share an atomic two-active-device budget", async ({ f }) => {
	// Seed a V2 pending promise, not a second authority proof or a mounted old writer.
	const birth = f.rows("coordinator_auth_link_attempts")[0];
	if (!birth) throw new Error("missing V2 birth");
	const pending = {
		...birth,
		attempt_id: "pending-link",
		runtime_verifier_hash: hash(801),
		browser_start_hash: hash(802),
		state: "pending",
		browser_transaction_hash: null,
		account_subject: null,
		completion_secret_hash: null,
		link_id: null,
		claimed_at_ms: null,
		oidc_verified_at_ms: null,
		confirmed_at_ms: null,
		finalized_at_ms: null,
	};
	f.db
		.prepare(
			`INSERT INTO coordinator_auth_link_attempts (${Object.keys(pending).join(",")}) VALUES (${Object.keys(
				pending,
			)
				.map(() => "?")
				.join(",")})`,
		)
		.run(...Object.values(pending));
	const outcomes = await Promise.all([
		f.operations.create(f.request(1), config),
		f.operations.create(f.request(2), config),
	]);
	expect(outcomes.sort()).toEqual([false, true]);
	expect(f.rows(changeTable)).toHaveLength(1);
});

test("terminal attempts release active slots but hourly and retention budgets still count them", async ({
	f,
}) => {
	for (let n = 1; n <= 5; n++) {
		expect(await f.operations.create(f.request(n), config)).toBe(true);
		expect(await f.operations.cancel(f.request(n), config)).toBe(true);
	}
	// One real LINK birth plus five CHANGE creates reaches the shared hourly limit.
	expect(await f.operations.create(f.request(6), config)).toBe(false);
	f.clock.now += 3600001;
	const retained = f.rows(changeTable)[0];
	if (!retained) throw new Error("missing retained attempt");
	for (let n = 6; n <= 59; n++) {
		const row = {
			...retained,
			attempt_id: `retained-${n}`,
			runtime_verifier_hash: hash(1000 + n),
			browser_start_hash: hash(2000 + n),
		};
		f.db
			.prepare(
				`INSERT INTO ${changeTable} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row)
					.map(() => "?")
					.join(",")})`,
			)
			.run(...Object.values(row));
	}
	const before = f.snapshot();
	expect(await f.operations.create(f.request(60), config)).toBe(false);
	expect(f.snapshot()).toEqual(before);
});

test("provider failure requires the exact consumed callback and permits a fresh start without resetting order", async ({
	f,
}) => {
	await f.operations.create(f.request(), config);
	await f.operations.claimBrowser(f.materials(), config);
	expect(await f.operations.hasPendingCallback(f.materials(), config)).toBe(true);
	expect(
		await f.operations.hasPendingCallback({ ...f.materials(), binderHash: hash(888) }, config),
	).toBe(false);
	expect(await f.operations.failConsumed(f.materials(), config)).toBe(false);
	expect(await f.operations.readBrowserView(f.materials(), config)).toBeNull();
	await f.operations.consumeCallback(f.materials(), config);
	const before = f.snapshot();
	expect(await f.operations.failConsumed({ ...f.materials(), binderHash: hash(888) }, config)).toBe(
		false,
	);
	expect(f.snapshot()).toEqual(before);
	expect(await f.operations.failConsumed(f.materials(), config)).toBe(true);
	expect(await f.operations.failConsumed(f.materials(), config)).toBe(false);
	expect(f.rows(changeTable)).toMatchObject([
		{
			state: "failed",
			failure_reason: "provider_failure",
			nonce: null,
			pkce_verifier: null,
			email: null,
		},
	]);
	expect(await f.operations.create(f.request(), config)).toBe(false);
	await f.prepare(2, "refresh");
	expect(await f.operations.readBrowserView(f.materials(2), config)).toEqual({
		attemptId: "change-2",
		intent: "refresh",
		state: "confirmed",
		loopbackRedirect: f.request().loopbackRedirect,
		identityId: input.identityId,
		expiresAtMs: f.rows(changeTable)[1]?.expires_at_ms,
		profile: { displayName: "Fresh", email: "person@example.test", emailVerified: true },
	});
	expect(await f.operations.failConsumed(f.materials(2), config)).toBe(false);
	expect(f.rows("coordinator_auth_account_connection_orders")).toMatchObject([{ last_order: 3 }]);
});

test("bounded expiry cleanup scrubs nonce and profile staging across config rotation without touching receipts", async ({
	f,
}) => {
	await f.prepare(1, "refresh");
	await f.operations.finalize(f.proof(), config);
	const receipt = f.rows(changeTable)[0];
	await f.operations.create(f.request(2), config);
	await f.operations.claimBrowser(f.materials(2), config);
	await f.prepare(3, "refresh");
	f.clock.now += 600000;
	expect(await f.operations.readStatus(f.request(2), config)).toMatchObject({ state: "expired" });
	expect(await f.operations.maintainExpired(config.coordinatorId, 33)).toBe(0);
	expect(await f.operations.maintainExpired("other", 1)).toBe(0);
	expect(await f.operations.maintainExpired(config.coordinatorId, 1)).toBe(1);
	expect(await f.operations.maintainExpired(config.coordinatorId, 1)).toBe(1);
	expect(await f.operations.maintainExpired(config.coordinatorId)).toBe(0);
	expect(f.rows(changeTable)).toMatchObject([
		receipt,
		{
			state: "expired",
			failure_reason: "expired",
			nonce: null,
			pkce_verifier: null,
			email: null,
			display_name: null,
		},
		{ state: "expired", nonce: null, pkce_verifier: null, email: null, display_name: null },
	]);
	expect(await f.operations.create(f.request(4), { ...config, revision: hash(777) })).toBe(true);
});

it("a different current attestation can manage the Identity independently of a revoked origin", async () => {
	const f = await fixture("controller_attestation");
	try {
		const signer = {
			groupId: input.signer.groupId,
			deviceId: "unrelated-device",
			publicKey: otherKey,
			fingerprint: "b".repeat(64),
		};
		await f.exec(
			"UPDATE enrolled_devices SET identity_id = ? WHERE device_id = ?",
			input.identityId,
			signer.deviceId,
		);
		expect(
			await f.store.createAuthControllerAttestation({
				coordinatorId: config.coordinatorId,
				identityId: input.identityId,
				...signer,
				attestationId: "current-controller",
				reviewReceiptId: "current-review",
				evidenceDigest: hash(888),
			}),
		).toMatchObject({ kind: "created" });
		await f.exec(
			"UPDATE coordinator_auth_controller_attestations SET revoked_at = 'now' WHERE attestation_id = 'controller'",
		);
		expect(await f.operations.create({ ...f.request(1, "refresh"), signer }, config)).toBe(true);
		await f.operations.claimBrowser(f.materials(), config);
		await f.operations.consumeCallback(f.materials(), config);
		await f.operations.recordVerifiedCallback(f.verified(), config);
		expect(await f.operations.finalize({ ...f.proof(), signer }, config)).toMatchObject({
			intent: "refresh",
		});
		await f.exec(
			"UPDATE coordinator_auth_controller_attestations SET revoked_at = 'now' WHERE attestation_id = 'current-controller'",
		);
		expect(await f.operations.create({ ...f.request(2), signer }, config)).toBe(false);
	} finally {
		await f.store.close();
	}
});

test("legacy completion contradictions added after capture still deny the winning statement", async ({
	f,
}) => {
	const manifest = JSON.stringify({
		coordinator_id: config.coordinatorId,
		device_decisions: [
			{
				device_id: input.signer.deviceId,
				key_fingerprint: input.signer.fingerprint,
				identity_id: input.identityId,
				decision: "excluded",
			},
		],
	});
	f.hooks.beforeBatch = () =>
		f.db
			.prepare(
				"INSERT INTO coordinator_legacy_team_completions (group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at) VALUES ('group-a','legacy',1,?,'now','now')",
			)
			.run(manifest);
	expect(await f.operations.create(f.request(), config)).toBe(false);
	expect(f.rows(changeTable)).toEqual([]);
});

test("private browser binding reveals only its own verified state; public status excludes redirect and profile", async ({
	f,
}) => {
	expect(await f.operations.create(f.request(), config)).toBe(true);
	await f.operations.claimBrowser(f.materials(), config);
	expect(await f.operations.readBrowserBinding(f.materials(), config)).toBeNull();
	await f.operations.consumeCallback(f.materials(), config);
	await f.operations.recordVerifiedCallback(f.verified(), config);
	expect(await f.operations.readBrowserBinding(f.materials(), config)).toEqual({
		stateHash: f.materials().stateHash,
	});
	for (const patch of [{ attemptId: "other" }, { binderHash: hash(999) }])
		expect(
			await f.operations.readBrowserBinding({ ...f.materials(), ...patch }, config),
		).toBeNull();
	expect(
		await f.operations.readBrowserBinding(f.materials(), { ...config, revision: hash(999) }),
	).toBeNull();
	expect(
		await f.operations.readBrowserBinding(f.materials(), { ...config, coordinatorId: "other" }),
	).toBeNull();
	const status = await f.operations.readStatus(f.request(), config);
	expect(Object.keys(status ?? {}).sort()).toEqual([
		"attemptId",
		"expiresAtMs",
		"identityId",
		"intent",
		"state",
	]);
	expect(await f.operations.readBrowserView(f.materials(), config)).toMatchObject({
		state: "verified",
		loopbackRedirect: f.request().loopbackRedirect,
	});
	f.clock.now += 600000;
	expect(await f.operations.readBrowserBinding(f.materials(), config)).toBeNull();
});
