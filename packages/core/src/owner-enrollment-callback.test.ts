import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import { issueBrowserCookie, readBrowserCookie } from "./coordinator-browser-credential.js";
import { verifyBrowserCsrfToken } from "./coordinator-browser-csrf.js";
import { oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";
import { commitOwnerEnrollment, type OwnerAttempt } from "./coordinator-owner-enrollment-commit.js";
import {
	commitPendingKey,
	commitProofMessage,
} from "./coordinator-owner-enrollment-commit-test-fixtures.js";
import {
	ATTEMPTS,
	browserForm,
	config,
	hash,
	nativeBackend,
	ORIGIN,
	type OwnerStartFixture,
	ownerCallbackAuthority,
	ownerStartFixture,
	proof,
	seedOwnerCallbackAuthority,
	TRANSACTIONS,
} from "./coordinator-owner-enrollment-start-test-fixtures.js";
import {
	createCoordinatorOwnerEnrollment,
	ownerEnrollmentStartMessage,
} from "./owner-enrollment-start.js";

const cfg = { ...config, clientId: PROVIDER.clientId, clientSecret: PROVIDER.clientSecret };
const unavailable = { kind: "rejected", error: "owner_enrollment_unavailable" };
let f: OwnerStartFixture;
beforeEach(() => {
	f = ownerStartFixture();
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("live network forbidden"));
});
afterEach(() => {
	try {
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		f.close();
		vi.restoreAllMocks();
	}
});

async function claimed() {
	const input = {
		attemptId: "attempt-a",
		deviceId: "device-a",
		publicKey: f.key.publicKey,
		loopbackRedirect: "http://127.0.0.1:43210/codemem/auth/complete",
		browserStartCode: proof(),
		signature: "",
	};
	input.signature = f.key.sign(
		ownerEnrollmentStartMessage(input, {
			coordinatorId: cfg.coordinatorId,
			origin: ORIGIN,
			issuer: cfg.issuer,
			revision: cfg.revision,
		}),
	);
	const form = await browserForm(input.attemptId, input.browserStartCode);
	const provider = oidcFixture({ issuer: cfg.issuer });
	let now = NOW;
	const options = {
		purpose: "owner_enroll" as const,
		mode: "local_test" as const,
		config: cfg,
		backend: f.backend,
		csrfKey: form.csrfKey,
		limiter: { check: () => ({ allowed: true, retryAfterS: 0 }) },
		oidcOptions: { fetch: provider.fetch },
		clock: () => now,
	};
	const composed = await createCoordinatorOwnerEnrollment(options);
	if (!composed.ok) throw new Error("fixture composition failed");
	expect((await composed.enrollment.start(input)).kind).toBe("started");
	const claim = await composed.enrollment.claimBrowser(form.request(), "browser-a");
	if (claim.kind !== "browser_claimed") throw new Error("fixture claim failed");
	const cookie = claim.setCookies[0]?.split(";")[0];
	if (!cookie) throw new Error("missing transaction cookie");
	seedOwnerCallbackAuthority(f);
	const url = provider.authorize(claim.authorizationUrl);
	return {
		...composed.enrollment,
		options,
		provider,
		form,
		url,
		cookie,
		claim,
		request: (callback = url, binder = cookie) =>
			new Request(callback, { headers: { cookie: binder } }),
		setNow: (value: number) => {
			now = value;
		},
	};
}
type Ceremony = Awaited<ReturnType<typeof claimed>>;
function consumed() {
	expect(f.rows(TRANSACTIONS)[0]).toMatchObject({
		state: "consumed",
		nonce: null,
		pkce_verifier: null,
		consumed_at_ms: NOW,
	});
}
function noVerifiedAccount() {
	expect(f.rows(ATTEMPTS)[0]).toMatchObject({
		account_subject: null,
		identity_id: null,
		link_id: null,
		grant_revisions_json: null,
		confirmation_hash: null,
		completion_secret_hash: null,
	});
}
function exchangeAfterConsumption(c: Ceremony, change?: () => void) {
	const transport = c.provider.fetch.getMockImplementation();
	if (!transport) throw new Error("missing maintained provider transport");
	c.provider.fetch.mockImplementation(async (url, options) => {
		consumed();
		if (url === `${cfg.issuer}/token`) change?.();
		return transport(url, options);
	});
}

