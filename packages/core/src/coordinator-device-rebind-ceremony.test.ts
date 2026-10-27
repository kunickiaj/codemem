import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { CoordinatorAuthBrowserConfig } from "./coordinator-auth-browser-transaction-contract.js";
import { type Backend, setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import { issueBrowserCookie } from "./coordinator-browser-credential.js";
import { importBrowserCsrfKey } from "./coordinator-browser-csrf.js";
import {
	createDeviceRebindCeremony,
	type DeviceRebindResult,
	type DeviceRebindSigner,
} from "./coordinator-device-rebind-ceremony.js";
import { deviceRebindFinalMessage } from "./coordinator-device-rebind-proof.js";
import { commitPendingKey } from "./coordinator-owner-enrollment-commit-test-fixtures.js";
import {
	browserForm,
	config,
	nativeBackend,
	ORIGIN,
} from "./coordinator-owner-enrollment-start-test-fixtures.js";
import { createD1AuthLinkBackend } from "./d1-coordinator-store.js";

const NOW = 1_791_028_800_000;
const CURRENT = "local:device-work";
const TARGET = "identity-target";
const SUBJECT = "subject-target";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const closers: Array<() => unknown> = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
});

/** A migrated device in two groups whose person's Google account is linked to TARGET. */
async function rebindCeremonyFixture(kind: Backend) {
	const store = setupStore(kind, { authClock: () => NOW });
	closers.push(async () => {
		await store.store.close();
		if (store.db.open) store.db.close();
	});
	const { db } = store;
	const key = commitPendingKey();
	const signer: DeviceRebindSigner = {
		groupId: "group-a",
		deviceId: "device-work",
		publicKey: key.publicKey,
		fingerprint: sha(key.publicKey),
	};
	for (const group of ["group-a", "group-b"]) {
		db.prepare("INSERT INTO groups (group_id, created_at) VALUES (?, 'created')").run(group);
		db.prepare(
			`INSERT INTO enrolled_devices (group_id, device_id, public_key, fingerprint, identity_id, enabled, created_at)
			 VALUES (?, ?, ?, ?, ?, 1, 'created')`,
		).run(
			group,
			signer.deviceId,
			signer.publicKey,
			signer.fingerprint,
			group === "group-a" ? null : CURRENT,
		);
	}
	db.prepare(
		`INSERT INTO coordinator_identity_group_grants (coordinator_id, identity_id, group_id, status, revision,
		 source_kind, source_receipt_id, created_at) VALUES (?, ?, 'group-a', 'active', 1, 'controller_attestation',
		 'receipt', 'created')`,
	).run(config.coordinatorId, TARGET);
	db.prepare(
		`INSERT INTO coordinator_auth_account_links (coordinator_id, link_id, issuer, subject, identity_id,
		 attempt_id, auth_config_revision, created_at_ms, authority_kind, device_claim_id)
		 VALUES (?, 'link-target', ?, ?, ?, 'link-attempt', ?, 1, 'device_claim', 'claim-target')`,
	).run(config.coordinatorId, config.issuer, SUBJECT, TARGET, config.revision);
	const account = { subject: SUBJECT };
	const material = {
		state: randomBytes(32).toString("base64url"),
		nonce: randomBytes(32).toString("base64url"),
		pkceVerifier: randomBytes(32).toString("base64url"),
	};
	const csrfKey = await importBrowserCsrfKey(new Uint8Array(32).fill(17));
	const backend = kind === "SQLite" ? nativeBackend(db) : createD1AuthLinkBackend(sqliteD1(db));
	const ceremony = createDeviceRebindCeremony({
		backend,
		config: config as unknown as CoordinatorAuthBrowserConfig,
		publicOrigin: ORIGIN,
		csrfKey,
		limiter: { check: () => ({ allowed: true, retryAfterS: 0 }) },
		client: {
			createAuthorizationRequest: async () => ({
				authorizationUrl: "https://accounts.google.com/o/oauth2/auth?client_id=test-client",
				material,
			}),
			verifyCallback: async () => ({
				ok: true,
				account: { issuer: config.issuer, subject: account.subject },
				profile: {},
			}),
		},
		now: () => NOW,
	});
	return { db, signer, key, ceremony, account, material, csrfKey };
}
type Fixture = Awaited<ReturnType<typeof rebindCeremonyFixture>>;

