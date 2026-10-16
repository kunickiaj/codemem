import { afterEach, expect, vi } from "vitest";
import {
	input,
	seedClaimSql,
	seedEnrollmentSql,
	seedKeyRevocationSql,
	seedLinkSql,
} from "../../cloudflare-coordinator-worker/test/device-claim-eligibility-fixture.js";
import type { CoordinatorAuthLinkCreateInput } from "./coordinator-auth-link-contract.js";
import { attempt, backendTest, type LinkFixture } from "./coordinator-auth-link-test-fixtures.js";

function deviceAttempt(changes: Partial<CoordinatorAuthLinkCreateInput> = {}) {
	return attempt({
		authority: { kind: "device_claim", identityId: input.identityId },
		signer: input.signer,
		browserStartHash: "e".repeat(64),
		...changes,
	});
}
function seed(f: LinkFixture) {
	f.db.exec(seedEnrollmentSql);
	return deviceAttempt();
}
function rows(f: LinkFixture) {
	return f.db.prepare("SELECT * FROM coordinator_auth_link_attempts ORDER BY attempt_id").all();
}
const mismatchCases: [string, Partial<CoordinatorAuthLinkCreateInput>][] = [
	["Identity", { authority: { kind: "device_claim", identityId: "other" } }],
	["source kind", { authority: { kind: "controller_attestation" } }],
	["group", { signer: { ...input.signer, groupId: "other" } }],
	["device", { signer: { ...input.signer, deviceId: "other" } }],
	["key bytes", { signer: { ...input.signer, publicKey: `${input.signer.publicKey} alias` } }],
	["fingerprint", { signer: { ...input.signer, fingerprint: "f".repeat(64) } }],
	["runtime verifier", { runtimeVerifierHash: "f".repeat(64) }],
	["browser start commitment", { browserStartHash: "f".repeat(64) }],
	["literal redirect", { loopbackRedirect: "http://127.0.0.1:5678/codemem/auth/complete" }],
];
afterEach(() => vi.restoreAllMocks());