function excludeGroup(group: string, decision: Record<string, unknown>, db = f.db) {
	db.prepare(
		"INSERT INTO coordinator_legacy_team_completions VALUES (?, 'candidate-a',1,?,?,?)",
	).run(
		group,
		JSON.stringify({ coordinator_id: cfg.coordinatorId, device_decisions: [decision] }),
		new Date(NOW).toISOString(),
		new Date(NOW).toISOString(),
	);
}

function noNewEnrollmentAuthority() {
	expect(f.rows("coordinator_device_ownership_bindings")).toEqual([]);
	expect(f.rows("enrolled_devices").filter((row) => row.device_id === "device-a")).toEqual([]);
	expect(f.rows("coordinator_owner_enrollment_audit_log")).toEqual([]);
}

it("pins the SDK-verified exact account and eligible grants without creating authority", async () => {
	// Arrange: historical link config/controller evidence is not the new ceremony revision.
	const c = await claimed();
	const before = ownerCallbackAuthority(f);
	exchangeAfterConsumption(c);
	// Act
	const result = await c.verifyCallback(c.request());
	// Assert: no historical controller enrollment is needed to resolve current account authority.
	expect(result.kind).toBe("verified");
	if (result.kind !== "verified") throw new Error("missing verified confirmation");
	expect(result.confirmation).toMatchObject({
		attemptId: "attempt-a",
		coordinatorId: cfg.coordinatorId,
		origin: ORIGIN,
		deviceId: "device-a",
		publicKey: f.key.publicKey,
		issuer: cfg.issuer,
		subject: "fixture-subject",
		identityId: "identity-a",
		linkId: "link-a",
		revision: cfg.revision,
		confirmationHash: expect.stringMatching(/^[a-f0-9]{64}$/),
	});
	const transactionCookie = await readBrowserCookie(c.cookie, "transaction");
	if (transactionCookie.kind !== "present") throw new Error("missing real transaction cookie");
	expect(
		await verifyBrowserCsrfToken(
			c.form.csrfKey,
			transactionCookie.secret,
			"transaction",
			{ publicOrigin: ORIGIN, store: cfg },
			result.csrf,
		),
	).toBe(true);
	expect(
		await verifyBrowserCsrfToken(
			c.form.csrfKey,
			c.form.cookie.secret,
			"start",
			{ publicOrigin: ORIGIN, store: cfg },
			result.csrf,
		),
	).toBe(false);
	expect(f.rows(ATTEMPTS)[0]).toMatchObject({
		state: "oidc_verified",
		account_subject: "fixture-subject",
		identity_id: "identity-a",
		link_id: "link-a",
		link_attempt_id: "historical-attempt",
		link_controller_attestation_id: "historical-controller",
		link_auth_config_revision: "b".repeat(64),
		auth_config_revision: cfg.revision,
		confirmation_hash: null,
		completion_secret_hash: null,
	});
	expect(JSON.parse(f.rows(ATTEMPTS)[0]?.grant_revisions_json as string)).toEqual([
		{ groupId: "group-a", revision: 2 },
		{ groupId: "group-b", revision: 3 },
	]);
	consumed();
	expect(ownerCallbackAuthority(f)).toEqual(before);
	expect(c.provider.requests.map(({ url }) => url)).toEqual([
		`${cfg.issuer}/.well-known/openid-configuration`,
		`${cfg.issuer}/token`,
		`${cfg.issuer}/jwks`,
	]);
});

