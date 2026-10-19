import { expect, it } from "vitest";
import {
	config,
	hash,
	input,
	NOW,
} from "../../cloudflare-coordinator-worker/test/account-change-fixture.js";
import { reconnectFixture } from "../../cloudflare-coordinator-worker/test/account-reconnect-fixture.js";
import { otherKey } from "../../cloudflare-coordinator-worker/test/device-claim-eligibility-fixture.js";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import { setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import type { D1CoordinatorStore } from "./d1-coordinator-store.js";

async function fixture(
	authority: "device_claim" | "controller_attestation" = "device_claim",
	beforeInstall?: (store: D1CoordinatorStore) => Promise<void>,
) {
	const base = setupStore("D1", { authClock: () => NOW }),
		db = sqliteD1(base.db),
		batch = db.batch?.bind(db);
	if (!batch) throw new Error("missing batch");
	const backend: AuthLinkBackend = {
		first: ({ sql, values }) =>
			db
				.prepare(sql)
				.bind(...values)
				.first(),
		run: async ({ sql, values }) => base.db.prepare(sql).run(...values).changes,
		batch: async (statements) =>
			(await batch(statements.map(({ sql, values }) => db.prepare(sql).bind(...values)))).map(
				(result) => Number((result as { meta: { changes: number } }).meta.changes),
			),
	};
	try {
		const f = await reconnectFixture(
			base.store as D1CoordinatorStore,
			backend,
			authority,
			() => beforeInstall?.(base.store as D1CoordinatorStore) ?? Promise.resolve(),
		);
		const rows = (name: string) =>
			base.db.prepare(`SELECT * FROM ${name}`).all() as Record<string, unknown>[];
		const unchanged = () =>
			[
				"coordinator_auth_device_claims",
				"enrolled_devices",
				"coordinator_device_ownership_bindings",
				"coordinator_identity_group_grants",
				"coordinator_invites",
			].map(rows);
		return { ...base, ...f, rows, unchanged };
	} catch (error) {
		await base.store.close();
		if (base.db.open) base.db.close();
		throw error;
	}
}
const test = it.extend<{ f: Awaited<ReturnType<typeof fixture>> }>({
	f: async ({ task: _task }, use) => {
		const f = await fixture();
		try {
			await use(f);
		} finally {
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	},
});

test("device-claim relink diagnoses quota and reserved IDs without leaking them after authority loss", async ({
	f,
}) => {
	await f.disconnect(1);
	for (const n of [1, 2])
		expect(await f.links.createAuthLinkAttempt(f.linkRequest(n), config)).toMatchObject({
			kind: "created",
		});
	expect(await f.links.createAuthLinkAttempt(f.linkRequest(3), config)).toEqual({
		kind: "rejected",
		error: "attempt_limited",
	});
	expect(
		await f.links.createAuthLinkAttempt(
			{ ...f.linkRequest(1), runtimeVerifierHash: hash(999) },
			config,
		),
	).toEqual({ kind: "rejected", error: "attempt_conflict" });
	f.db
		.prepare(`INSERT INTO coordinator_auth_browser_transactions
 (coordinator_id,browser_transaction_hash,purpose,attempt_id,state_hash,binder_hash,issuer,auth_config_revision,redirect_uri,state,nonce,pkce_verifier,created_at_ms,expires_at_ms,start_order)
 VALUES (?,?,'owner_enroll',?,?,?, ?,?,?,'pending',?,?,?, ?,1)`)
		.run(
			config.coordinatorId,
			hash(9101),
			"relink-3",
			hash(9102),
			hash(9103),
			config.issuer,
			config.revision,
			f.bc.redirectUri,
			"n".repeat(43),
			"p".repeat(43),
			f.clock.now,
			f.clock.now + 600000,
		);
	expect(await f.links.createAuthLinkAttempt(f.linkRequest(3), config)).toEqual({
		kind: "rejected",
		error: "attempt_conflict",
	});
	f.db.prepare("UPDATE enrolled_devices SET enabled=0").run();
	expect(await f.links.createAuthLinkAttempt(f.linkRequest(3), config)).toEqual({
		kind: "rejected",
		error: "attempt_unavailable",
	});
});

it.each(["device_claim", "controller_attestation"] as const)(
	"%s does not classify unrelated storage faults as admission limits",
	async (authority) => {
		const f = await fixture(authority);
		try {
			await f.disconnect(1);
			f.db.exec(
				"CREATE TRIGGER fixture_unrelated_failure BEFORE INSERT ON coordinator_auth_link_attempts BEGIN SELECT RAISE(ABORT,'private connection_attempt_limited failure'); END",
			);
			await expect(f.links.createAuthLinkAttempt(f.linkRequest(1), config)).rejects.toThrow(
				/^auth_link_persistence_error$/,
			);
		} finally {
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	},
);

it.each(["device_claim", "controller_attestation"] as const)(
	"%s shared CHANGE quota returns a typed relink limit and releases only active slots",
	async (authority) => {
		const f = await fixture(authority);
		try {
			expect(await f.operations.create(f.request(90, "refresh"), config)).toBe(true);
			await f.disconnect(1);
			expect(await f.links.createAuthLinkAttempt(f.linkRequest(1), config)).toMatchObject({
				kind: "created",
			});
			expect(await f.links.createAuthLinkAttempt(f.linkRequest(2), config)).toEqual({
				kind: "rejected",
				error: "attempt_limited",
			});
			expect(await f.operations.cancel(f.request(90, "refresh"), config)).toBe(true);
			expect(await f.links.createAuthLinkAttempt(f.linkRequest(2), config)).toMatchObject({
				kind: "created",
			});
			f.clock.now += 600001;
			expect(await f.links.createAuthLinkAttempt(f.linkRequest(3), config)).toMatchObject({
				kind: "created",
			});
			// Terminal and expired rows release live slots, but remain in the hourly budget.
			expect(await f.links.createAuthLinkAttempt(f.linkRequest(4), config)).toEqual({
				kind: "rejected",
				error: "attempt_limited",
			});
		} finally {
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	},
);

test("actual A-to-A reconnect uses one archived genesis claim and a fresh opaque link; old sessions never resurrect", async ({
	f,
}) => {
	const birth = f.rows("coordinator_auth_account_links")[0],
		before = f.unchanged();
	await f.disconnect(1);
	expect(
		await f.status.readAuthDeviceClaimReadiness(
			{ signer: input.signer, identityId: input.identityId },
			config,
		),
	).toMatchObject({ kind: "eligible", authority: "device_claim" });
	expect(
		await f.status.readAccountLinkStatus(input.signer, config, { identityId: input.identityId }),
	).toMatchObject({
		version: 2,
		state: "unlinked",
		identityId: input.identityId,
		authority: "device_claim",
		account: null,
	});
	const a = await f.confirmed(1);
	expect(await f.links.createAuthLinkAttempt(a.startRequest, config)).toMatchObject({
		kind: "existing",
	});
	expect(await f.links.finalizeAuthLinkAttempt(a.proof, config)).toMatchObject({ kind: "applied" });
	const current = f.rows("coordinator_auth_account_links")[0];
	expect(current?.link_id).not.toBe(birth?.link_id);
	expect(current?.device_claim_id).toBe(birth?.device_claim_id);
	expect(f.rows("coordinator_auth_account_connection_history")).toMatchObject([
		{ link_id: birth?.link_id, successor_link_id: current?.link_id },
	]);
	expect(f.unchanged()).toEqual(before);
	expect(await f.sessions.readAuthSession(hash(906), config)).toBeNull();
	expect(
		await f.sessions.redeemAuthLinkSessionWithBrowserTransaction(
			{ ...a.pins, binderHash: a.binderHash, credentialHash: hash(4000) },
			f.bc,
		),
	).toMatchObject({ kind: "issued" });
	expect(await f.profiles.readAuthSessionAccount(hash(4000), config)).toMatchObject({
		profile: { displayName: "account-A" },
	});
	expect(
		await f.status.readAccountLinkStatus(input.signer, config, { identityId: input.identityId }),
	).toMatchObject({ state: "linked", account: { displayName: "account-A" } });
	await f.disconnect(2);
	expect(await f.links.finalizeAuthLinkAttempt(a.proof, config)).toMatchObject({
		kind: "existing",
	});
	expect(f.rows("coordinator_auth_account_links")).toEqual([]);
});

test("actual A-to-B-to-A preserves reservation, claim and birth proof while each head advances once", async ({
	f,
}) => {
	const before = f.unchanged(),
		genesis = f.rows("coordinator_auth_account_links")[0];
	await f.disconnect(1);
	const b = await f.confirmed(1, "account-B");
	expect(await f.links.finalizeAuthLinkAttempt(b.proof, config)).toMatchObject({ kind: "applied" });
	const middle = f.rows("coordinator_auth_account_links")[0];
	expect(middle?.signin_floor).toBeGreaterThan(0);
	await f.disconnect(2, "account-B");
	expect(f.rows("coordinator_auth_account_connection_history")).toMatchObject([
		{ signin_floor: genesis?.signin_floor },
		{ signin_floor: middle?.signin_floor },
	]);
	expect(() =>
		f.db.exec(
			"UPDATE coordinator_auth_account_connection_history SET signin_floor = signin_floor + 1",
		),
	).toThrow(/connection_history_immutable/);
	const a = await f.confirmed(2, "account-A");
	expect(await f.links.finalizeAuthLinkAttempt(a.proof, config)).toMatchObject({ kind: "applied" });
	const current = f.rows("coordinator_auth_account_links")[0];
	expect(new Set([genesis?.link_id, middle?.link_id, current?.link_id]).size).toBe(3);
	expect(f.rows("coordinator_auth_account_connection_history")).toMatchObject([
		{ link_id: genesis?.link_id, successor_link_id: middle?.link_id },
		{ link_id: middle?.link_id, successor_link_id: current?.link_id },
	]);
	expect(f.unchanged()).toEqual(before);
	expect(
		await f.status.readAccountLinkStatus(input.signer, config, { identityId: "wrong" }),
	).toMatchObject({ state: "linked", identityId: input.identityId, account: null });
});

test("two independently confirmed relinks have one SQL winner, no extra claim and no orphan successor", async ({
	f,
}) => {
	await f.disconnect(1);
	const one = await f.confirmed(1, "account-B"),
		two = await f.confirmed(2, "account-C");
	const results = await Promise.all([
		f.links.finalizeAuthLinkAttempt(one.proof, config),
		f.links.finalizeAuthLinkAttempt(two.proof, config),
	]);
	expect(results.filter((r) => r.kind === "applied")).toHaveLength(1);
	expect(results.filter((r) => r.kind === "rejected")).toHaveLength(1);
	expect(f.rows("coordinator_auth_device_claims")).toHaveLength(1);
	expect(f.rows("coordinator_auth_account_links")).toHaveLength(1);
	expect(f.rows("coordinator_auth_account_connection_history")).toMatchObject([
		{ successor_link_id: f.rows("coordinator_auth_account_links")[0]?.link_id },
	]);
});

test("a stale prior cannot reconnect after a later disconnect; the newly captured head can", async ({
	f,
}) => {
	await f.disconnect(1);
	const stale = await f.confirmed(1, "stale-account"),
		winner = await f.confirmed(2, "account-B");
	await f.links.finalizeAuthLinkAttempt(winner.proof, config);
	await f.disconnect(2, "account-B");
	expect(await f.links.finalizeAuthLinkAttempt(stale.proof, config)).toMatchObject({
		kind: "rejected",
	});
	const fresh = await f.confirmed(3, "account-A");
	expect(await f.links.finalizeAuthLinkAttempt(fresh.proof, config)).toMatchObject({
		kind: "applied",
	});
});

test("wrong original key/device cannot reconnect and a late publication fault rolls back claim, head and current row", async ({
	f,
}) => {
	await f.disconnect(1);
	const before = f.unchanged();
	expect(
		await f.links.createAuthLinkAttempt(
			{ ...f.linkRequest(1), signer: { ...input.signer, publicKey: otherKey } },
			config,
		),
	).toMatchObject({ kind: "rejected" });
	expect(
		await f.links.createAuthLinkAttempt(
			{
				...f.linkRequest(1),
				signer: {
					...input.signer,
					deviceId: "unrelated-device",
					publicKey: otherKey,
					fingerprint: "b".repeat(64),
				},
			},
			config,
		),
	).toMatchObject({ kind: "rejected" });
	const a = await f.confirmed(1);
	expect(
		await f.links.finalizeAuthLinkAttempt({ ...a.proof, runtimeVerifierHash: hash(9999) }, config),
	).toMatchObject({ kind: "rejected" });
	f.db
		.prepare("UPDATE enrolled_devices SET public_key = ? WHERE device_id = ?")
		.run(otherKey, input.signer.deviceId);
	expect(await f.links.finalizeAuthLinkAttempt(a.proof, config)).toMatchObject({
		kind: "rejected",
	});
	f.db
		.prepare("UPDATE enrolled_devices SET public_key = ? WHERE device_id = ?")
		.run(input.signer.publicKey, input.signer.deviceId);
	f.db.exec(
		"CREATE TRIGGER relink_fault BEFORE INSERT ON coordinator_auth_link_audit_log WHEN NEW.attempt_id = 'relink-1' BEGIN SELECT RAISE(ABORT,'injected'); END",
	);
	await expect(f.links.finalizeAuthLinkAttempt(a.proof, config)).rejects.toThrow();
	expect(f.rows("coordinator_auth_account_links")).toEqual([]);
	expect(f.rows("coordinator_auth_account_connection_history")).toMatchObject([
		{ successor_link_id: null },
	]);
	expect(f.unchanged()).toEqual(before);
	f.db.exec("DROP TRIGGER relink_fault");
	expect(await f.links.finalizeAuthLinkAttempt(a.proof, config)).toMatchObject({ kind: "applied" });
});

it("a real pre-upgrade pending first-link attempt cannot become a continuation without a prior pin", async () => {
	const f = await fixture("controller_attestation", async (store) => {
		expect(
			await store.createAuthLinkAttempt(
				{
					attemptId: "relink-90",
					authority: { kind: "controller_attestation" },
					signer: input.signer,
					expectedIdentityId: input.identityId,
					runtimeVerifierHash: hash(3900),
					browserStartHash: hash(3901),
					loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
				},
				config,
			),
		).toMatchObject({ kind: "created" });
	});
	try {
		await f.disconnect(1);
		const stale = await f.confirmed(90);
		expect(await f.links.finalizeAuthLinkAttempt(stale.proof, config)).toMatchObject({
			kind: "rejected",
		});
		expect(f.rows("coordinator_auth_account_links")).toEqual([]);
		expect(f.rows("coordinator_auth_account_connection_history")).toMatchObject([
			{ successor_link_id: null },
		]);
		const fresh = await f.confirmed(1);
		expect(await f.links.finalizeAuthLinkAttempt(fresh.proof, config)).toMatchObject({
			kind: "applied",
		});
	} finally {
		await f.store.close();
		if (f.db.open) f.db.close();
	}
});

test("a different reviewed Identity cannot take an account reserved by an archived birth", async ({
	f,
}) => {
	await f.disconnect(1);
	const signer = {
		groupId: input.signer.groupId,
		deviceId: "unrelated-device",
		publicKey: otherKey,
		fingerprint: "b".repeat(64),
	};
	expect(
		await f.store.createAuthControllerAttestation({
			coordinatorId: config.coordinatorId,
			identityId: "unrelated-identity",
			...signer,
			attestationId: "other-controller",
			reviewReceiptId: "other-review",
			evidenceDigest: hash(7100),
		}),
	).toMatchObject({ kind: "created" });
	const request = {
		...f.linkRequest(1, signer, "controller_attestation"),
		expectedIdentityId: "unrelated-identity",
	};
	expect(await f.links.createAuthLinkAttempt(request, config)).toMatchObject({ kind: "created" });
	const start = {
		purpose: "link" as const,
		attemptId: request.attemptId,
		browserStartHash: request.browserStartHash,
		stateHash: hash(3012),
		binderHash: hash(3013),
		nonce: "n".repeat(43),
		pkceVerifier: "p".repeat(43),
	};
	await f.browser.startAuthBrowserTransaction(start, f.bc);
	const consumed = await f.browser.consumeAuthBrowserTransaction(start, f.bc);
	if (consumed.kind !== "consumed") throw new Error("other callback not consumed");
	const pins = {
		attemptId: request.attemptId,
		browserTransactionHash: consumed.browserTransactionHash,
	};
	await f.links.recordAuthLinkOidcVerified(
		{ ...pins, account: { issuer: config.issuer, subject: "account-A" } },
		config,
	);
	await f.links.confirmAuthLinkAttempt({ ...pins, completionSecretHash: hash(3014) }, config);
	const before = f.unchanged();
	expect(
		await f.links.finalizeAuthLinkAttempt(
			{
				...request,
				purpose: "coordinator-account-link-v1",
				coordinatorId: config.coordinatorId,
				...pins,
				groupId: signer.groupId,
				identityId: "unrelated-identity",
				deviceId: signer.deviceId,
				fingerprint: signer.fingerprint,
				completionSecretHash: hash(3014),
			},
			config,
		),
	).toMatchObject({ kind: "rejected" });
	expect(f.rows("coordinator_auth_account_links")).toEqual([]);
	expect(f.unchanged()).toEqual(before);
});

test("a current attestation may continue a claimed Identity without changing its original claim", async ({
	f,
}) => {
	const claims = f.rows("coordinator_auth_device_claims");
	await f.disconnect(1);
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
			attestationId: "current",
			reviewReceiptId: "current-review",
			evidenceDigest: hash(7200),
		}),
	).toMatchObject({ kind: "created" });
	const b = await f.confirmed(1, "account-B", signer, "controller_attestation");
	expect(await f.links.finalizeAuthLinkAttempt(b.proof, config)).toMatchObject({ kind: "applied" });
	expect(f.rows("coordinator_auth_device_claims")).toEqual(claims);
	for (const requester of [input.signer, signer])
		expect(
			await f.status.readAccountLinkStatus(requester, config, { identityId: input.identityId }),
		).toMatchObject({ state: "linked", account: { displayName: "account-B" } });
	expect(await f.operations.create(f.request(2), config)).toBe(true);
});

test("an archived genesis without its original creation audit cannot authorize a continuation", async ({
	f,
}) => {
	await f.disconnect(1);
	f.db.exec(
		"DELETE FROM coordinator_auth_link_audit_log WHERE attempt_id='birth' AND action='link_created'",
	);
	const before = f.unchanged();
	expect(await f.links.createAuthLinkAttempt(f.linkRequest(1), config)).toMatchObject({
		kind: "rejected",
	});
	expect(
		await f.status.readAuthDeviceClaimReadiness(
			{ signer: input.signer, identityId: input.identityId },
			config,
		),
	).toEqual({ kind: "unavailable" });
	expect(
		await f.status.readAccountLinkStatus(input.signer, config, { identityId: input.identityId }),
	).toMatchObject({ state: "conflict", account: null });
	expect(f.rows("coordinator_auth_account_links")).toEqual([]);
	expect(f.unchanged()).toEqual(before);
});

it("fresh current attestation reconnects after its origin attestation is revoked, without fabricating a claim", async () => {
	const f = await fixture("controller_attestation");
	try {
		await f.disconnect(1);
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
				attestationId: "current",
				reviewReceiptId: "current-review",
				evidenceDigest: hash(7000),
			}),
		).toMatchObject({ kind: "created" });
		await f.exec(
			"UPDATE coordinator_auth_controller_attestations SET revoked_at='now' WHERE attestation_id='controller'",
		);
		const a = await f.confirmed(1, "account-A", signer, "controller_attestation");
		expect(await f.links.finalizeAuthLinkAttempt(a.proof, config)).toMatchObject({
			kind: "applied",
		});
		expect(f.rows("coordinator_auth_device_claims")).toEqual([]);
		expect(
			await f.status.readAccountLinkStatus(signer, config, { identityId: input.identityId }),
		).toMatchObject({ state: "linked", authority: "controller_attestation" });
		await f.disconnect(2, "account-A", signer);
		expect(await f.links.finalizeAuthLinkAttempt(a.proof, config)).toMatchObject({
			kind: "existing",
		});
	} finally {
		await f.store.close();
		if (f.db.open) f.db.close();
	}
});
