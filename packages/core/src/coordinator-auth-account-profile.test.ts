import { describe, expect, vi } from "vitest";
import type { CoordinatorAuthAccountProfileInput } from "./coordinator-auth-account-profile-contract.js";
import { type LinkFixture, snapshot } from "./coordinator-auth-link-test-fixtures.js";
import {
	backendTest,
	credentialHash,
	grants,
	linked,
	linkId,
	otherCredentialHash,
	redeemInput,
	revokeLinkRow,
	SESSION_TTL,
	type SessionTest,
	sessionRows,
	signInInput,
} from "./coordinator-auth-session-test-fixtures.js";
import type { Backend } from "./coordinator-auth-store-test-fixtures.js";

const TABLE = "coordinator_auth_account_profiles";
const fullProfile = {
	displayName: "Example Person",
	email: "person@example.test",
	emailVerified: true,
	pictureUrl: "https://images.example.test/avatar.png",
};

function profiles(f: LinkFixture) {
	return f.db.prepare(`SELECT * FROM ${TABLE} ORDER BY coordinator_id, link_id`).all();
}

function authority(f: LinkFixture) {
	return { grants: grants(f), links: snapshot(f), sessions: sessionRows(f) };
}

async function signedIn(f: LinkFixture) {
	await linked(f);
	const result = await f.store.signInWithAuthAccount(signInInput(f), f.cfg);
	if (result.kind !== "issued") throw new Error("fixture_session_not_issued");
	return result.session;
}

async function secondSignIn(f: LinkFixture) {
	const result = await f.store.signInWithAuthAccount(
		{
			...signInInput(f),
			credentialHash: otherCredentialHash,
			browserTransactionHash: "2".repeat(64),
		},
		f.cfg,
	);
	if (result.kind !== "issued") throw new Error("fixture_session_not_issued");
	return result.session;
}

function record(f: LinkFixture, profile: unknown = fullProfile, hash = credentialHash) {
	return f.store.recordAuthAccountProfile({ credentialHash: hash, profile }, f.cfg);
}

function registerBasics(test: SessionTest) {
	test("fresh verified metadata reads beside the unchanged session and grants no authority", async ({
		fixture: f,
	}) => {
		// Arrange
		const session = await signedIn(f);
		const before = authority(f);
		const issuedAt = f.now;
		f.now += 100;
		// Act
		const result = await record(f);
		const account = await f.store.readAuthSessionAccount(credentialHash, f.cfg);
		// Assert
		expect(result).toEqual({ kind: "recorded" });
		expect(account).toEqual({ session, profile: fullProfile });
		expect(profiles(f)).toEqual([
			{
				coordinator_id: f.cfg.coordinatorId,
				link_id: session.linkId,
				display_name: fullProfile.displayName,
				email: fullProfile.email,
				email_verified: 1,
				picture_url: fullProfile.pictureUrl,
				source_session_id: session.sessionId,
				source_signed_in_at_ms: issuedAt,
			},
		]);
		expect(authority(f)).toEqual(before);
	});
	test("missing profile is an empty display projection, not missing authentication", async ({
		fixture: f,
	}) => {
		// Arrange
		const session = await signedIn(f);
		const before = authority(f);
		// Act
		const account = await f.store.readAuthSessionAccount(credentialHash, f.cfg);
		// Assert
		expect(account).toEqual({ session, profile: {} });
		expect(profiles(f)).toEqual([]);
		expect(authority(f)).toEqual(before);
	});
	test.for([
		{ displayName: "New Person" },
		{},
		{ email: "new@example.test", emailVerified: false },
	])("newer sign-in replaces all optional fields with %j", async (profile, { fixture: f }) => {
		// Arrange
		await signedIn(f);
		await record(f);
		f.now += 1;
		const session = await secondSignIn(f);
		const before = authority(f);
		// Act
		const result = await record(f, profile, otherCredentialHash);
		// Assert
		expect(result).toEqual({ kind: "recorded" });
		expect(await f.store.readAuthSessionAccount(credentialHash, f.cfg)).toEqual({
			session: await f.store.readAuthSession(credentialHash, f.cfg),
			profile,
		});
		expect(profiles(f)).toEqual([
			expect.objectContaining({
				display_name: "displayName" in profile ? profile.displayName : null,
				email: "email" in profile ? profile.email : null,
				email_verified: "emailVerified" in profile ? 0 : null,
				picture_url: null,
				source_session_id: session.sessionId,
				source_signed_in_at_ms: f.now,
			}),
		]);
		expect(authority(f)).toEqual(before);
	});
	test("unknown callback claims and caller-nominated provenance never persist", async ({
		fixture: f,
	}) => {
		// Arrange
		const session = await signedIn(f);
		const input = {
			credentialHash,
			profile: {
				...fullProfile,
				issuer: "untrusted",
				subject: "untrusted",
				rawClaims: {},
				access_token: "untrusted",
				nonce: "untrusted",
				pkceVerifier: "untrusted",
			},
			linkId: "other-link",
			source_session_id: "other-session",
			source_signed_in_at_ms: 0,
		};
		const before = authority(f);
		// Act
		await f.store.recordAuthAccountProfile(input, f.cfg);
		// Assert
		expect(await f.store.readAuthSessionAccount(credentialHash, f.cfg)).toEqual({
			session,
			profile: fullProfile,
		});
		expect(profiles(f)).toEqual([
			expect.objectContaining({
				link_id: session.linkId,
				source_session_id: session.sessionId,
				source_signed_in_at_ms: f.now,
			}),
		]);
		expect(Object.keys(profiles(f)[0] as object).sort()).toEqual([
			"coordinator_id",
			"display_name",
			"email",
			"email_verified",
			"link_id",
			"picture_url",
			"source_session_id",
			"source_signed_in_at_ms",
		]);
		expect(authority(f)).toEqual(before);
	});
}