it.each(["binder", "state", "duplicate-state", "path", "host", "fragment"])(
	"rejects callback %s before consuming or calling the provider",
	async (fault) => {
		// Arrange
		const c = await claimed();
		const url = new URL(c.url);
		let cookie = c.cookie;
		if (fault === "binder")
			cookie = (await issueBrowserCookie("transaction")).setCookie.split(";")[0] ?? "";
		if (fault === "state") url.searchParams.set("state", proof());
		if (fault === "duplicate-state")
			url.searchParams.append("state", url.searchParams.get("state") ?? "");
		if (fault === "path") url.pathname = "/auth/other";
		if (fault === "host") url.hostname = "evil.example.test";
		if (fault === "fragment") url.hash = "injected";
		const before = f.snapshot();
		const authority = ownerCallbackAuthority(f);
		const fetches = c.provider.fetch.mock.calls.length;
		// Act
		const result = await c.verifyCallback(c.request(url, cookie));
		// Assert
		expect(result).toEqual(unavailable);
		expect(f.snapshot()).toEqual(before);
		expect(ownerCallbackAuthority(f)).toEqual(authority);
		expect(c.provider.fetch).toHaveBeenCalledTimes(fetches);
	},
);

it.each(["code", "nonce", "pkce", "jws", "issuer", "missing-subject", "wrong-subject"])(
	"burns transaction proof before failed SDK verification of %s",
	async (fault) => {
		// Arrange: every token still passes through the real SDK; no verified-account mock.
		const c = await claimed();
		if (fault === "code") c.url.searchParams.set("code", "unknown-code");
		if (fault === "nonce") c.provider.claims.nonce = "wrong-nonce";
		if (fault === "pkce")
			c.url = c.provider.authorize(c.claim.authorizationUrl, { challenge: "wrong-challenge" });
		if (fault === "jws") c.provider.settings.signature = "wrong-key";
		if (fault === "issuer") c.provider.claims.iss = "https://other-issuer.example.test";
		if (fault === "missing-subject") c.provider.claims.sub = undefined;
		if (fault === "wrong-subject") c.provider.claims.sub = "unlinked-subject";
		const before = ownerCallbackAuthority(f);
		exchangeAfterConsumption(c);
		// Act
		const result = await c.verifyCallback(c.request(c.url));
		const replay = await c.verifyCallback(c.request(c.url));
		// Assert: a failed exchange cannot be retried with the retained nonce or verifier.
		expect(result).toEqual(unavailable);
		expect(replay).toEqual(unavailable);
		consumed();
		noVerifiedAccount();
		expect(ownerCallbackAuthority(f)).toEqual(before);
		expect(c.provider.requests.filter(({ url }) => url === `${cfg.issuer}/token`)).toHaveLength(1);
	},
);

it.each(["missing", "revoked", "wrong-issuer", "wrong-subject", "no-eligible-grants"])(
	"denies a genuinely verified account with %s existing link",
	async (fault) => {
		// Arrange
		const c = await claimed();
		if (fault === "no-eligible-grants") f.db.exec(`UPDATE groups SET archived_at='2026-10-01'`);
		if (fault === "missing") f.db.exec("DELETE FROM coordinator_auth_account_links");
		if (fault === "revoked")
			f.db.exec(`UPDATE coordinator_auth_account_links SET revoked_at_ms=${NOW}`);
		if (fault === "wrong-issuer")
			f.db.exec("UPDATE coordinator_auth_account_links SET issuer='https://other.example.test'");
		if (fault === "wrong-subject")
			f.db.exec("UPDATE coordinator_auth_account_links SET subject='another-subject'");
		const before = ownerCallbackAuthority(f);
		// Act
		const result = await c.verifyCallback(c.request());
		// Assert: opaque issuer+subject, not profile/email or a controller claim, resolves identity.
		expect(result).toEqual(unavailable);
		consumed();
		noVerifiedAccount();
		expect(ownerCallbackAuthority(f)).toEqual(before);
	},
);

