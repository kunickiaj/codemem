import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AUTH_LINK_PROFILE_SCHEMA_SQL } from "./coordinator-auth-link-profile.js";
import {
	advance,
	authorize,
	backendTest,
	browser,
	browserHash,
	browserProofConfig,
	completionHash,
	finalize,
	type LinkFixture,
	snapshot,
	TTL,
} from "./coordinator-auth-link-test-fixtures.js";
import {
	AUTH_SCHEMA_READINESS_SQL,
	AUTH_SCHEMA_READY_COUNT,
	CoordinatorAuthSchemaUpgradeRequiredError,
} from "./coordinator-auth-schema.js";
import {
	consumeSigninProof,
	credentialHash,
	signInInput,
} from "./coordinator-auth-session-test-fixtures.js";

const TABLE = "coordinator_auth_link_profiles";
const profile = {
	displayName: "Example Person",
	email: "person@example.test",
	emailVerified: true,
	pictureUrl: "https://images.example.test/avatar",
};
const proof = { attemptId: "attempt-a", browserTransactionHash: browserHash };
const account = { issuer: "https://accounts.example.test", subject: "opaque-subject-a" };
function rows(f: LinkFixture) {
	return f.db.prepare(`SELECT * FROM ${TABLE}`).all();
}
async function verified(f: LinkFixture, claims: unknown = profile) {
	await authorize(f);
	await advance(f, "browser_claimed");
	expect(
		await f.store.recordAuthLinkOidcVerified({ ...proof, account, profile: claims }, f.cfg),
	).toMatchObject({ kind: "applied" });
}
async function confirmed(f: LinkFixture) {
	expect(
		await f.store.confirmAuthLinkAttempt({ ...proof, completionSecretHash: completionHash }, f.cfg),
	).toMatchObject({ kind: "applied" });
}