function registerOrdering(test: SessionTest) {
	test.for(["older", "equal"] as const)(
		"%s issuance cannot clobber the first/newer writer",
		async (order, { fixture: f }) => {
			// Arrange
			await signedIn(f);
			if (order === "older") f.now += 1_000;
			await secondSignIn(f);
			await record(f, fullProfile, otherCredentialHash);
			const before = profiles(f);
			const authBefore = authority(f);
			f.now += 1_000;
			// Act
			const result = await record(f, { displayName: "Late stale writer" });
			// Assert
			expect(result).toEqual({ kind: "not_recorded" });
			expect(profiles(f)).toEqual(before);
			expect(authority(f)).toEqual(authBefore);
		},
	);
	test("same-session replay with different metadata is immutable", async ({ fixture: f }) => {
		// Arrange
		await signedIn(f);
		await record(f);
		const before = profiles(f);
		const authBefore = authority(f);
		f.now += 500;
		// Act
		const replay = await record(f, { displayName: "Changed replay" });
		// Assert: recorded is advisory; an idempotent result must not authorize mutation.
		expect(replay).toEqual({ kind: "recorded" });
		expect(profiles(f)).toEqual(before);
		expect(authority(f)).toEqual(authBefore);
	});
	test.for([119_999, 120_000])(
		"freshness boundary uses issuance + %i ms",
		async (elapsed, { fixture: f }) => {
			// Arrange
			const session = await signedIn(f);
			f.now += elapsed;
			const before = authority(f);
			// Act
			const result = await record(f);
			// Assert
			expect(result).toEqual({ kind: elapsed === 119_999 ? "recorded" : "not_recorded" });
			expect(await f.store.readAuthSessionAccount(credentialHash, f.cfg)).toEqual({
				session,
				profile: elapsed === 119_999 ? fullProfile : {},
			});
			expect(authority(f)).toEqual(before);
		},
	);
	test("link-redemption session remains readable but cannot supply profile metadata", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		const issued = await f.store.redeemAuthLinkSession(redeemInput(), f.cfg);
		if (issued.kind !== "issued") throw new Error("fixture_session_not_issued");
		const before = authority(f);
		// Act
		const result = await record(f);
		// Assert
		expect(result).toEqual({ kind: "not_recorded" });
		expect(await f.store.readAuthSessionAccount(credentialHash, f.cfg)).toEqual({
			session: issued.session,
			profile: {},
		});
		expect(profiles(f)).toEqual([]);
		expect(authority(f)).toEqual(before);
	});
}