it("rejects expiry at the exact deadline without provider access or new authority", async () => {
	// Arrange
	const c = await claimed();
	c.setNow(NOW + 600000);
	const before = ownerCallbackAuthority(f);
	const fetches = c.provider.fetch.mock.calls.length;
	// Act
	const result = await c.verifyCallback(c.request());
	// Assert
	expect(result).toEqual(unavailable);
	noVerifiedAccount();
	expect(ownerCallbackAuthority(f)).toEqual(before);
	expect(c.provider.fetch).toHaveBeenCalledTimes(fetches);
});

it("rejects callback replay after success without exchanging a second code", async () => {
	// Arrange
	const c = await claimed();
	expect((await c.verifyCallback(c.request())).kind).toBe("verified");
	const before = f.snapshot();
	const authority = ownerCallbackAuthority(f);
	const fetches = c.provider.fetch.mock.calls.length;
	// Act
	const result = await c.verifyCallback(c.request());
	// Assert
	expect(result).toEqual(unavailable);
	expect(f.snapshot()).toEqual(before);
	expect(ownerCallbackAuthority(f)).toEqual(authority);
	expect(c.provider.fetch).toHaveBeenCalledTimes(fetches);
});

it("rejects an outstanding transaction after server configuration revision drift", async () => {
	// Arrange
	const c = await claimed();
	const changed = await createCoordinatorOwnerEnrollment({
		...c.options,
		config: { ...cfg, revision: "c".repeat(64) },
	});
	if (!changed.ok) throw new Error("changed composition failed");
	const before = ownerCallbackAuthority(f);
	const fetches = c.provider.fetch.mock.calls.length;
	// Act
	const result = await changed.enrollment.verifyCallback(c.request());
	// Assert
	expect(result).toEqual(unavailable);
	noVerifiedAccount();
	expect(ownerCallbackAuthority(f)).toEqual(before);
	expect(c.provider.fetch).toHaveBeenCalledTimes(fetches);
});

it.each(["link-revision", "link-attempt", "link-controller", "revocation", "grant-revision"])(
	"rejects %s drift between authority read and write",
	async (fault) => {
		// Arrange: mutate from an independent connection at the final conditional write.
		const c = await claimed();
		let injected = false;
		let authorityAfterDrift: unknown[] = [];
		const backend: AuthLinkBackend = {
			...f.backend,
			run: async (statement) => {
				if (statement.sql.includes("SET state = 'oidc_verified'")) {
					const changes: Record<string, string> = {
						"link-revision":
							"UPDATE coordinator_auth_account_links SET auth_config_revision='" +
							"c".repeat(64) +
							"'",
						"link-attempt":
							"UPDATE coordinator_auth_account_links SET attempt_id='changed-attempt'",
						"link-controller":
							"UPDATE coordinator_auth_account_links SET controller_attestation_id='changed-controller'",
						revocation: `UPDATE coordinator_auth_account_links SET revoked_at_ms=${NOW}`,
						"grant-revision":
							"UPDATE coordinator_identity_group_grants SET revision=revision+1 WHERE group_id='group-a'",
					};
					f.second.exec(changes[fault] ?? "");
					injected = true;
					authorityAfterDrift = ownerCallbackAuthority(f);
				}
				return f.backend.run(statement);
			},
		};
		const composed = await createCoordinatorOwnerEnrollment({ ...c.options, backend });
		if (!composed.ok) throw new Error("race composition failed");
		// Act
		const result = await composed.enrollment.verifyCallback(c.request());
		// Assert: no stale account/grant snapshot becomes verified enrollment authority.
		expect(injected).toBe(true);
		expect(result.kind).toBe("rejected");
		consumed();
		noVerifiedAccount();
		expect(ownerCallbackAuthority(f)).toEqual(authorityAfterDrift);
		expect(f.rows("coordinator_device_ownership_bindings")).toEqual([]);
		expect(f.rows("enrolled_devices")).toEqual([]);
		expect(f.rows("coordinator_owner_enrollment_audit_log")).toEqual([]);
	},
);

