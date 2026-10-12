import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import { issueBrowserCookie, readBrowserCookie } from "./coordinator-browser-credential.js";
import { issueBrowserCsrfToken } from "./coordinator-browser-csrf.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import { oidcFixture } from "./coordinator-oidc-test-fixtures.js";
import {
	ATTEMPTS,
	browserForm,
	config,
	hash,
	ORIGIN,
	type OwnerStartFixture,
	ownerStartFixture,
	pairedReadBackends,
	proof,
	TRANSACTIONS,
} from "./coordinator-owner-enrollment-start-test-fixtures.js";
import {
	createCoordinatorOwnerEnrollment,
	type OwnerEnrollmentStart,
	ownerEnrollmentStartMessage,
} from "./owner-enrollment-start.js";

const unavailable = { kind: "rejected", error: "owner_enrollment_unavailable" };
const unknown = { kind: "rejected", error: "owner_enrollment_unknown" };
const pin = {
	coordinatorId: config.coordinatorId,
	origin: ORIGIN,
	issuer: config.issuer,
	revision: config.revision,
};
type Composition = Parameters<typeof createCoordinatorOwnerEnrollment>[0];

let f: OwnerStartFixture;
beforeEach(() => {
	f = ownerStartFixture();
});
afterEach(() => {
	f.close();
	vi.restoreAllMocks();
});

function signed(patch: Partial<OwnerEnrollmentStart> = {}, signingPin = pin) {
	const input = {
		attemptId: "attempt-a",
		deviceId: "device-a",
		publicKey: f.key.publicKey,
		loopbackRedirect: "http://127.0.0.1:43210/codemem/auth/complete",
		browserStartCode: proof(),
		signature: "",
		...patch,
	};
	return { ...input, signature: f.key.sign(ownerEnrollmentStartMessage(input, signingPin)) };
}
async function compose(input = signed(), overrides: Partial<Composition> = {}) {
	const form = await browserForm(input.attemptId, input.browserStartCode);
	const provider = oidcFixture({ issuer: config.issuer });
	const options: Composition = {
		purpose: "owner_enroll",
		mode: "local_test",
		config: { ...config },
		backend: f.backend,
		csrfKey: form.csrfKey,
		limiter: { check: vi.fn(() => ({ allowed: true, retryAfterS: 0 })) },
		oidcOptions: { fetch: provider.fetch },
		clock: () => NOW,
		...overrides,
	};
	const result = await createCoordinatorOwnerEnrollment(options);
	if (!result.ok) throw new Error("fixture composition failed");
	return { ...result.enrollment, form, provider, options, input };
}
async function pending(overrides: Partial<Composition> = {}) {
	const c = await compose(signed(), overrides);
	expect(await c.start(c.input, "transport-a")).toEqual({
		kind: "started",
		attemptId: c.input.attemptId,
		expiresAtMs: NOW + 600000,
	});
	return c;
}

it("stores only a signed, pinned pending attempt with exact text and decoded-code hashes", async () => {
	// Arrange: real Ed25519 proof, including public-key comment bytes.
	const c = await compose(signed({ publicKey: `${f.key.publicKey} fixture-comment` }));
	const before = f.snapshot();
	// Act
	const result = await c.start(c.input, "transport-a");
	// Assert: start grants no account, session, group or ownership authority.
	expect(result).toEqual({ kind: "started", attemptId: "attempt-a", expiresAtMs: NOW + 600000 });
	expect(f.rows(ATTEMPTS)).toEqual([
		expect.objectContaining({
			coordinator_id: config.coordinatorId,
			attempt_id: "attempt-a",
			purpose: "owner_enroll",
			state: "pending",
			origin: ORIGIN,
			device_id: "device-a",
			public_key: c.input.publicKey,
			key_id: await ed25519KeyIdForRevocation(c.input.publicKey),
			fingerprint: hash(c.input.publicKey),
			issuer: config.issuer,
			auth_config_revision: config.revision,
			loopback_redirect: c.input.loopbackRedirect,
			browser_start_hash: hash(Buffer.from(c.input.browserStartCode, "base64url")),
			created_at_ms: NOW,
			expires_at_ms: NOW + 600000,
			browser_transaction_hash: null,
			browser_binder_hash: null,
		}),
	]);
	expect(f.snapshot().slice(1)).toEqual(before.slice(1));
});