const startCode = () => randomBytes(32).toString("base64url");
function startInput(f: Fixture, code: string, attemptId = "rebind-a") {
	return {
		attemptId,
		signer: f.signer,
		currentIdentityId: CURRENT,
		loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
		browserStartHash: createHash("sha256").update(Buffer.from(code, "base64url")).digest("hex"),
		reviewDigest: "e".repeat(64),
	};
}

/** Device start, browser claim, and the Google callback, as the person would. */
async function throughCallback(f: Fixture, beforeCallback?: () => void, attemptId = "rebind-a") {
	const code = startCode();
	expect(await f.ceremony.start(startInput(f, code, attemptId), "client-a")).toMatchObject({
		kind: "started",
	});
	const form = await browserForm(attemptId, code);
	const claimed = await f.ceremony.claimBrowser(form.request(), "client-a");
	if (claimed?.kind !== "browser_claimed") throw new Error(`claim: ${JSON.stringify(claimed)}`);
	const transactionCookie = claimed.setCookies[0]?.split(";")[0] ?? "";
	beforeCallback?.();
	const callback = await f.ceremony.verifyCallback(
		new Request(`${config.redirectUri}?state=${f.material.state}&code=provider-code`, {
			headers: { cookie: transactionCookie },
		}),
	);
	return { callback, transactionCookie };
}