it.each(["missing-transaction", "invalid-code"])(
	"never lets a live management session bypass %s",
	async (fault) => {
		// Arrange: a real session credential backed by an unrevoked local session row.
		const c = await claimed();
		const session = await issueBrowserCookie("session");
		const cookie = session.setCookie.split(";")[0] ?? "";
		const parsed = await readBrowserCookie(cookie, "session");
		if (parsed.kind !== "present") throw new Error("missing fixture session cookie");
		f.db
			.prepare(`INSERT INTO coordinator_auth_sessions
 (coordinator_id,session_id,credential_hash,browser_transaction_hash,link_id,identity_id,
 issuer,subject,auth_config_revision,created_at_ms,expires_at_ms)
 VALUES (?,?,?,?,'link-a','identity-a',?,'fixture-subject',?,?,?)`)
			.run(
				cfg.coordinatorId,
				"session-a",
				parsed.cookieHash,
				"f".repeat(64),
				cfg.issuer,
				cfg.revision,
				NOW,
				NOW + 28800000,
			);
		if (fault === "invalid-code") c.url.searchParams.set("code", "wrong-code");
		const before = ownerCallbackAuthority(f);
		const binder = fault === "missing-transaction" ? cookie : `${c.cookie}; ${cookie}`;
		// Act
		const result = await c.verifyCallback(c.request(c.url, binder));
		// Assert: existing session identity does not stand in for a fresh OIDC proof.
		expect(result).toEqual(unavailable);
		noVerifiedAccount();
		if (fault === "invalid-code") consumed();
		expect(ownerCallbackAuthority(f)).toEqual(before);
	},
);

it("allows only one callback exchange across native SQLite connections", async () => {
	// Arrange: pause winner at token exchange after durable consumption, not with sleeps.
	const c = await claimed();
	const second = await createCoordinatorOwnerEnrollment({
		...c.options,
		backend: nativeBackend(f.second),
	});
	if (!second.ok) throw new Error("second composition failed");
	let entered!: () => void;
	let release!: () => void;
	const atToken = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const continueToken = new Promise<void>((resolve) => {
		release = resolve;
	});
	const transport = c.provider.fetch.getMockImplementation();
	if (!transport) throw new Error("missing provider transport");
	c.provider.fetch.mockImplementation(async (url, options) => {
		if (url === `${cfg.issuer}/token`) {
			entered();
			await continueToken;
		}
		return transport(url, options);
	});
	const before = ownerCallbackAuthority(f);
	// Act
	const winner = c.verifyCallback(c.request());
	await atToken;
	let loser: Awaited<ReturnType<typeof c.verifyCallback>> | undefined;
	try {
		loser = await second.enrollment.verifyCallback(c.request());
	} finally {
		release();
	}
	const result = await winner;
	// Assert
	expect(result.kind).toBe("verified");
	expect(loser).toEqual(unavailable);
	consumed();
	expect(c.provider.requests.filter(({ url }) => url === `${cfg.issuer}/token`)).toHaveLength(1);
	expect(ownerCallbackAuthority(f)).toEqual(before);
});