function changeGuard(f: LinkFixture, change: string) {
	if (change === "expired") f.now += SESSION_TTL;
	if (change === "future-born") f.now -= 1;
	if (change === "session-revoked")
		f.db.prepare("UPDATE coordinator_auth_sessions SET revoked_at_ms = ?").run(f.now);
	if (change === "link-revoked") revokeLinkRow(f);
	if (change === "link-missing") f.db.exec("DELETE FROM coordinator_auth_account_links");
	if (change === "link-identity")
		f.db.exec("UPDATE coordinator_auth_account_links SET identity_id = 'other'");
	if (change === "link-subject")
		f.db.exec("UPDATE coordinator_auth_account_links SET subject = 'other'");
	if (change === "link-issuer")
		f.db.exec("UPDATE coordinator_auth_account_links SET issuer = 'https://other.example.test'");
}

function registerGuards(test: SessionTest) {
	test.for([
		"unknown",
		"namespace",
		"revision",
		"issuer",
		"disabled",
		"expired",
		"future-born",
		"session-revoked",
		"link-revoked",
		"link-missing",
		"link-identity",
		"link-subject",
		"link-issuer",
	] as const)(
		"account read matches session denial and write cannot bypass %s",
		async (change, { fixture: f }) => {
			// Arrange
			await signedIn(f);
			await record(f);
			f.now += 1;
			await secondSignIn(f);
			const cfg = { ...f.cfg };
			if (change === "namespace") cfg.coordinatorId = "other-coordinator";
			if (change === "revision") cfg.revision = "3".repeat(64);
			if (change === "issuer") cfg.issuer = "https://other.example.test";
			if (change === "disabled") cfg.enabled = false;
			changeGuard(f, change);
			const hash = change === "unknown" ? "9".repeat(64) : otherCredentialHash;
			const before = { profile: profiles(f), authority: authority(f) };
			// Act
			const result = await f.store.recordAuthAccountProfile(
				{ credentialHash: hash, profile: { displayName: "Denied" } },
				cfg,
			);
			const account = await f.store.readAuthSessionAccount(hash, cfg);
			const session = await f.store.readAuthSession(hash, cfg);
			// Assert
			expect(result.kind).not.toBe("recorded");
			expect(session).toBeNull();
			expect(account).toBeNull();
			expect({ profile: profiles(f), authority: authority(f) }).toEqual(before);
		},
	);
	test.for(["missing", "session", "link", "revision", "time", "browser"] as const)(
		"incoherent signin receipt %s denies profile writes",
		async (change, { fixture: f }) => {
			// Arrange
			await signedIn(f);
			const mutations: Record<string, string> = {
				missing: "DELETE FROM coordinator_auth_session_receipts",
				session: "UPDATE coordinator_auth_session_receipts SET session_id = 'other'",
				link: "UPDATE coordinator_auth_session_receipts SET link_id = 'other'",
				revision: `UPDATE coordinator_auth_session_receipts SET auth_config_revision = '${"4".repeat(64)}'`,
				time: "UPDATE coordinator_auth_session_receipts SET created_at_ms = created_at_ms + 1",
				browser: `UPDATE coordinator_auth_session_receipts SET browser_transaction_hash = '${"5".repeat(64)}'`,
			};
			f.db.exec(mutations[change] as string);
			const before = authority(f);
			// Act
			const result = await record(f);
			// Assert
			expect(result).toEqual({ kind: "not_recorded" });
			expect(profiles(f)).toEqual([]);
			expect(authority(f)).toEqual(before);
		},
	);
}