it("claims once with SDK state/PKCE and preserves the original cookie binder in both rows", async () => {
	// Arrange
	const c = await pending();
	const before = f.snapshot();
	const original = await readBrowserCookie(c.form.cookie.setCookie.split(";")[0], "start");
	// Act
	const result = await c.claimBrowser(c.form.request(), "browser-a");
	// Assert: initiation exposes only start and claim, never callback/finalize authority.
	expect(result.kind).toBe("browser_claimed");
	if (result.kind !== "browser_claimed" || original.kind !== "present")
		throw new Error("claim failed");
	const url = new URL(result.authorizationUrl);
	const [attempt] = f.rows(ATTEMPTS);
	const [transaction] = f.rows(TRANSACTIONS);
	if (!transaction) throw new Error("missing browser transaction");
	expect(url.origin).toBe(config.issuer);
	expect(Object.fromEntries(url.searchParams)).toMatchObject({
		client_id: config.clientId,
		redirect_uri: config.redirectUri,
		response_type: "code",
		code_challenge_method: "S256",
		prompt: "select_account",
	});
	expect(transaction).toMatchObject({
		purpose: "owner_enroll",
		attempt_id: "attempt-a",
		state: "pending",
		binder_hash: original.cookieHash,
		state_hash: hash(url.searchParams.get("state") as string),
		nonce: url.searchParams.get("nonce"),
		issuer: config.issuer,
		auth_config_revision: config.revision,
		redirect_uri: config.redirectUri,
		created_at_ms: NOW,
		expires_at_ms: NOW + 600000,
	});
	expect(url.searchParams.get("code_challenge")).toBe(
		createHash("sha256")
			.update(transaction.pkce_verifier as string)
			.digest("base64url"),
	);
	expect(attempt).toMatchObject({
		state: "browser_claimed",
		browser_binder_hash: original.cookieHash,
		browser_transaction_hash: transaction.browser_transaction_hash,
	});
	expect(result.setCookies).toHaveLength(2);
	expect(await readBrowserCookie(result.setCookies[0]?.split(";")[0], "transaction")).toMatchObject(
		{
			kind: "present",
			cookieHash: original.cookieHash,
		},
	);
	expect(result.setCookies[0]).toContain("HttpOnly");
	expect(result.setCookies[0]).toContain("Secure");
	expect(result.setCookies[0]).toContain("SameSite=Lax");
	expect(result.setCookies[1]).toContain("__Host-codemem-auth-start=; Max-Age=0");
	expect(f.snapshot().slice(2)).toEqual(before.slice(2));
	expect(c.provider.requests.map((r) => r.url)).toEqual([
		`${config.issuer}/.well-known/openid-configuration`,
	]);
	const factory = await createCoordinatorOwnerEnrollment(c.options);
	expect(factory.ok && Object.keys(factory.enrollment).sort()).toEqual([
		"claimBrowser",
		"confirm",
		"finalize",
		"start",
		"verifyCallback",
	]);
});

it.each([
	["signature", { signature: "A".repeat(86) }],
	["device", { deviceId: "device-b" }],
	["attempt", { attemptId: "attempt-b" }],
	["public text", { publicKey: "invalid" }],
	["redirect", { loopbackRedirect: "http://127.0.0.1:43211/callback" }],
	["commitment", { browserStartCode: Buffer.alloc(32, 5).toString("base64url") }],
])("rejects altered signed %s without writes", async (_name, patch) => {
	// Arrange
	const c = await compose();
	const before = f.snapshot();
	// Act
	const result = await c.start({ ...c.input, ...patch }, "transport-a");
	// Assert
	expect(result).toEqual(unavailable);
	expect(f.snapshot()).toEqual(before);
});