function registerPersistenceTests(test: ReturnType<typeof backendTest>) {
	test("stages privately then promotes with the finalized link, without a browser session", async ({
		fixture: f,
	}) => {
		await verified(f);
		expect(rows(f)).toMatchObject([
			{
				link_id: null,
				display_name: profile.displayName,
				subject: account.subject,
				browser_transaction_hash: browserHash,
			},
		]);
		expect(f.db.prepare("SELECT * FROM coordinator_auth_account_links").all()).toEqual([]);
		await confirmed(f);
		expect(rows(f)).toMatchObject([{ link_id: null }]);
		expect(await f.store.finalizeAuthLinkAttempt(finalize(), f.cfg)).toMatchObject({
			kind: "applied",
		});
		expect(rows(f)).toMatchObject([
			{ link_id: expect.any(String), email: profile.email, picture_url: profile.pictureUrl },
		]);
		expect(f.db.prepare("SELECT * FROM coordinator_auth_sessions").all()).toEqual([]);
		expect(f.db.prepare("SELECT * FROM coordinator_auth_account_profiles").all()).toEqual([]);
		await consumeSigninProof(f, signInInput(f).browserTransactionHash);
		await f.store.signInWithConsumedBrowserTransaction(signInInput(f), browserProofConfig(f));
		expect(await f.store.readAuthSessionAccount(credentialHash, f.cfg)).toMatchObject({
			profile,
		});
	});
	test("a later explicit sign-in replaces the entire display snapshot, including empty fields", async ({
		fixture: f,
	}) => {
		await verified(f);
		await confirmed(f);
		await f.store.finalizeAuthLinkAttempt(finalize(), f.cfg);
		f.now += 1;
		await consumeSigninProof(f, signInInput(f).browserTransactionHash);
		await f.store.signInWithConsumedBrowserTransaction(signInInput(f), browserProofConfig(f));
		expect(await f.store.recordAuthAccountProfile({ credentialHash, profile: {} }, f.cfg)).toEqual({
			kind: "recorded",
		});
		expect(await f.store.readAuthSessionAccount(credentialHash, f.cfg)).toMatchObject({
			profile: {},
		});
	});
}
function registerFailureTests(test: ReturnType<typeof backendTest>) {
	test.for(["cancelled", "provider_failure"] as const)(
		"%s deletes private staging",
		async (reason, { fixture: f }) => {
			await verified(f);
			expect(
				await f.store.failAuthLinkAttempt(
					{ attemptId: proof.attemptId, requester: browser, reason },
					f.cfg,
				),
			).toMatchObject({ kind: "applied" });
			expect(rows(f)).toEqual([]);
			expect(await f.store.finalizeAuthLinkAttempt(finalize(), f.cfg)).toMatchObject({
				kind: "rejected",
			});
		},
	);
	test("expiry removes staging and cannot publish", async ({ fixture: f }) => {
		await verified(f);
		await confirmed(f);
		f.now += TTL;
		expect(await f.store.finalizeAuthLinkAttempt(finalize(), f.cfg)).toMatchObject({
			kind: "rejected",
		});
		await f.store.maintainAuthLinkAttempts(f.cfg);
		expect(rows(f)).toEqual([]);
	});
	test("configuration changes remove private staging and prevent finalization", async ({
		fixture: f,
	}) => {
		await verified(f);
		await confirmed(f);
		const changed = { ...f.cfg, revision: "9".repeat(64) };
		expect(await f.store.finalizeAuthLinkAttempt(finalize(), changed)).toMatchObject({
			kind: "rejected",
		});
		await f.store.maintainAuthLinkAttempts(changed);
		expect(rows(f)).toEqual([]);
	});
	test.for(["attempt", "binder", "issuer", "config"] as const)(
		"wrong %s cannot stage metadata",
		async (wrong, { fixture: f }) => {
			await authorize(f);
			await advance(f, "browser_claimed");
			const input = { ...proof, account: { ...account }, profile };
			if (wrong === "attempt") input.attemptId = "attempt-other";
			if (wrong === "binder") input.browserTransactionHash = "9".repeat(64);
			if (wrong === "issuer") input.account.issuer = "https://other.example.test";
			const config = { ...f.cfg };
			if (wrong === "config") config.revision = "9".repeat(64);
			expect(await f.store.recordAuthLinkOidcVerified(input, config)).toMatchObject({
				kind: "rejected",
			});
			expect(rows(f)).toEqual([]);
		},
	);
	test("a replay with another subject cannot replace the staged verified account", async ({
		fixture: f,
	}) => {
		await verified(f);
		const before = rows(f);
		expect(
			await f.store.recordAuthLinkOidcVerified(
				{
					...proof,
					account: { ...account, subject: "other-subject" },
					profile: { displayName: "Other" },
				},
				f.cfg,
			),
		).toMatchObject({ kind: "rejected" });
		expect(rows(f)).toEqual(before);
	});
	test("a different attempt cannot promote the staged profile", async ({ fixture: f }) => {
		await verified(f);
		await confirmed(f);
		expect(
			await f.store.finalizeAuthLinkAttempt(finalize({ attemptId: "attempt-other" }), f.cfg),
		).toMatchObject({ kind: "rejected" });
		expect(rows(f)).toMatchObject([{ link_id: null }]);
	});
}
function registerAtomicVerificationTests(test: ReturnType<typeof backendTest>) {
	test("a staging failure rolls back OIDC verification and the original request can retry", async ({
		fixture: f,
	}) => {
		// Arrange: inject failure only in the second statement of the verification batch.
		await authorize(f);
		await advance(f, "browser_claimed");
		const before = snapshot(f);
		const input = { ...proof, account, profile };
		f.db.exec(`CREATE TRIGGER fail_profile_insert BEFORE INSERT ON ${TABLE}
 BEGIN SELECT RAISE(ABORT, 'fixture staging failure'); END;`);
		// Act / Assert: neither the state nor account subject may survive a failed stage.
		await expect(f.store.recordAuthLinkOidcVerified(input, f.cfg)).rejects.toThrow(
			"auth_link_persistence_error",
		);
		expect(snapshot(f)).toEqual(before);
		expect(
			f.db
				.prepare(
					"SELECT state, account_subject, oidc_verified_at_ms FROM coordinator_auth_link_attempts",
				)
				.get(),
		).toEqual({
			state: "browser_claimed",
			account_subject: null,
			oidc_verified_at_ms: null,
		});
		expect(rows(f)).toEqual([]);
		// Act: remove only the fixture fault and retry the same verified input.
		f.db.exec("DROP TRIGGER fail_profile_insert");
		const retry = await f.store.recordAuthLinkOidcVerified(input, f.cfg);
		// Assert
		expect(retry).toMatchObject({ kind: "applied", status: { state: "oidc_verified" } });
		expect(rows(f)).toMatchObject([
			{ subject: account.subject, display_name: profile.displayName },
		]);
	});
	test("a missing staging table stops verification before any attempt mutation", async ({
		fixture: f,
	}) => {
		// Arrange: simulate an installation that has not applied the profile migration.
		await authorize(f);
		await advance(f, "browser_claimed");
		expect(f.db.prepare(AUTH_SCHEMA_READINESS_SQL).get()).toEqual({
			ready: AUTH_SCHEMA_READY_COUNT,
		});
		f.db.exec(`DROP TABLE ${TABLE}`);
		const before = snapshot(f);
		const schema = f.db.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
		// Act / Assert: the formal gate includes the new table, not just authority columns.
		expect(f.db.prepare(AUTH_SCHEMA_READINESS_SQL).get()).toEqual({
			ready: AUTH_SCHEMA_READY_COUNT - 1,
		});
		await expect(f.store.assertAuthSchemaReady()).rejects.toBeInstanceOf(
			CoordinatorAuthSchemaUpgradeRequiredError,
		);
		await expect(
			f.store.recordAuthLinkOidcVerified({ ...proof, account, profile }, f.cfg),
		).rejects.toBeInstanceOf(CoordinatorAuthSchemaUpgradeRequiredError);
		expect(snapshot(f)).toEqual(before);
		expect(f.db.prepare("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(schema);
	});
	test("a same-millisecond verification replay cannot backfill an unstaged profile", async ({
		fixture: f,
	}) => {
		// Arrange: the first verification has no optional profile and the fixture clock stays fixed.
		await authorize(f);
		await advance(f, "browser_claimed");
		expect(await f.store.recordAuthLinkOidcVerified({ ...proof, account }, f.cfg)).toMatchObject({
			kind: "applied",
		});
		expect(rows(f)).toEqual([]);
		const before = snapshot(f);
		// Act: matching timestamps and subject are not proof this call applied the transition.
		const replay = await f.store.recordAuthLinkOidcVerified({ ...proof, account, profile }, f.cfg);
		// Assert
		expect(replay).toMatchObject({ kind: "rejected" });
		expect(snapshot(f)).toEqual(before);
		expect(rows(f)).toEqual([]);
	});
}

function registerPrivacyTests(test: ReturnType<typeof backendTest>) {
	test("link conflicts roll back promotion", async ({ fixture: f }) => {
		await verified(f);
		await confirmed(f);
		f.db
			.prepare(`INSERT INTO coordinator_auth_account_links
 (coordinator_id,link_id,issuer,subject,identity_id,attempt_id,controller_attestation_id,auth_config_revision,created_at_ms,authority_kind)
 VALUES (?,?,?,?,?,?,?,?,?,'controller_attestation')`)
			.run(
				f.cfg.coordinatorId,
				"existing-link",
				account.issuer,
				account.subject,
				"other-identity",
				"other-attempt",
				"other-attestation",
				f.cfg.revision,
				f.now,
			);
		expect(await f.store.finalizeAuthLinkAttempt(finalize(), f.cfg)).toEqual({
			kind: "rejected",
			error: "link_conflict",
		});
		expect(rows(f)).toMatchObject([{ link_id: null }]);
	});
	test("revoked profiles are unreadable before cleanup and can be explicitly purged", async ({
		fixture: f,
	}) => {
		await verified(f);
		await confirmed(f);
		await f.store.finalizeAuthLinkAttempt(finalize(), f.cfg);
		await consumeSigninProof(f, signInInput(f).browserTransactionHash);
		await f.store.signInWithConsumedBrowserTransaction(signInInput(f), browserProofConfig(f));
		const link = f.db.prepare("SELECT link_id FROM coordinator_auth_account_links").get() as {
			link_id: string;
		};
		f.db.prepare("UPDATE coordinator_auth_account_links SET revoked_at_ms = ?").run(f.now);
		expect(await f.store.readAuthSessionAccount(credentialHash, f.cfg)).toBeNull();
		expect(
			await f.store.clearRevokedAuthAccountProfile(
				{ linkId: link.link_id },
				{ coordinatorId: f.cfg.coordinatorId },
			),
		).toEqual({ kind: "cleared", deletedCount: 1 });
		expect(rows(f)).toEqual([]);
	});
	test("invalid display claims are discarded", async ({ fixture: f }) => {
		await verified(f, {
			displayName: "\u0000",
			email: "",
			emailVerified: true,
			pictureUrl: "javascript:alert(1)",
			unknown: "discard",
		});
		expect(rows(f)).toMatchObject([
			{ display_name: null, email: null, email_verified: null, picture_url: null },
		]);
	});
}

for (const backend of ["SQLite", "D1"] as const) {
	describe(`${backend} verified link profile`, () => {
		const test = backendTest(backend);
		registerPersistenceTests(test);
		registerFailureTests(test);
		registerPrivacyTests(test);
		registerAtomicVerificationTests(test);
	});
}

it("the reviewed migration and fresh Worker schema include the exact new table definition", () => {
	const worker = new URL("../../cloudflare-coordinator-worker/", import.meta.url);
	const migration = readFileSync(
		new URL("migrations/0033_add_auth_link_profiles.sql", worker),
		"utf8",
	);
	const schema = readFileSync(new URL("schema.sql", worker), "utf8");
	expect(migration).toContain(AUTH_LINK_PROFILE_SCHEMA_SQL.trim());
	expect(schema).toContain(AUTH_LINK_PROFILE_SCHEMA_SQL.trim());
});