const invalidOptional = [
	{ displayName: 42 },
	{ displayName: {} },
	{ displayName: "" },
	{ displayName: "x".repeat(257) },
	{ displayName: "a\u0000b" },
	{ displayName: "a\u202eb" },
	{ displayName: "\ud800" },
	{ email: "x".repeat(321), emailVerified: true },
	{ email: 1, emailVerified: true },
	{ email: "a\nb", emailVerified: true },
	{ emailVerified: true },
	{ email: "person@example.test", emailVerified: "true" },
	{ email: "person@example.test", emailVerified: 1 },
] as const;
const invalidPictures = [
	"http://images.example.test/a",
	"https://user:pass@images.example.test/a",
	"https://images.example.test/a#fragment",
	"https://images.example.test/a\nb",
	"https://images.example.test\\a",
	" https://images.example.test/a",
	"https://images.example.test/a ",
	`https://images.example.test/${"x".repeat(2048)}`,
	`https://images.example.test/${"é".repeat(400)}`,
	"https://images.example.test/\ud800",
	"https://images.example.test/\u202e",
] as const;

function registerSanitization(test: SessionTest) {
	test.for(invalidOptional)(
		"drops malformed display scalar %j without coercion",
		async (bad, { fixture: f }) => {
			// Arrange
			const session = await signedIn(f);
			const before = authority(f);
			const expected =
				"email" in bad && bad.email === "person@example.test" ? { email: bad.email } : {};
			// Act
			const result = await record(f, bad);
			// Assert
			expect(result).toEqual({ kind: "recorded" });
			expect(await f.store.readAuthSessionAccount(credentialHash, f.cfg)).toEqual({
				session,
				profile: expected,
			});
			expect(authority(f)).toEqual(before);
		},
	);
	test.for(invalidPictures)(
		"drops unsafe picture %j without any image fetch",
		async (pictureUrl, { fixture: f }) => {
			// Arrange
			const session = await signedIn(f);
			// Act
			const result = await record(f, { displayName: "Safe", pictureUrl });
			// Assert
			expect(result).toEqual({ kind: "recorded" });
			expect(await f.store.readAuthSessionAccount(credentialHash, f.cfg)).toEqual({
				session,
				profile: { displayName: "Safe" },
			});
			expect(profiles(f)).toEqual([expect.objectContaining({ picture_url: null })]);
		},
	);
	test("accepts bounded metadata, false email verification and canonical non-Google HTTPS picture", async ({
		fixture: f,
	}) => {
		// Arrange
		const session = await signedIn(f);
		const profile = {
			displayName: "x".repeat(256),
			email: "e".repeat(320),
			emailVerified: false,
			pictureUrl: "HTTPS://IMAGES.EXAMPLE.TEST:443/a",
		};
		// Act
		await record(f, profile);
		// Assert
		expect(await f.store.readAuthSessionAccount(credentialHash, f.cfg)).toEqual({
			session,
			profile: { ...profile, pictureUrl: "https://images.example.test/a" },
		});
		expect(profiles(f)).toEqual([expect.objectContaining({ email_verified: 0 })]);
	});
	test("invalid stored metadata is sanitized while session denial remains decisive", async ({
		fixture: f,
	}) => {
		// Arrange: simulate a legacy/corrupted optional display row only.
		const session = await signedIn(f);
		await record(f);
		f.db.exec("PRAGMA ignore_check_constraints = ON");
		f.db
			.prepare(
				`UPDATE ${TABLE} SET display_name = ?, email = ?, email_verified = ?, picture_url = ?`,
			)
			.run("bad\u202e", "bad\nemail", 2, "http://unsafe.example.test/a");
		f.db.exec("PRAGMA ignore_check_constraints = OFF");
		const before = profiles(f);
		// Act
		const valid = await f.store.readAuthSessionAccount(credentialHash, f.cfg);
		revokeLinkRow(f);
		const denied = await f.store.readAuthSessionAccount(credentialHash, f.cfg);
		// Assert
		expect(valid).toEqual({ session, profile: {} });
		expect(denied).toBeNull();
		expect(profiles(f)).toEqual(before);
	});
}

