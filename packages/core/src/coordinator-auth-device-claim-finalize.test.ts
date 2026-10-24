import { expect, vi } from "vitest";
import {
	controllerLinkEvidenceSql,
	deviceClaimEvidenceSql,
	input,
	NOW,
	seedClaimSql,
	seedEnrollmentSql,
	seedKeyRevocationSql,
	seedLinkSql,
} from "../../cloudflare-coordinator-worker/test/device-claim-eligibility-fixture.js";
import { browserConfig, materials } from "./coordinator-auth-browser-transaction-test-fixtures.js";
import type { CoordinatorAuthLinkFinalizeInput } from "./coordinator-auth-link-contract.js";
import {
	attempt,
	backendTest,
	completionHash,
	finalize,
	type LinkFixture,
	rows,
	status,
	TABLES,
} from "./coordinator-auth-link-test-fixtures.js";
import { EXPECTED_KEY_ID } from "./coordinator-ed25519-key-id-test-fixtures.js";

const request = () =>
	attempt({
		authority: { kind: "device_claim", identityId: input.identityId },
		signer: input.signer,
		browserStartHash: "e".repeat(64),
	});
const proof = () => finalize({ signer: input.signer, fingerprint: input.signer.fingerprint });
const applied = { kind: "applied" };
const rejected = { kind: "rejected" };
const device = { kind: "device" as const, signer: input.signer };
const claims = (f: LinkFixture) =>
	f.db.prepare("SELECT * FROM coordinator_auth_device_claims").all();