it.each(["pending-device", "pending-fingerprint", "unresolved", "malformed", "resolved"])(
	"filters only the excluded group for persisted legacy exclusion %s",
	async (fault) => {
		// Arrange: group-a remains active, unarchived and granted despite this legacy decision.
		const c = await claimed();
		const pending = f.rows(ATTEMPTS)[0];
		const fingerprint = fault === "pending-fingerprint" ? pending?.fingerprint : "7".repeat(64);
		if (["resolved", "pending-fingerprint"].includes(fault)) {
			f.db
				.prepare(`INSERT INTO enrolled_devices
 (group_id,device_id,public_key,fingerprint,identity_id,enabled,created_at)
 VALUES ('group-a','unrelated-device',?,?,'other-identity',1,?)`)
				.run(commitPendingKey().publicKey, fingerprint, new Date(NOW).toISOString());
		}
		const decision =
			fault === "malformed"
				? { decision: "excluded" }
				: {
						decision: "excluded",
						device_id: fault === "pending-device" ? "device-a" : "unrelated-device",
						key_fingerprint: fault === "pending-device" ? pending?.fingerprint : fingerprint,
					};
		f.db
			.prepare(
				"INSERT INTO coordinator_legacy_team_completions VALUES ('group-a','candidate-a',1,?,?,?)",
			)
			.run(
				JSON.stringify({ coordinator_id: cfg.coordinatorId, device_decisions: [decision] }),
				new Date(NOW).toISOString(),
				new Date(NOW).toISOString(),
			);
		const before = ownerCallbackAuthority(f);
		// Act: replay must deny regardless of whether the first callback succeeds.
		const result = await c.verifyCallback(c.request());
		const replay = await c.verifyCallback(c.request());
		// Assert: an excluded Team cannot veto another eligible Team's account grant.
		expect(result.kind).toBe("verified");
		expect(f.rows(ATTEMPTS)[0]).toMatchObject({
			state: "oidc_verified",
			account_subject: "fixture-subject",
			identity_id: "identity-a",
			link_id: "link-a",
			confirmation_hash: null,
			completion_secret_hash: null,
		});
		if (fault === "resolved") {
			expect(JSON.parse(f.rows(ATTEMPTS)[0]?.grant_revisions_json as string)).toEqual([
				{ groupId: "group-a", revision: 2 },
				{ groupId: "group-b", revision: 3 },
			]);
		} else {
			expect(JSON.parse(f.rows(ATTEMPTS)[0]?.grant_revisions_json as string)).toEqual([
				{ groupId: "group-b", revision: 3 },
			]);
		}
		expect(f.rows("coordinator_auth_account_links")[0]).toMatchObject({
			link_id: "link-a",
			revoked_at_ms: null,
		});
		noNewEnrollmentAuthority();
		expect(replay).toEqual(unavailable);
		consumed();
		expect(ownerCallbackAuthority(f)).toEqual(before);
		expect(c.provider.requests.filter(({ url }) => url === `${cfg.issuer}/jwks`)).toHaveLength(1);
	},
);

it.each(["excluded", "archived"])(
	"denies when group-a is excluded and the other eligible group is %s",
	async (other) => {
		// Arrange: no eligible group remains after Team-specific filtering.
		const c = await claimed();
		const decision = { decision: "excluded", device_id: "device-a" };
		excludeGroup("group-a", decision);
		if (other === "excluded") excludeGroup("group-b", decision);
		else f.db.exec("UPDATE groups SET archived_at='2026-10-01' WHERE group_id='group-b'");
		const before = ownerCallbackAuthority(f);
		// Act
		const result = await c.verifyCallback(c.request());
		const replay = await c.verifyCallback(c.request());
		// Assert: failure burns the proof without pinning an account or minting authority.
		expect(result).toEqual(unavailable);
		expect(replay).toEqual(unavailable);
		consumed();
		noVerifiedAccount();
		noNewEnrollmentAuthority();
		expect(f.rows(ATTEMPTS)[0]?.state).toBe("browser_claimed");
		expect(ownerCallbackAuthority(f)).toEqual(before);
		expect(c.provider.requests.filter(({ url }) => url === `${cfg.issuer}/token`)).toHaveLength(1);
	},
);