function malformedInput(kind: string, getter: () => unknown): unknown {
	if (kind === "null") return null;
	if (kind === "array") return [];
	if (kind === "hash") return { credentialHash: "short", profile: {} };
	if (kind === "profile-null") return { credentialHash, profile: null };
	if (kind === "profile-array") return { credentialHash, profile: [] };
	if (kind === "profile-prototype")
		return { credentialHash, profile: Object.create({ displayName: "inherited" }) };
	if (kind === "input-prototype") return Object.create({ credentialHash, profile: {} });
	if (kind === "profile-getter")
		return {
			credentialHash,
			profile: Object.defineProperty({}, "displayName", { get: getter, enumerable: true }),
		};
	return Object.defineProperty({ profile: {} }, "credentialHash", {
		get: getter,
		enumerable: true,
	});
}

function registerInput(test: SessionTest) {
	test.for([{ coordinatorId: "" }, { revision: "short" }, { issuer: "" }, { enabled: "true" }])(
		"rejects malformed configuration %j rather than coercing it",
		async (change, { fixture: f }) => {
			// Arrange
			await signedIn(f);
			const cfg = { ...f.cfg, ...change } as typeof f.cfg;
			const before = authority(f);
			// Act
			const result = await f.store.recordAuthAccountProfile({ credentialHash, profile: {} }, cfg);
			const read = await f.store.readAuthSessionAccount(credentialHash, cfg);
			// Assert
			expect(result).toEqual({ kind: "rejected", error: "invalid_input" });
			expect(read).toBeNull();
			expect(profiles(f)).toEqual([]);
			expect(authority(f)).toEqual(before);
		},
	);
	test("disabled configuration returns auth_config_changed without creating metadata", async ({
		fixture: f,
	}) => {
		// Arrange
		await signedIn(f);
		const before = authority(f);
		// Act
		const result = await f.store.recordAuthAccountProfile(
			{ credentialHash, profile: {} },
			{ ...f.cfg, enabled: false },
		);
		// Assert
		expect(result).toEqual({ kind: "rejected", error: "auth_config_changed" });
		expect(profiles(f)).toEqual([]);
		expect(authority(f)).toEqual(before);
	});
	test.for([null, 1, {}, "short", "E".repeat(64)] as const)(
		"account read rejects malformed credential %j without mutation",
		async (hash, { fixture: f }) => {
			// Arrange
			await signedIn(f);
			await record(f);
			const before = { profile: profiles(f), authority: authority(f) };
			// Act
			const result = await f.store.readAuthSessionAccount(hash as string, f.cfg);
			// Assert
			expect(result).toBeNull();
			expect(await f.store.readAuthSession(hash as string, f.cfg)).toBeNull();
			expect({ profile: profiles(f), authority: authority(f) }).toEqual(before);
		},
	);
	test.for([
		"null",
		"array",
		"hash",
		"profile-null",
		"profile-array",
		"profile-prototype",
		"input-prototype",
		"profile-getter",
		"hash-getter",
	] as const)(
		"rejects own-input violation %s without invoking accessors",
		async (kind, { fixture: f }) => {
			// Arrange
			await signedIn(f);
			const getter = vi.fn(() => {
				throw new Error("getter_must_not_run");
			});
			const input = malformedInput(kind, getter) as CoordinatorAuthAccountProfileInput;
			const before = { profile: profiles(f), authority: authority(f) };
			// Act
			const result = await f.store.recordAuthAccountProfile(input, f.cfg);
			// Assert
			expect(result).toEqual({ kind: "rejected", error: "invalid_input" });
			expect(getter).not.toHaveBeenCalled();
			expect({ profile: profiles(f), authority: authority(f) }).toEqual(before);
		},
	);
	test("does not invoke coercion hooks on optional scalar objects", async ({ fixture: f }) => {
		// Arrange
		const session = await signedIn(f);
		const coercion = vi.fn(() => {
			throw new Error("coercion_must_not_run");
		});
		const scalar = { toString: coercion, valueOf: coercion, [Symbol.toPrimitive]: coercion };
		// Act
		const result = await record(f, {
			displayName: scalar,
			email: scalar,
			emailVerified: scalar,
			pictureUrl: scalar,
		});
		// Assert
		expect(result).toEqual({ kind: "recorded" });
		expect(coercion).not.toHaveBeenCalled();
		expect(await f.store.readAuthSessionAccount(credentialHash, f.cfg)).toEqual({
			session,
			profile: {},
		});
	});
	test("malformed config accessor is rejected without invocation or mutation", async ({
		fixture: f,
	}) => {
		// Arrange
		await signedIn(f);
		const getter = vi.fn(() => {
			throw new Error("config_getter_must_not_run");
		});
		const cfg = Object.defineProperty({ ...f.cfg }, "enabled", { get: getter });
		const before = authority(f);
		// Act
		const result = await f.store.recordAuthAccountProfile({ credentialHash, profile: {} }, cfg);
		const read = await f.store.readAuthSessionAccount(credentialHash, cfg);
		// Assert
		expect(result).toEqual({ kind: "rejected", error: "invalid_input" });
		expect(read).toBeNull();
		expect(getter).not.toHaveBeenCalled();
		expect(profiles(f)).toEqual([]);
		expect(authority(f)).toEqual(before);
	});
}