async function confirmRequest(transactionCookie: string, csrf: string) {
	return new Request(`${ORIGIN}/auth/rebind/confirm`, {
		method: "POST",
		headers: {
			origin: ORIGIN,
			cookie: transactionCookie,
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({ csrf, attempt_id: "rebind-a" }),
	});
}

async function throughConfirm(f: Fixture) {
	const { callback, transactionCookie } = await throughCallback(f);
	if (callback?.kind !== "verified") throw new Error(`callback: ${JSON.stringify(callback)}`);
	const confirmed = await f.ceremony.confirm(
		await confirmRequest(transactionCookie, callback.csrf),
		"client-a",
		callback.confirmation.confirmationHash,
	);
	if (confirmed?.kind !== "confirmed") throw new Error(`confirm: ${JSON.stringify(confirmed)}`);
	return { confirmation: callback.confirmation, completionSecret: confirmed.completionSecret };
}

function finalizeInput(f: Fixture, completionSecret: string) {
	const row = f.db
		.prepare("SELECT * FROM coordinator_device_rebind_attempts WHERE attempt_id = 'rebind-a'")
		.get() as Parameters<typeof deviceRebindFinalMessage>[0];
	return {
		attemptId: "rebind-a",
		signer: f.signer,
		completionSecret,
		signature: f.key.sign(deviceRebindFinalMessage(row, completionSecret)),
	};
}

const identities = (f: Fixture) =>
	f.db
		.prepare(
			"SELECT identity_id FROM enrolled_devices WHERE device_id = 'device-work' ORDER BY group_id",
		)
		.pluck()
		.all();

function registerCeremony(kind: Backend) {
	it("rebinds the device after start, Google sign-in, confirmation and the device's signature", async () => {
		// Arrange
		const f = await rebindCeremonyFixture(kind);
		const { confirmation, completionSecret } = await throughConfirm(f);
		// Act
		const finalized = await f.ceremony.finalize(finalizeInput(f, completionSecret));
		const status = await f.ceremony.status({ attemptId: "rebind-a", signer: f.signer });
		// Assert
		expect(confirmation).toMatchObject({
			currentIdentityId: CURRENT,
			targetIdentityId: TARGET,
			subject: SUBJECT,
			groupsWithoutAccess: ["group-b"],
		});
		expect(finalized).toMatchObject({ kind: "finalized", receipt: { targetIdentityId: TARGET } });
		expect(identities(f)).toEqual([TARGET, TARGET]);
		expect(status).toMatchObject({
			kind: "status",
			state: "finalized",
			receipt: { targetIdentityId: TARGET },
		});
	});

	it("writes nothing when the browser confirms a different commitment", async () => {
		// Arrange
		const f = await rebindCeremonyFixture(kind);
		const { callback, transactionCookie } = await throughCallback(f);
		if (callback?.kind !== "verified") throw new Error("expected verification");
		// Act
		const confirmed = await f.ceremony.confirm(
			await confirmRequest(transactionCookie, callback.csrf),
			"client-a",
			"0".repeat(64),
		);
		// Assert
		expect(confirmed).toEqual({ kind: "refused", reason: "unavailable" });
		expect(identities(f)).toEqual([null, CURRENT]);
	});

	it("does not finalize for another device", async () => {
		// Arrange
		const f = await rebindCeremonyFixture(kind);
		const { completionSecret } = await throughConfirm(f);
		const other = { ...f.signer, deviceId: "device-other" };
		// Act
		const result = await f.ceremony.finalize({
			...finalizeInput(f, completionSecret),
			signer: other,
		});
		// Assert
		expect(result).toEqual({ kind: "refused", reason: "unavailable" });
		expect(identities(f)).toEqual([null, CURRENT]);
	});
}

function registerRefusals(kind: Backend) {
	it.each([
		[
			"current_identity_linked",
			`INSERT INTO coordinator_auth_account_links (coordinator_id, link_id, issuer, subject, identity_id,
			 attempt_id, auth_config_revision, created_at_ms, authority_kind, device_claim_id)
			 VALUES ('${config.coordinatorId}', 'link-current', '${config.issuer}', 'subject-current', '${CURRENT}',
			 'link-attempt-current', '${config.revision}', 1, 'device_claim', 'claim-current')`,
		],
		[
			"device_already_bound",
			`INSERT INTO coordinator_device_ownership_bindings (device_id, key_id, identity_id, coordinator_id,
			 binding_id, provenance, source_ref, bound_at)
			 VALUES ('device-work', '${"f".repeat(64)}', 'someone', '${config.coordinatorId}', 'b', 'owner_enrollment', 's', 'bound')`,
		],
	] as const)("refuses to start with %s", async (reason, sql) => {
		// Arrange
		const f = await rebindCeremonyFixture(kind);
		f.db.exec(sql);
		// Act
		const result = await f.ceremony.start(startInput(f, startCode()), "client-a");
		// Assert
		expect(result).toEqual({ kind: "refused", reason });
		expect(
			f.db.prepare("SELECT count(*) FROM coordinator_device_rebind_attempts").pluck().get(),
		).toBe(0);
	});

	it.each([
		[
			"account_not_linked",
			(f: Fixture) => Object.assign(f.account, { subject: "subject-unlinked" }),
		],
		[
			"already_this_identity",
			(f: Fixture) =>
				f.db.exec(`UPDATE coordinator_auth_account_links SET identity_id = '${CURRENT}'`),
		],
	] as const)("refuses at the Google callback with %s", async (reason, change) => {
		// Arrange: the account changes while the person is signing in.
		const f = await rebindCeremonyFixture(kind);
		// Act
		const { callback } = await throughCallback(f, () => change(f));
		// Assert
		expect(callback).toEqual({ kind: "refused", reason });
		expect(f.db.prepare("SELECT state FROM coordinator_device_rebind_attempts").pluck().get()).toBe(
			"browser_claimed",
		);
	});

	it("leaves another ceremony's browser transaction alone", async () => {
		// Arrange: a pending owner-enrollment transaction with a matching state and cookie.
		const f = await rebindCeremonyFixture(kind);
		const cookie = await issueBrowserCookie("transaction");
		f.db
			.prepare(
				`INSERT INTO coordinator_auth_browser_transactions (coordinator_id, browser_transaction_hash, purpose,
				 attempt_id, state_hash, binder_hash, issuer, auth_config_revision, redirect_uri, state, nonce,
				 pkce_verifier, created_at_ms, expires_at_ms)
				 VALUES (?, ?, 'owner_enroll', 'owner-attempt', ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
			)
			.run(
				config.coordinatorId,
				"c".repeat(64),
				sha(f.material.state),
				cookie.cookieHash,
				config.issuer,
				config.revision,
				config.redirectUri,
				f.material.nonce,
				f.material.pkceVerifier,
				NOW,
				NOW + 600_000,
			);
		// Act
		const result: DeviceRebindResult | null = await f.ceremony.verifyCallback(
			new Request(`${config.redirectUri}?state=${f.material.state}&code=provider-code`, {
				headers: { cookie: cookie.setCookie.split(";")[0] ?? "" },
			}),
		);
		// Assert: not claimed, and not burned for the owner ceremony.
		expect(result).toBeNull();
		expect(
			f.db.prepare("SELECT state FROM coordinator_auth_browser_transactions").pluck().get(),
		).toBe("pending");
	});
}

const linkCurrentSql = `INSERT INTO coordinator_auth_account_links (coordinator_id, link_id, issuer, subject,
 identity_id, attempt_id, auth_config_revision, created_at_ms, authority_kind, device_claim_id)
 VALUES ('${config.coordinatorId}', 'link-current', '${config.issuer}', 'subject-current', '${CURRENT}',
 'link-attempt-current', '${config.revision}', 1, 'device_claim', 'claim-current')`;

function registerReviewFixes(kind: Backend) {
	it("names the reason when the current Identity gets its own link during sign-in", async () => {
		// Arrange
		const f = await rebindCeremonyFixture(kind);
		// Act
		const { callback } = await throughCallback(f, () => f.db.exec(linkCurrentSql));
		// Assert
		expect(callback).toEqual({ kind: "refused", reason: "current_identity_linked" });
	});

	it("refuses to confirm Team effects that changed after the person saw them", async () => {
		// Arrange: the target loses its grant in group-a after the callback.
		const f = await rebindCeremonyFixture(kind);
		const { callback, transactionCookie } = await throughCallback(f);
		if (callback?.kind !== "verified") throw new Error("expected verification");
		f.db.exec(
			"UPDATE coordinator_identity_group_grants SET status = 'revoked', revoked_at = 'revoked'",
		);
		// Act
		const confirmed = await f.ceremony.confirm(
			await confirmRequest(transactionCookie, callback.csrf),
			"client-a",
			callback.confirmation.confirmationHash,
		);
		// Assert
		expect(confirmed).toMatchObject({ kind: "refused" });
		expect(f.db.prepare("SELECT state FROM coordinator_device_rebind_attempts").pluck().get()).toBe(
			"oidc_verified",
		);
	});

	it("refuses a current Identity that no enrollment of the device names", async () => {
		// Arrange: legacy enrollments record no Identity at all.
		const f = await rebindCeremonyFixture(kind);
		f.db.exec("UPDATE enrolled_devices SET identity_id = NULL");
		// Act
		const result = await f.ceremony.start(
			{ ...startInput(f, startCode()), currentIdentityId: "identity-unrelated" },
			"client-a",
		);
		// Assert
		expect(result).toEqual({ kind: "refused", reason: "unavailable" });
	});

	it.each([
		["a forged signature", "unavailable", () => undefined],
		[
			"a target link revoked after confirmation",
			"account_not_linked",
			(f: Fixture) => f.db.exec("UPDATE coordinator_auth_account_links SET revoked_at_ms = 1"),
		],
		[
			"a device enrollment added after confirmation",
			"unavailable",
			(f: Fixture) =>
				f.db.exec(`INSERT INTO groups (group_id, created_at) VALUES ('group-c', 'created');
				 INSERT INTO enrolled_devices (group_id, device_id, public_key, fingerprint, enabled, created_at)
				 SELECT 'group-c', device_id, public_key, fingerprint, 1, 'created' FROM enrolled_devices LIMIT 1`),
		],
		[
			"a target at its daily limit",
			"daily_limit",
			(f: Fixture) =>
				f.db.exec(
					[0, 1, 2]
						.map(
							(index) => `INSERT INTO coordinator_device_rebind_audit_log (coordinator_id, event_id,
							 attempt_id, action, binding_id, device_id, previous_identity_id, target_identity_id,
							 enrollment_count, created_at_ms) VALUES ('${config.coordinatorId}', 'e-${index}', 'a-${index}',
							 'owner_device_rebound', 'b-${index}', 'd-${index}', 'p-${index}', '${TARGET}', 1, ${NOW - 1000})`,
						)
						.join(";"),
				),
		],
	] as const)("does not ask to retry a finalize refused for %s", async (name, reason, setup) => {
		// Arrange
		const f = await rebindCeremonyFixture(kind);
		const { completionSecret } = await throughConfirm(f);
		setup(f);
		const input = finalizeInput(f, completionSecret);
		// Act
		const result = await f.ceremony.finalize(
			name === "a forged signature" ? { ...input, signature: f.key.sign("forged") } : input,
		);
		// Assert
		expect(result).toEqual({ kind: "refused", reason });
	});
}

describe.each(["SQLite", "D1"] as const)("%s device rebind ceremony", (kind) => {
	registerCeremony(kind);
	registerRefusals(kind);
	registerReviewFixes(kind);
});