it.each(["insert", "change"])(
	"rejects exclusion %s drift after reading a filtered grant snapshot",
	async (drift) => {
		// Arrange: initially only group-b is eligible; mutate on the independent SQLite connection.
		const c = await claimed();
		const decision = { decision: "excluded", device_id: "device-a" };
		excludeGroup("group-a", decision);
		if (drift === "change") {
			f.db
				.prepare(`INSERT INTO enrolled_devices
 (group_id,device_id,public_key,fingerprint,identity_id,enabled,created_at)
 VALUES ('group-b','unrelated-device',?,'unrelated-fingerprint','other-identity',1,?)`)
				.run(commitPendingKey().publicKey, new Date(NOW).toISOString());
			excludeGroup("group-b", {
				decision: "excluded",
				device_id: "unrelated-device",
				key_fingerprint: "unrelated-fingerprint",
			});
		}
		let injected = false;
		let authorityAfterDrift: unknown[] = [];
		const backend: AuthLinkBackend = {
			...f.backend,
			run: async (statement) => {
				if (statement.sql.includes("SET state = 'oidc_verified'")) {
					expect(statement.values).toContain(JSON.stringify([{ groupId: "group-b", revision: 3 }]));
					if (drift === "insert") excludeGroup("group-b", decision, f.second);
					else {
						f.second
							.prepare(
								"UPDATE coordinator_legacy_team_completions SET manifest_json=? WHERE group_id='group-b'",
							)
							.run(
								JSON.stringify({ coordinator_id: cfg.coordinatorId, device_decisions: [decision] }),
							);
					}
					injected = true;
					authorityAfterDrift = ownerCallbackAuthority(f);
				}
				return f.backend.run(statement);
			},
		};
		const composed = await createCoordinatorOwnerEnrollment({ ...c.options, backend });
		if (!composed.ok) throw new Error("race composition failed");
		// Act
		const result = await composed.enrollment.verifyCallback(c.request());
		const replay = await composed.enrollment.verifyCallback(c.request());
		// Assert: neither the stale group-b pin nor an empty grant list becomes verified authority.
		expect(injected).toBe(true);
		expect(result).toEqual(unavailable);
		expect(replay).toEqual(unavailable);
		consumed();
		noVerifiedAccount();
		noNewEnrollmentAuthority();
		expect(ownerCallbackAuthority(f)).toEqual(authorityAfterDrift);
	},
);

it.each([false, true])(
	"private writer uses filtered callback pins with later eligible-group exclusion=%s",
	async (excludeRemaining) => {
		// Arrange: SDK verification pins only group-b, not the excluded group-a.
		const c = await claimed();
		const decision = { decision: "excluded", device_id: "device-a" };
		excludeGroup("group-a", decision);
		const callback = await c.verifyCallback(c.request());
		expect(callback.kind).toBe("verified");
		if (callback.kind !== "verified") throw new Error("missing filtered callback pins");
		expect(JSON.parse(f.rows(ATTEMPTS)[0]?.grant_revisions_json as string)).toEqual([
			{ groupId: "group-b", revision: 3 },
		]);
		noNewEnrollmentAuthority();
		// Test-only storage transition isolates the writer from the browser handlers.
		const secretBytes = Buffer.alloc(32, 9);
		const completionSecret = secretBytes.toString("base64url");
		f.db
			.prepare(`UPDATE coordinator_owner_enrollment_attempts
 SET state='confirmed',confirmation_hash=?,completion_secret_hash=?`)
			.run(callback.confirmation.confirmationHash, hash(secretBytes));
		const row = f.db.prepare(`SELECT * FROM ${ATTEMPTS}`).get() as OwnerAttempt;
		if (excludeRemaining) excludeGroup("group-b", decision);
		const before = f.snapshot();
		// Act: pending-key proof is real; authority checks and writes use the native atomic batch.
		const result = await commitOwnerEnrollment({
			backend: f.backend,
			row,
			revision: cfg.revision,
			now: NOW,
			completionSecret,
			signature: f.key.sign(commitProofMessage(row, completionSecret)),
		});
		// Assert: unrelated excluded grants do not veto the pin; a newly excluded pin cannot mint.
		expect(result).toBe(!excludeRemaining);
		if (excludeRemaining) {
			expect(f.snapshot()).toEqual(before);
			noNewEnrollmentAuthority();
		} else {
			expect(f.rows("enrolled_devices")).toEqual([
				expect.objectContaining({
					group_id: "group-b",
					device_id: "device-a",
					identity_id: "identity-a",
				}),
			]);
			expect(f.rows("coordinator_device_ownership_bindings")).toHaveLength(1);
			expect(f.rows("coordinator_owner_enrollment_audit_log")).toHaveLength(1);
			expect(f.rows(ATTEMPTS)[0]?.state).toBe("finalized");
		}
		consumed();
	},
);