function registerNamespace(test: SessionTest) {
	test("profile operations never fetch a trusted non-Google image or call external verification", async ({
		fixture: f,
	}) => {
		// Arrange
		await signedIn(f);
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected_network"));
		try {
			// Act
			await record(f);
			await f.store.readAuthSessionAccount(credentialHash, f.cfg);
			await f.store.clearRevokedAuthAccountProfile(
				{ linkId: linkId(f) },
				{ coordinatorId: f.cfg.coordinatorId },
			);
			// Assert
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
		}
	});
	test("another coordinator's display row cannot decorate this coordinator's live session", async ({
		fixture: f,
	}) => {
		// Arrange
		const session = await signedIn(f);
		await record(f);
		f.db.prepare(`UPDATE ${TABLE} SET coordinator_id = 'other-coordinator'`).run();
		const before = { profile: profiles(f), authority: authority(f) };
		// Act
		const read = await f.store.readAuthSessionAccount(credentialHash, f.cfg);
		// Assert
		expect(read).toEqual({ session, profile: {} });
		expect({ profile: profiles(f), authority: authority(f) }).toEqual(before);
	});
}

function registerCleanup(test: SessionTest) {
	test("active clear does nothing; revoked clear removes only the scoped display row", async ({
		fixture: f,
	}) => {
		// Arrange
		await signedIn(f);
		await record(f);
		const id = linkId(f);
		const scope = { coordinatorId: f.cfg.coordinatorId };
		f.db
			.prepare(
				`INSERT INTO ${TABLE} SELECT 'other-coordinator', link_id, display_name, email, email_verified, picture_url, source_session_id, source_signed_in_at_ms FROM ${TABLE}`,
			)
			.run();
		const before = authority(f);
		const beforeProfiles = profiles(f);
		// Act
		const active = await f.store.clearRevokedAuthAccountProfile({ linkId: id }, scope);
		// Assert
		expect(active).toEqual({ kind: "cleared", deletedCount: 0 });
		expect(profiles(f)).toEqual(beforeProfiles);
		expect(authority(f)).toEqual(before);
		// Arrange: old revocation is explicitly requested separately.
		await f.store.revokeAuthAccountLink({ linkId: id }, scope);
		const revoked = authority(f);
		// Act
		const cleared = await f.store.clearRevokedAuthAccountProfile({ linkId: id }, scope);
		const retry = await f.store.clearRevokedAuthAccountProfile({ linkId: id }, scope);
		// Assert
		expect(cleared).toEqual({ kind: "cleared", deletedCount: 1 });
		expect(retry).toEqual({ kind: "cleared", deletedCount: 0 });
		expect(profiles(f)).toEqual([expect.objectContaining({ coordinator_id: "other-coordinator" })]);
		expect(authority(f)).toEqual(revoked);
		expect(await f.store.readAuthSession(credentialHash, f.cfg)).toBeNull();
	});
	test.for(["absent", "delete-abort"] as const)(
		"old revocation remains effective despite optional profile table %s",
		async (fault, { fixture: f }) => {
			// Arrange
			await signedIn(f);
			await record(f);
			const input = { linkId: linkId(f) };
			const scope = { coordinatorId: f.cfg.coordinatorId };
			if (fault === "absent") f.db.exec(`DROP TABLE ${TABLE}`);
			else
				f.db.exec(
					`CREATE TRIGGER fixture_profile_delete_fault BEFORE DELETE ON ${TABLE} BEGIN SELECT RAISE(ABORT, 'private_backend_detail'); END`,
				);
			// Act
			const revoke = await f.store.revokeAuthAccountLink(input, scope);
			const revoked = authority(f);
			const cleanup = f.store.clearRevokedAuthAccountProfile(input, scope);
			// Assert
			expect(revoke).toEqual({ kind: "revoked" });
			await expect(cleanup).rejects.toThrow(/^auth_account_profile_persistence_error$/);
			expect(authority(f)).toEqual(revoked);
			expect(await f.store.readAuthSession(credentialHash, f.cfg)).toBeNull();
			if (fault === "delete-abort") expect(profiles(f)).toHaveLength(1);
		},
	);
	test.for(["missing", "namespace"] as const)(
		"clear cannot remove a profile for %s scope/link",
		async (change, { fixture: f }) => {
			// Arrange
			await signedIn(f);
			await record(f);
			revokeLinkRow(f);
			const before = { profile: profiles(f), authority: authority(f) };
			// Act
			const result = await f.store.clearRevokedAuthAccountProfile(
				{ linkId: change === "missing" ? "missing" : linkId(f) },
				{ coordinatorId: change === "namespace" ? "other" : f.cfg.coordinatorId },
			);
			// Assert
			expect(result).toEqual({ kind: "cleared", deletedCount: 0 });
			expect({ profile: profiles(f), authority: authority(f) }).toEqual(before);
		},
	);
	test.for(["link", "scope"] as const)(
		"clear rejects malformed %s without getters",
		async (target, { fixture: f }) => {
			// Arrange
			await signedIn(f);
			await record(f);
			const getter = vi.fn(() => {
				throw new Error("clear_getter_must_not_run");
			});
			const input =
				target === "link"
					? (Object.defineProperty({}, "linkId", { get: getter }) as { linkId: string })
					: { linkId: linkId(f) };
			const scope =
				target === "scope"
					? (Object.defineProperty({}, "coordinatorId", { get: getter }) as {
							coordinatorId: string;
						})
					: { coordinatorId: f.cfg.coordinatorId };
			const before = { profile: profiles(f), authority: authority(f) };
			// Act
			const result = await f.store.clearRevokedAuthAccountProfile(input, scope);
			// Assert
			expect(result).toEqual({ kind: "rejected", error: "invalid_input" });
			expect(getter).not.toHaveBeenCalled();
			expect({ profile: profiles(f), authority: authority(f) }).toEqual(before);
		},
	);
	test("SQL write abort preserves the previously recorded profile and all authority", async ({
		fixture: f,
	}) => {
		// Arrange
		await signedIn(f);
		await record(f);
		f.now += 1;
		await secondSignIn(f);
		for (const event of ["INSERT", "UPDATE"])
			f.db.exec(
				`CREATE TRIGGER fixture_profile_${event.toLowerCase()}_fault BEFORE ${event} ON ${TABLE} BEGIN SELECT RAISE(ABORT, 'private_backend_detail'); END`,
			);
		const before = { profile: profiles(f), authority: authority(f) };
		// Act
		const write = record(f, { displayName: "Must not persist" }, otherCredentialHash);
		// Assert
		await expect(write).rejects.toThrow(/^auth_account_profile_persistence_error$/);
		expect({ profile: profiles(f), authority: authority(f) }).toEqual(before);
	});
}

function registerBackend(backend: Backend) {
	const test = backendTest(backend);
	registerBasics(test);
	registerOrdering(test);
	registerGuards(test);
	registerSanitization(test);
	registerInput(test);
	registerNamespace(test);
	registerCleanup(test);
}

describe.each(["SQLite", "D1"] as const)(
	"%s account profiles (D1 is SQLite-backed)",
	registerBackend,
);