it.each(["coordinatorId", "origin", "issuer", "revision"] as const)(
	"rejects proof signed for another %s",
	async (field) => {
		// Arrange
		const c = await compose(signed({}, { ...pin, [field]: `${pin[field]}-wrong` }));
		const before = f.snapshot();
		// Act
		const result = await c.start(c.input, "transport-a");
		// Assert
		expect(result).toEqual(unavailable);
		expect(f.snapshot()).toEqual(before);
	},
);

it.each([
	{ deviceId: " device-a" },
	{ loopbackRedirect: "https://remote.example.test/callback" },
	{ loopbackRedirect: "http://localhost:43210/callback" },
	{ browserStartCode: Buffer.alloc(31).toString("base64url") },
	{ browserStartCode: Buffer.alloc(33).toString("base64url") },
	{ browserStartCode: `${Buffer.alloc(32).toString("base64url")}=` },
	{ browserStartCode: `${"A".repeat(42)}B` },
])("rejects malformed fields even with a valid signature: %j", async (patch) => {
	// Arrange
	const c = await compose(signed(patch));
	const before = f.snapshot();
	// Act
	const result = await c.start(c.input, "transport-a");
	// Assert
	expect(result).toEqual(unavailable);
	expect(f.snapshot()).toEqual(before);
});

it.each(["csrf", "origin", "cookie", "start_code", "attempt_id", "rate"])(
	"rejects browser %s mismatch without writes",
	async (field) => {
		// Arrange
		const c = await pending();
		const before = f.snapshot();
		const fields = { ...c.form.fields };
		if (["csrf", "start_code", "attempt_id"].includes(field)) fields[field] = proof();
		if (field === "rate")
			vi.mocked(c.options.limiter.check).mockReturnValue({ allowed: false, retryAfterS: 1 });
		const request = c.form.request({
			fields,
			...(field === "origin" ? { origin: "https://evil.example.test" } : {}),
			...(field === "cookie" ? { cookie: "" } : {}),
		});
		// Act
		const result = await c.claimBrowser(request, "browser-a");
		// Assert
		expect(result).toEqual(unavailable);
		expect(f.snapshot()).toEqual(before);
	},
);

it("rejects a valid CSRF token paired with another real start cookie", async () => {
	// Arrange
	const c = await pending();
	const other = await browserForm(c.input.attemptId, c.input.browserStartCode);
	const before = f.snapshot();
	// Act
	const result = await c.claimBrowser(
		c.form.request({ cookie: other.cookie.setCookie.split(";")[0] }),
		"browser-a",
	);
	// Assert
	expect(result).toEqual(unavailable);
	expect(f.snapshot()).toEqual(before);
});

it("keeps an in-progress transaction cookie instead of replacing it with an owner claim", async () => {
	const c = await pending();
	const transaction = await issueBrowserCookie("transaction");
	const before = f.snapshot();
	const cookie = `${c.form.cookie.setCookie.split(";")[0]}; ${transaction.setCookie.split(";")[0]}`;
	expect(await c.claimBrowser(c.form.request({ cookie }), "browser-a")).toEqual(unavailable);
	expect(f.snapshot()).toEqual(before);
});

it.each([NOW - 1, NOW + 600000])(
	"rejects not-yet-created or expired attempt at %i",
	async (time) => {
		// Arrange
		let clock = NOW;
		const c = await pending({ clock: () => clock });
		clock = time;
		const before = f.snapshot();
		// Act
		const result = await c.claimBrowser(c.form.request(), "browser-a");
		// Assert
		expect(result).toEqual(unavailable);
		expect(f.snapshot()).toEqual(before);
	},
);