it.each(
	["revoked-device", "revoked-key", "bound-device", "bound-key"].flatMap((guard) =>
		[false, true].map((matches) => ({ guard, matches })),
	),
)("rechecks after-claim $guard with matching=$matches", async ({ guard, matches }) => {
	// Arrange: the signed start and CSRF claim preceded this new ledger fact.
	const c = await claimed();
	const pending = f.rows(ATTEMPTS)[0];
	const device = matches ? "device-a" : "unrelated-device";
	const key = matches ? pending?.key_id : "c".repeat(64);
	if (guard.startsWith("revoked")) {
		f.db
			.prepare(`INSERT INTO coordinator_device_revocations
 (subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,created_at)
 VALUES (?,?,'revocation-a','group-a','evidence-device','evidence-key','evidence-fingerprint',?)`)
			.run(
				guard === "revoked-device" ? "device_id" : "ed25519_key",
				guard === "revoked-device" ? device : key,
				new Date(NOW).toISOString(),
			);
	} else {
		f.db
			.prepare(`INSERT INTO coordinator_device_ownership_bindings
 (device_id,key_id,identity_id,coordinator_id,binding_id,provenance,source_ref,bound_at)
 VALUES (?,?,'other-identity','other-coordinator','binding-a','reviewed_legacy_migration','receipt-a',?)`)
			.run(
				guard === "bound-device" ? device : "other-device",
				guard === "bound-key" ? key : "d".repeat(64),
				new Date(NOW).toISOString(),
			);
	}
	const before = ownerCallbackAuthority(f);
	// Act
	const result = await c.verifyCallback(c.request());
	// Assert: unrelated facts allow verification; exact canonical key/device collisions deny it.
	if (matches) {
		expect(result).toEqual(unavailable);
		expect(f.rows(ATTEMPTS)[0]?.state).toBe("browser_claimed");
		noVerifiedAccount();
	} else expect(result.kind).toBe("verified");
	consumed();
	expect(ownerCallbackAuthority(f)).toEqual(before);
});

it("consumes only once when both SQLite connections first read pending", async () => {
	// Arrange: hold both transaction SELECT results before either conditional UPDATE can run.
	const c = await claimed();
	const original = f.rows(TRANSACTIONS)[0];
	let release!: () => void;
	const ready = new Promise<void>((resolve) => {
		release = resolve;
	});
	let reads = 0;
	const backends = [f.backend, nativeBackend(f.second)].map(
		(backend): AuthLinkBackend => ({
			...backend,
			first: async <T>(statement: Parameters<AuthLinkBackend["first"]>[0]) => {
				const row = await backend.first<T>(statement);
				if (statement.sql.startsWith(`SELECT * FROM ${TRANSACTIONS}`)) {
					expect(row).toMatchObject({ state: "pending" });
					if (++reads === 2) release();
					await ready;
				}
				return row;
			},
		}),
	);
	const compositions = await Promise.all(
		backends.map((backend) => createCoordinatorOwnerEnrollment({ ...c.options, backend })),
	);
	const before = ownerCallbackAuthority(f);
	// Act
	const results = await Promise.all(
		compositions.map((composed) => {
			if (!composed.ok) throw new Error("race composition failed");
			return composed.enrollment.verifyCallback(c.request());
		}),
	);
	// Assert: the stale reader loses the actual SQL update and never exchanges the code.
	expect(reads).toBe(2);
	expect(results.filter(({ kind }) => kind === "verified")).toHaveLength(1);
	const rejected = results.filter(({ kind }) => kind === "rejected");
	expect(rejected).toEqual([unavailable]);
	for (const secret of [original?.nonce, original?.pkce_verifier]) {
		expect(JSON.stringify(rejected)).not.toContain(secret as string);
	}
	consumed();
	expect(c.provider.requests.filter(({ url }) => url === `${cfg.issuer}/token`)).toHaveLength(1);
	expect(ownerCallbackAuthority(f)).toEqual(before);
});