function snapshot(f: LinkFixture, options: { unchangedOnly?: boolean } = {}) {
	const tables = f.db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
		.all() as { name: string }[];
	return tables
		.filter(
			({ name }) =>
				!options.unchangedOnly || ![...TABLES, "coordinator_auth_device_claims"].includes(name),
		)
		.map(({ name }) => [name, f.db.prepare(`SELECT * FROM "${name}"`).all()]);
}
async function confirmed(f: LinkFixture) {
	f.db.exec(seedEnrollmentSql);
	expect(await f.store.createAuthLinkAttempt(request(), f.cfg)).toMatchObject({ kind: "created" });
	const start = {
		...materials(),
		purpose: "link" as const,
		attemptId: "attempt-a",
		browserStartHash: request().browserStartHash,
	};
	expect(await f.store.startAuthBrowserTransaction(start, browserConfig)).toMatchObject({
		kind: "started",
	});
	const binder = { attemptId: start.attemptId, binderHash: start.binderHash };
	const bound = await f.store.resolveAuthLinkBrowserTransaction(binder, browserConfig);
	if (!bound) throw new Error("device browser not bound");
	const callback = { stateHash: start.stateHash, binderHash: start.binderHash };
	expect(await f.store.consumeAuthBrowserTransaction(callback, browserConfig)).toMatchObject({
		kind: "consumed",
	});
	const browser = { attemptId: start.attemptId, ...bound };
	const account = { issuer: f.cfg.issuer, subject: "trusted-test-google-subject" };
	expect(await f.store.recordAuthLinkOidcVerified({ ...browser, account }, f.cfg)).toMatchObject(
		applied,
	);
	expect(await f.store.readAuthLinkCompletionDestination(browser, f.cfg)).toEqual({
		destination: request().loopbackRedirect,
	});
	const confirmation = { ...browser, completionSecretHash: completionHash };
	expect(await f.store.confirmAuthLinkAttempt(confirmation, f.cfg)).toMatchObject(applied);
}
for (const backend of ["SQLite", "D1"] as const) {
	const test = backendTest(backend);
	test(`${backend} commits coherent proof, link, audit and receipt`, async ({ fixture: f }) => {
		// Arrange: browser metadata is trusted test input, never a Google network call.
		await confirmed(f);
		const unchanged = snapshot(f, { unchangedOnly: true });
		// Act
		const [result, competing] = await Promise.all([
			f.store.finalizeAuthLinkAttempt(proof(), f.cfg),
			f.store.finalizeAuthLinkAttempt(proof(), f.cfg),
		]);
		const committed = snapshot(f);
		const retry = await f.store.finalizeAuthLinkAttempt(proof(), f.cfg);
		const read = await f.store.getAuthLinkAttemptStatus("attempt-a", device, f.cfg);
		// Assert: the collision trigger also prevents a retry from attempting a second proof INSERT.
		expect([result, competing]).toEqual(
			expect.arrayContaining([
				{ kind: "applied", status: status("finalized") },
				{ kind: "existing", status: status("finalized") },
			]),
		);
		expect(retry).toEqual({ kind: "existing", status: status("finalized") });
		expect(read).toEqual(status("finalized"));
		expect(claims(f)).toEqual([
			{
				claim_id: expect.any(String),
				coordinator_id: f.cfg.coordinatorId,
				identity_id: input.identityId,
				group_id: input.signer.groupId,
				device_id: input.signer.deviceId,
				public_key: input.signer.publicKey,
				fingerprint: input.signer.fingerprint,
				key_id: EXPECTED_KEY_ID,
				attempt_id: "attempt-a",
				issuer: f.cfg.issuer,
				auth_config_revision: f.cfg.revision,
				created_at_ms: f.now,
			},
		]);
		const claim = claims(f)[0] as { claim_id: string };
		const link = rows(f, TABLES[1])[0];
		const source = {
			authority_kind: "device_claim",
			device_claim_id: claim.claim_id,
			controller_attestation_id: null,
		};
		expect(rows(f, TABLES[1])).toEqual([
			expect.objectContaining({
				...source,
				link_id: expect.any(String),
				subject: "trusted-test-google-subject",
				identity_id: input.identityId,
				attempt_id: "attempt-a",
				issuer: f.cfg.issuer,
			}),
		]);
		expect(rows(f, TABLES[2])).toEqual([
			expect.objectContaining({
				...source,
				action: "link_created",
				link_id: link?.link_id,
				attempt_id: "attempt-a",
			}),
		]);
		expect(rows(f, TABLES[0])[0]).toMatchObject({
			state: "finalized",
			link_id: link?.link_id,
			finalized_at_ms: f.now,
		});
		expect(snapshot(f)).toEqual(committed);
		expect(snapshot(f, { unchangedOnly: true })).toEqual(unchanged);
		expect(() =>
			f.db.exec("UPDATE coordinator_auth_device_claims SET identity_id='other'"),
		).toThrow();
	});
	test.for([
		["Identity", { identityId: "other" }],
		["device", { deviceId: "other" }],
		["group", { groupId: "other" }],
		["key", { signer: { ...input.signer, publicKey: `${input.signer.publicKey} alias` } }],
		["fingerprint", { fingerprint: "f".repeat(64) }],
		["runtime", { runtimeVerifierHash: "f".repeat(64) }],
		["completion", { completionSecretHash: "f".repeat(64) }],
	] satisfies [string, Partial<CoordinatorAuthLinkFinalizeInput>][])(
		`${backend} wrong %s proof cannot consume or write`,
		async ([, change], { fixture: f }) => {
			// Arrange
			await confirmed(f);
			const before = snapshot(f);
			// Act
			const result = await f.store.finalizeAuthLinkAttempt({ ...proof(), ...change }, f.cfg);
			// Assert
			expect(result).toMatchObject(rejected);
			expect(snapshot(f)).toEqual(before);
			expect(await f.store.finalizeAuthLinkAttempt(proof(), f.cfg)).toMatchObject(applied);
			const committed = snapshot(f);
			expect(await f.store.finalizeAuthLinkAttempt({ ...proof(), ...change }, f.cfg)).toMatchObject(
				rejected,
			);
			expect(snapshot(f)).toEqual(committed);
		},
	);
	test.for([
		{ enabled: false },
		{ revision: "f".repeat(64) },
		{ issuer: "https://changed.example.test" },
	])(`${backend} changed trusted config cannot finalize`, async (change, { fixture: f }) => {
		// Arrange
		await confirmed(f);
		const before = snapshot(f);
		// Act
		const result = await f.store.finalizeAuthLinkAttempt(proof(), { ...f.cfg, ...change });
		// Assert
		expect(result).toMatchObject({ kind: "rejected" });
		expect(snapshot(f)).toEqual(before);
	});
	test.for([
		"UPDATE enrolled_devices SET enabled=0 WHERE device_id='device-a'",
		"UPDATE enrolled_devices SET public_key=public_key || ' changed' WHERE device_id='device-a'",
		"UPDATE enrolled_devices SET identity_id='other' WHERE device_id='device-a'",
		"UPDATE groups SET archived_at='archived'",
		seedKeyRevocationSql,
	])(
		`${backend} current eligibility is required before commit AND exact retry: %s`,
		async (mutation, { fixture: f }) => {
			// Arrange
			await confirmed(f);
			// Act / Assert: deny before commit without changing even the attempt.
			f.db.exec("SAVEPOINT eligibility_change");
			f.db.exec(mutation);
			const before = snapshot(f);
			expect(await f.store.finalizeAuthLinkAttempt(proof(), f.cfg)).toMatchObject(rejected);
			expect(snapshot(f)).toEqual(before);
			f.db.exec("ROLLBACK TO eligibility_change; RELEASE eligibility_change");
			expect(await f.store.finalizeAuthLinkAttempt(proof(), f.cfg)).toMatchObject(applied);
			f.db.exec(mutation);
			const retained = snapshot(f);
			expect(await f.store.finalizeAuthLinkAttempt(proof(), f.cfg)).toMatchObject(rejected);
			expect(snapshot(f)).toEqual(retained);
		},
	);
	test.for(["coordinator_auth_device_claims", TABLES[1], TABLES[2]])(
		`${backend} %s INSERT failure rolls back and permits retry`,
		async (table, { fixture: f }) => {
			// Arrange: use a real SQL abort, not a fake batch that persists early statements.
			await confirmed(f);
			const before = snapshot(f);
			const prepare = f.db.prepare.bind(f.db);
			let injected = false;
			let winningUpdateObserved = false;
			let executionHook: { mockRestore(): void } | undefined;
			const hook = vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
				const statement = prepare(sql);
				if (
					!executionHook &&
					/\bUPDATE\s+coordinator_auth_link_attempts\s+SET\s+state\s*=\s*'finalized'\s*,\s*link_id\s*=/.test(
						sql,
					)
				) {
					const run = statement.run.bind(statement);
					// D1 prepares ahead of its transaction: inject when the winning UPDATE runs.
					executionHook = vi.spyOn(statement, "run").mockImplementationOnce((...values) => {
						injected = true;
						f.db.exec(
							`CREATE TRIGGER finalization_fault BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected_finalization_failure'); END`,
						);
						const result = run(...values);
						winningUpdateObserved = result.changes === 1;
						return result;
					});
				}
				return statement;
			});
			// Act
			const failed = await f.store
				.finalizeAuthLinkAttempt(proof(), f.cfg)
				.catch(() => ({ kind: "storage_failure" }))
				.finally(() => {
					executionHook?.mockRestore();
					hook.mockRestore();
				});
			// Assert
			expect(injected).toBe(true);
			expect(winningUpdateObserved).toBe(true);
			expect(["rejected", "storage_failure"]).toContain(failed.kind);
			expect(snapshot(f)).toEqual(before);
			f.db.exec("DROP TRIGGER IF EXISTS finalization_fault");
			expect(await f.store.finalizeAuthLinkAttempt(proof(), f.cfg)).toMatchObject(applied);
			expect(claims(f)).toHaveLength(1);
			expect(rows(f, TABLES[1])).toHaveLength(1);
			expect(rows(f, TABLES[2])).toHaveLength(1);
		},
	);
	test.for([
		seedLinkSql,
		controllerLinkEvidenceSql({
			subject: "trusted-test-google-subject",
			identityId: "other-identity",
		}),
		`${seedLinkSql} UPDATE coordinator_auth_account_links SET revoked_at_ms=${NOW};`,
		seedClaimSql,
		deviceClaimEvidenceSql({ identityId: "other-identity", deviceId: "other-device" }),
	])(
		`${backend} existing account, Identity, device/key proof or tombstone cannot be replaced: %s`,
		async (conflict, { fixture: f }) => {
			// Arrange
			await confirmed(f);
			f.db.exec(conflict);
			const before = snapshot(f);
			// Act
			const result = await f.store.finalizeAuthLinkAttempt(proof(), f.cfg);
			// Assert
			expect(result).toMatchObject({ kind: "rejected" });
			expect(snapshot(f)).toEqual(before);
		},
	);
	test(`${backend} device proof plus Team grant is not controller authority`, async ({
		fixture: f,
	}) => {
		// Arrange
		await confirmed(f);
		expect(await f.store.finalizeAuthLinkAttempt(proof(), f.cfg)).toMatchObject(applied);
		f.db.exec("UPDATE coordinator_identity_group_grants SET identity_id='identity-a'");
		const before = snapshot(f);
		// Act
		const attested = await f.store.createAuthLinkAttempt(
			attempt({
				signer: input.signer,
				attemptId: "attested-replay",
				runtimeVerifierHash: "1".repeat(64),
			}),
			f.cfg,
		);
		// Assert
		expect(attested).toMatchObject({ kind: "rejected" });
		expect(snapshot(f)).toEqual(before);
	});
}