it("rejects a stored attempt when the server config revision changes", async () => {
	// Arrange
	const c = await pending();
	const changed = await compose(c.input, { config: { ...config, revision: "b".repeat(64) } });
	const csrf = await issueBrowserCsrfToken(
		changed.form.csrfKey,
		changed.form.cookie.secret,
		"start",
		{
			publicOrigin: ORIGIN,
			store: { ...config, revision: "b".repeat(64) },
		},
	);
	const before = f.snapshot();
	// Act
	const result = await changed.claimBrowser(
		changed.form.request({ fields: { ...changed.form.fields, csrf } }),
		"browser-a",
	);
	// Assert
	expect(result).toEqual(unavailable);
	expect(f.snapshot()).toEqual(before);
});

it("denies replay after a successful browser claim", async () => {
	// Arrange
	const c = await pending();
	expect((await c.claimBrowser(c.form.request(), "browser-a")).kind).toBe("browser_claimed");
	const before = f.snapshot();
	// Act
	const result = await c.claimBrowser(c.form.request(), "browser-a");
	// Assert
	expect(result).toEqual(unavailable);
	expect(f.snapshot()).toEqual(before);
});

it.each(["INSERT", "UPDATE"])(
	"rolls back both rows when a trigger suppresses the %s",
	async (operation) => {
		// Arrange: RAISE(IGNORE) creates zero affected rows without throwing itself.
		const c = await pending();
		const before = f.snapshot();
		const table = operation === "INSERT" ? TRANSACTIONS : ATTEMPTS;
		f.db.exec(
			`CREATE TRIGGER suppress_write BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(IGNORE); END`,
		);
		// Act
		const result = await c.claimBrowser(c.form.request(), "browser-a");
		// Assert: no URL or cookie escapes a failed dependent write.
		expect(result).toEqual(unknown);
		expect(f.snapshot()).toEqual(before);
	},
);

it("allows only one simultaneous claim across two SQLite connections", async () => {
	// Arrange: hold both SELECT snapshots until both connections see pending.
	const [firstBackend, secondBackend] = pairedReadBackends(f);
	const c = await pending({ backend: firstBackend });
	const second = await compose(c.input, {
		backend: secondBackend,
		csrfKey: c.form.csrfKey,
	});
	const before = f.snapshot();
	// Act
	const results = await Promise.all([
		c.claimBrowser(c.form.request(), "browser-a"),
		second.claimBrowser(c.form.request(), "browser-b"),
	]);
	// Assert: stale loser rolls back and never returns a second authorization URL.
	expect(results.filter((r) => r.kind === "browser_claimed")).toHaveLength(1);
	expect(results.filter((r) => r.kind === "rejected")).toEqual([unknown]);
	expect(f.rows(TRANSACTIONS)).toHaveLength(1);
	expect(f.rows(ATTEMPTS)[0]).toMatchObject({
		state: "browser_claimed",
		browser_transaction_hash: f.rows(TRANSACTIONS)[0]?.browser_transaction_hash,
	});
	expect(f.snapshot().slice(2)).toEqual(before.slice(2));
});

it.each(["run", "first", "batch"] as const)(
	"contains unexpected database %s errors",
	async (method) => {
		// Arrange
		const c = await pending();
		const before = f.snapshot();
		vi.spyOn(f.backend, method).mockRejectedValue(new Error("database details must not escape"));
		// Act
		const result =
			method === "run"
				? await c.start(signed({ attemptId: "attempt-b" }), "transport-a")
				: await c.claimBrowser(c.form.request(), "browser-a");
		// Assert
		expect(result).toEqual(unknown);
		expect(f.snapshot()).toEqual(before);
	},
);

it.each([
	{ purpose: "link" },
	{ mode: "production" },
	{ config: { ...config, enabled: false } },
	{ oidcOptions: {} },
])("fails closed for unsupported composition %j", async (patch) => {
	// Arrange
	const c = await compose();
	const before = f.snapshot();
	// Act: deliberate malformed runtime input, not a supported API shape.
	const result = await createCoordinatorOwnerEnrollment({
		...c.options,
		...patch,
	} as Composition);
	// Assert
	expect(result).toEqual({ ok: false });
	expect(f.snapshot()).toEqual(before);
});