for (const backend of ["SQLite", "D1"] as const) {
	const test = backendTest(backend);
	test(`${backend} creates a pending device claim with null controller pins and no other writes`, async ({
		fixture: f,
	}) => {
		const i = seed(f);
		const tables = f.db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name <> 'coordinator_auth_link_attempts' ORDER BY name",
			)
			.all() as { name: string }[];
		const snapshot = () => tables.map(({ name }) => f.db.prepare(`SELECT * FROM "${name}"`).all());
		const before = snapshot();
		expect(await f.store.createAuthLinkAttempt(i, f.cfg)).toMatchObject({
			kind: "created",
			identityId: input.identityId,
			status: { state: "pending", expiresAtMs: f.now + 600000 },
		});
		expect(rows(f)).toEqual([
			expect.objectContaining({
				authority_kind: "device_claim",
				identity_id: input.identityId,
				public_key: input.signer.publicKey,
				controller_attestation_id: null,
				controller_review_receipt_id: null,
				controller_revision: null,
				browser_start_hash: i.browserStartHash,
				account_subject: null,
			}),
		]);
		expect(snapshot()).toEqual(before);
	});
	test(`${backend} accepts matching assignment and preserves exact retry TTL and every column`, async ({
		fixture: f,
	}) => {
		const i = seed(f);
		f.db.exec("UPDATE enrolled_devices SET identity_id='identity-a' WHERE device_id='device-a'");
		expect(await f.store.createAuthLinkAttempt(i, f.cfg)).toMatchObject({ kind: "created" });
		const before = rows(f);
		f.now += 1000;
		expect(await f.store.createAuthLinkAttempt(i, f.cfg)).toMatchObject({
			kind: "existing",
			status: { expiresAtMs: f.now - 1000 + 600000 },
		});
		expect(rows(f)).toEqual(before);
	});
	test.for(mismatchCases)(
		`${backend} rejects changed %s on retry without mutation`,
		async ([, change], { fixture: f }) => {
			const i = seed(f);
			await f.store.createAuthLinkAttempt(i, f.cfg);
			const before = rows(f);
			expect(await f.store.createAuthLinkAttempt({ ...i, ...change }, f.cfg)).toEqual({
				kind: "rejected",
				error: "attempt_conflict",
			});
			expect(rows(f)).toEqual(before);
		},
	);
	test.for([{ revision: "f".repeat(64) }, { issuer: "https://other.example.test" }])(
		`${backend} rejects changed trusted configuration on retry`,
		async (change, { fixture: f }) => {
			const i = seed(f);
			await f.store.createAuthLinkAttempt(i, f.cfg);
			const before = rows(f);
			expect(await f.store.createAuthLinkAttempt(i, { ...f.cfg, ...change })).toEqual({
				kind: "rejected",
				error: "attempt_conflict",
			});
			expect(rows(f)).toEqual(before);
		},
	);
	test.for([
		"UPDATE enrolled_devices SET enabled=0 WHERE device_id='device-a'",
		"UPDATE enrolled_devices SET identity_id='other' WHERE device_id='device-a'",
		"UPDATE groups SET archived_at='archived'",
		seedKeyRevocationSql,
		seedLinkSql,
		seedClaimSql,
	])(`${backend} rechecks eligibility at INSERT: %s`, async (mutation, { fixture: f }) => {
		const i = seed(f);
		let injected = false;
		const prepare = f.db.prepare.bind(f.db);
		const fault = vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
			if (!injected && sql.includes("INSERT INTO coordinator_auth_link_attempts")) {
				injected = true;
				f.db.exec(mutation);
			}
			return prepare(sql);
		});
		expect(await f.store.createAuthLinkAttempt(i, f.cfg)).toMatchObject({ kind: "rejected" });
		expect(injected).toBe(true);
		expect(rows(f)).toEqual([]);
		fault.mockRestore();
	});
	test.for([
		"UPDATE enrolled_devices SET enabled=0 WHERE device_id='device-a'",
		"UPDATE enrolled_devices SET identity_id='other' WHERE device_id='device-a'",
		"UPDATE enrolled_devices SET public_key=public_key || ' changed' WHERE device_id='device-a'",
		"UPDATE groups SET archived_at='archived'",
		seedLinkSql,
	])(`${backend} repeats the live guard on exact retry: %s`, async (mutation, { fixture: f }) => {
		const i = seed(f);
		await f.store.createAuthLinkAttempt(i, f.cfg);
		const before = rows(f);
		f.db.exec(mutation);
		expect(await f.store.createAuthLinkAttempt(i, f.cfg)).toEqual({
			kind: "rejected",
			error: "attempt_unavailable",
		});
		expect(rows(f)).toEqual(before);
	});
	test(`${backend} checks the retry tuple again after recapture without writing`, async ({
		fixture: f,
	}) => {
		const i = seed(f);
		await f.store.createAuthLinkAttempt(i, f.cfg);
		let injected = false;
		const prepare = f.db.prepare.bind(f.db);
		vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
			if (
				!injected &&
				sql.includes("SELECT 1 FROM claim_input p JOIN coordinator_auth_link_attempts t")
			) {
				injected = true;
				f.db.exec(
					`UPDATE coordinator_auth_link_attempts SET runtime_verifier_hash='${"f".repeat(64)}'`,
				);
			}
			return prepare(sql);
		});
		expect(await f.store.createAuthLinkAttempt(i, f.cfg)).toEqual({
			kind: "rejected",
			error: "attempt_conflict",
		});
		expect(injected).toBe(true);
		expect(rows(f)).toHaveLength(1);
	});
	test(`${backend} allows a new attempt after uncommitted OIDC cancellation but never reuses commitments`, async ({
		fixture: f,
	}) => {
		const i = seed(f);
		await f.store.createAuthLinkAttempt(i, f.cfg);
		f.db.exec(
			`UPDATE coordinator_auth_link_attempts SET state='failed',failure_reason='device_cancelled',failed_at_ms=${f.now},browser_transaction_hash='${"a".repeat(64)}',account_subject='private-subject'`,
		);
		expect(await f.store.createAuthLinkAttempt({ ...i, attemptId: "other-id" }, f.cfg)).toEqual({
			kind: "rejected",
			error: "attempt_conflict",
		});
		expect(
			await f.store.createAuthLinkAttempt(
				deviceAttempt({
					attemptId: "other-id",
					runtimeVerifierHash: "f".repeat(64),
					browserStartHash: "d".repeat(64),
				}),
				f.cfg,
			),
		).toMatchObject({ kind: "created" });
		expect(rows(f)).toHaveLength(2);
	});
	test(`${backend} refuses a revoked exact retry without touching the pending attempt`, async ({
		fixture: f,
	}) => {
		const i = seed(f);
		await f.store.createAuthLinkAttempt(i, f.cfg);
		const before = rows(f);
		f.db.exec(seedKeyRevocationSql);
		expect(await f.store.createAuthLinkAttempt(i, f.cfg)).toEqual({
			kind: "rejected",
			error: "attempt_unavailable",
		});
		expect(rows(f)).toEqual(before);
	});
	test(`${backend} serializes concurrent quota admission and duplicate-ID retries`, async ({
		fixture: f,
	}) => {
		const i = seed(f);
		const duplicates = await Promise.all([
			f.store.createAuthLinkAttempt(i, f.cfg),
			f.store.createAuthLinkAttempt(i, f.cfg),
		]);
		expect(duplicates.map((r) => r.kind).sort()).toEqual(["created", "existing"]);
		const results = await Promise.all(
			[2, 3, 4].map((n) =>
				f.store.createAuthLinkAttempt(
					deviceAttempt({
						attemptId: `attempt-${n}`,
						runtimeVerifierHash: String(n).repeat(64),
						browserStartHash: String(n + 4).repeat(64),
					}),
					f.cfg,
				),
			),
		);
		expect(results.filter((r) => r.kind === "created")).toHaveLength(1);
		expect(results.filter((r) => r.kind === "rejected")).toHaveLength(2);
		expect(rows(f)).toHaveLength(2);
	});
	test(`${backend} keeps device-window quotas independent of requested Identity after cancellation`, async ({
		fixture: f,
	}) => {
		seed(f);
		for (let n = 1; n <= 6; n++) {
			const digest = n.toString(16).padStart(64, "0");
			expect(
				await f.store.createAuthLinkAttempt(
					deviceAttempt({
						attemptId: `attempt-${n}`,
						runtimeVerifierHash: digest,
						browserStartHash: digest,
					}),
					f.cfg,
				),
			).toMatchObject({ kind: "created" });
			f.db.exec(
				`UPDATE coordinator_auth_link_attempts SET state='failed',failure_reason='device_cancelled',failed_at_ms=${f.now} WHERE attempt_id='attempt-${n}'`,
			);
		}
		const before = rows(f);
		expect(
			await f.store.createAuthLinkAttempt(
				deviceAttempt({ authority: { kind: "device_claim", identityId: "new-unclaimed" } }),
				f.cfg,
			),
		).toEqual({ kind: "rejected", error: "attempt_limited" });
		expect(rows(f)).toEqual(before);
	});
}
