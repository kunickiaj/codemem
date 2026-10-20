import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import { AuthSessionOperations } from "./coordinator-auth-session.js";
import { issueBrowserCookie } from "./coordinator-browser-credential.js";
import { importBrowserCsrfKey } from "./coordinator-browser-csrf.js";
import { oidcFixture } from "./coordinator-oidc-test-fixtures.js";
import { commitPendingKey } from "./coordinator-owner-enrollment-commit-test-fixtures.js";
import {
	ownerStartFixture,
	seedOwnerCallbackAuthority,
} from "./coordinator-owner-enrollment-historical-test-fixture.js";
import {
	ATTEMPTS,
	config,
	ORIGIN,
	ownerStartTransaction,
	proof,
} from "./coordinator-owner-enrollment-start-test-fixtures.js";
import {
	createOwnerBrowserAdmissionHandler,
	OWNER_BROWSER_ADMISSION_PATH,
	type OwnerBrowserAdmissionOptions,
} from "./owner-browser-admission.js";
import { OWNER_ADMISSION_BODY_MAX_BYTES } from "./owner-browser-admission-body.js";
import { importOwnerEnrollmentAdmissionKey } from "./owner-enrollment-admission.js";
import {
	createCoordinatorOwnerEnrollment,
	ownerEnrollmentHash,
	ownerEnrollmentStartMessage,
} from "./owner-enrollment-start.js";

let f: ReturnType<typeof ownerStartFixture>;
beforeEach(() => {
	f = ownerStartFixture();
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Live network forbidden"));
});
afterEach(() => {
	try {
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		f.close();
		vi.restoreAllMocks();
	}
});
function fields(html: string) {
	return Object.fromEntries(
		[...html.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2]]),
	);
}
async function fixture(overrides: Partial<OwnerBrowserAdmissionOptions> = {}) {
	seedOwnerCallbackAuthority(f);
	const session = await issueBrowserCookie("session");
	f.db
		.prepare(`INSERT INTO coordinator_auth_sessions
 (coordinator_id,session_id,credential_hash,browser_transaction_hash,link_id,identity_id,
 issuer,subject,auth_config_revision,created_at_ms,expires_at_ms)
 VALUES (?,?,?,?,'link-a','identity-a',?,'fixture-subject',?,?,?)`)
		.run(
			config.coordinatorId,
			"session-a",
			session.cookieHash,
			"d".repeat(64),
			config.issuer,
			config.revision,
			NOW - 500,
			NOW - 500 + 28800000,
		);
	const csrfKey = await importBrowserCsrfKey(new Uint8Array(32).fill(17));
	const admissionKey = await importOwnerEnrollmentAdmissionKey(new Uint8Array(32).fill(23));
	const provider = oidcFixture({ issuer: config.issuer });
	const composition = vi.fn(async () => {
		const result = await createCoordinatorOwnerEnrollment({
			purpose: "owner_enroll",
			mode: "production",
			config,
			backend: f.backend,
			csrfKey,
			admissionKey,
			limiter: { check: () => ({ allowed: true, retryAfterS: 0 }) },
			oidcOptions: { fetch: provider.fetch },
			clock: () => NOW,
		});
		if (!result.ok) throw new Error("Fixture composition failed");
		return { ...result.enrollment, startOwnerBound: vi.fn(result.enrollment.startOwnerBound) };
	});
	const sessions = new AuthSessionOperations(f.backend, () => NOW);
	const options: OwnerBrowserAdmissionOptions = {
		enabled: true,
		config,
		backend: f.backend,
		csrfKey,
		admissionKey,
		limiter: { check: vi.fn(() => ({ allowed: true, retryAfterS: 0 })) },
		readSession: sessions.readAuthSession.bind(sessions),
		clock: () => NOW,
		getEnrollment: composition,
		...overrides,
	};
	const handle = createOwnerBrowserAdmissionHandler(options);
	const cookie = session.setCookie.split(";")[0] ?? "";
	const start = {
		attemptId: "attempt-a",
		deviceId: "new-device",
		publicKey: f.key.publicKey,
		loopbackRedirect: "http://127.0.0.1:43210/codemem/auth/complete",
		browserStartCode: proof(),
		signature: "",
	};
	start.signature = f.key.sign(ownerEnrollmentStartMessage(start, { ...config, origin: ORIGIN }));
	const send = async (
		init: RequestInit = {},
		client = "socket-a",
		path = OWNER_BROWSER_ADMISSION_PATH,
	) => {
		const response = await handle(
			new Request(`${ORIGIN}${path}`, {
				...init,
				headers: { cookie, ...Object.fromEntries(new Headers(init.headers)) },
			}),
			client,
		);
		if (!response) throw new Error("Unexpected unhandled request");
		return response;
	};
	const upload = (
		csrf: string,
		raw: string | Uint8Array<ArrayBuffer> = JSON.stringify({ start }),
	) => {
		const form = new FormData();
		form.append("csrf", csrf);
		form.append(
			"request",
			new File([raw], "capability-request.json", { type: "application/json" }),
		);
		return form;
	};
	const page = async () => fields(await (await send()).text()).csrf ?? "";
	const post = (body: BodyInit, headers: Record<string, string> = {}) =>
		send({ method: "POST", headers: { origin: ORIGIN, ...headers }, body });
	return {
		options,
		handle,
		send,
		post,
		page,
		upload,
		start,
		composition,
		provider,
		cookie,
		session,
	};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function deniedWithoutEffects(c: Fixture, act: () => Promise<Response>, status = 400) {
	const before = f.snapshot();
	const run = vi.spyOn(f.backend, "run");
	const batch = vi.spyOn(f.backend, "batch");
	const response = await act();
	expect(response.status).toBe(status);
	expect(response.headers.getSetCookie()).toEqual([]);
	expect(response.headers.get("location")).toBeNull();
	expect(await response.text()).not.toContain(c.start.publicKey);
	expect(c.composition).not.toHaveBeenCalled();
	expect(c.provider.fetch).not.toHaveBeenCalled();
	expect(run).not.toHaveBeenCalled();
	expect(batch).not.toHaveBeenCalled();
	expect(f.snapshot()).toEqual(before);
}

it("admits an exact signed upload through real V2 start, exposes only the existing confirmation form", async () => {
	// Arrange: session authority must not itself finish enrollment or create grants.
	const c = await fixture();
	const before = f.snapshot();
	// Act
	const page = await c.send();
	const pageHtml = await page.text();
	const response = await c.post(c.upload(fields(pageHtml).csrf ?? ""));
	const html = await response.text();
	const attempt = f.rows(ATTEMPTS)[0];
	// Assert: only one pending, owner-pinned attempt and start cookie exist.
	expect(page.status).toBe(200);
	expect(pageHtml).toContain('enctype="multipart/form-data"');
	expect(pageHtml).toContain("not that the key belongs to this computer");
	expect(page.headers.getSetCookie()).toEqual([]);
	expect(response.status).toBe(200);
	expect(html).toContain('action="/auth/owner/start"');
	expect(html).toContain(c.start.deviceId);
	expect(html).toContain(await ownerEnrollmentHash(c.start.publicKey));
	expect(attempt).toMatchObject({
		state: "pending",
		identity_id: null,
		link_id: null,
		admission_owner_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
	});
	expect(f.snapshot().slice(1)).toEqual(before.slice(1));
	expect(c.composition).toHaveBeenCalledTimes(1);
	expect(response.headers.getSetCookie()).toHaveLength(1);
	expect(response.headers.getSetCookie()[0]).toMatch(/^__Host-codemem-auth-start=/);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.get("referrer-policy")).toBe("no-referrer");
	expect(page.headers.get("content-security-policy")).toContain("form-action 'self'");
	expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
	const api = await c.composition.mock.results[0]?.value;
	const admission = api?.startOwnerBound.mock.calls[0]?.[2];
	expect(admission?.sessionCookieHash).toBe(c.session.cookieHash);
	expect(admission?.admissionToken).toMatch(/^v2\./);
	for (const secret of [
		c.cookie.split("=")[1] ?? "missing-session",
		admission?.admissionToken ?? "missing-admission",
		c.start.signature,
		c.start.publicKey,
		config.clientSecret,
		"admissionToken",
		"resolvedOwner",
		"fixture-subject",
		"identity-a",
		"link-a",
	]) {
		expect(`${html}${JSON.stringify([...response.headers])}`).not.toContain(secret);
	}
	// Act: the shared form still initiates a fresh owner-purpose OIDC transaction.
	const claim = await api?.claimBrowser(
		new Request(`${ORIGIN}/auth/owner/start`, {
			method: "POST",
			headers: { origin: ORIGIN, cookie: response.headers.getSetCookie()[0]?.split(";")[0] ?? "" },
			body: new URLSearchParams(fields(html)),
		}),
		"socket-a",
	);
	// Assert
	expect(claim?.kind).toBe("browser_claimed");
	expect(f.rows(ATTEMPTS)[0]).toMatchObject({ state: "browser_claimed", identity_id: null });
	expect(
		f
			.rows("coordinator_auth_browser_transactions")
			.find((row) => row.attempt_id === c.start.attemptId),
	).toMatchObject({
		purpose: "owner_enroll",
	});
});

it.each([
	["unknown", "DELETE FROM coordinator_auth_sessions"],
	["revoked", `UPDATE coordinator_auth_sessions SET revoked_at_ms=${NOW}`],
	[
		"expired",
		`UPDATE coordinator_auth_sessions SET created_at_ms=${NOW - 28800000},expires_at_ms=${NOW}`,
	],
	[
		"future",
		`UPDATE coordinator_auth_sessions SET created_at_ms=${NOW + 1},expires_at_ms=${NOW + 1 + 28800000}`,
	],
	["revision", `UPDATE coordinator_auth_sessions SET auth_config_revision='${"b".repeat(64)}'`],
	["link mismatch", "UPDATE coordinator_auth_sessions SET subject='other-subject'"],
	["revoked link", `UPDATE coordinator_auth_account_links SET revoked_at_ms=${NOW}`],
	["no grants", "DELETE FROM coordinator_identity_group_grants"],
	["archived grants", "UPDATE groups SET archived_at='2026-01-01'"],
	["partial 0034", "DROP TRIGGER owner_enrollment_admission_update"],
] as const)(
	"denies %s authority on GET and POST before lazy composition or writes",
	async (_name, sql) => {
		// Arrange: obtain authentic CSRF before removing authority.
		const c = await fixture();
		const form = c.upload(await c.page());
		f.db.exec(sql);
		// Act / Assert
		const status = _name === "partial 0034" ? 400 : 403;
		await deniedWithoutEffects(c, () => c.send(), status);
		await deniedWithoutEffects(c, () => c.post(form), status);
	},
);

it("rejects a genuine device-claim account even with independent trusted grants", async () => {
	// Arrange
	f.close();
	f = ownerStartFixture({ authority: "device_claim" });
	const c = await fixture();
	// Act / Assert
	await deniedWithoutEffects(c, () => c.send(), 403);
	await deniedWithoutEffects(c, () => c.post(c.upload("irrelevant")), 403);
});

it.each(["session", "link", "grant"] as const)(
	"rechecks %s revocation at the winning INSERT",
	async (mode) => {
		// Arrange: mutate on the separate SQLite connection after all admission reads.
		const c = await fixture();
		const form = c.upload(await c.page());
		const run = f.backend.run.bind(f.backend);
		let raced = false;
		vi.spyOn(f.backend, "run").mockImplementation(async (statement) => {
			if (statement.sql.includes(`INSERT INTO ${ATTEMPTS}`)) {
				raced = true;
				const sql = {
					session: `UPDATE coordinator_auth_sessions SET revoked_at_ms=${NOW}`,
					link: `UPDATE coordinator_auth_account_links SET revoked_at_ms=${NOW}`,
					grant:
						"UPDATE coordinator_identity_group_grants SET status='revoked',revoked_at='2026-01-01'",
				}[mode];
				f.second.exec(sql);
			}
			return run(statement);
		});
		const before = f.snapshot().slice(0, 7);
		// Act
		const response = await c.post(form);
		// Assert: the authority mutation persists but no enrollment/ownership write wins.
		expect(raced).toBe(true);
		expect(response.status).toBe(400);
		expect(response.headers.getSetCookie()).toEqual([]);
		expect(f.rows(ATTEMPTS)).toEqual([]);
		expect(f.snapshot().slice(0, 5)).toEqual(before.slice(0, 5));
		expect(f.rows("coordinator_owner_enrollment_audit_log")).toEqual([]);
	},
);

it.each(["missing", "malformed", "duplicate"] as const)(
	"denies %s session credentials",
	async (mode) => {
		// Arrange
		const c = await fixture();
		const cookie = {
			missing: "",
			malformed: "__Host-codemem-session=invalid",
			duplicate: `${c.cookie}; ${c.cookie}`,
		}[mode];
		// Act / Assert
		await deniedWithoutEffects(c, () => c.send({ headers: { cookie } }), 403);
	},
);

it.each(["signin", "link", "owner_enroll", "malformed"] as const)(
	"denies an existing %s transaction",
	async (mode) => {
		// Arrange
		const c = await fixture();
		const form = c.upload(await c.page());
		const transaction =
			mode === "malformed"
				? "__Host-codemem-auth-transaction=invalid"
				: await ownerStartTransaction(f, mode);
		const headers = { cookie: `${c.cookie}; ${transaction}` };
		// Act / Assert
		await deniedWithoutEffects(c, () => c.send({ headers }), mode === "malformed" ? 403 : 400);
		await deniedWithoutEffects(
			c,
			() => c.send({ method: "POST", headers: { ...headers, origin: ORIGIN }, body: form }),
			mode === "malformed" ? 403 : 400,
		);
	},
);

it.each(["disabled", "config", "invalid-csrf-key", "invalid-admission-key"] as const)(
	"fails closed for %s settings without database reads",
	async (mode) => {
		// Arrange
		const changes = {
			disabled: { enabled: false },
			config: { config: { ...config, enabled: false } },
			"invalid-csrf-key": { csrfKey: {} },
			"invalid-admission-key": { admissionKey: {} },
		}[mode];
		const c = await fixture(changes as Partial<OwnerBrowserAdmissionOptions>);
		const first = vi.spyOn(f.backend, "first");
		// Act / Assert
		await deniedWithoutEffects(c, () => c.send(), 404);
		expect(first).not.toHaveBeenCalled();
	},
);

it("leaves unrelated routes unhandled and refuses callback collision", async () => {
	// Arrange
	const c = await fixture();
	const first = vi.spyOn(f.backend, "first");
	// Act
	const other = await c.handle(new Request(`${ORIGIN}/auth/sign-in`), "socket-a");
	// Assert
	expect(other).toBeNull();
	expect(first).not.toHaveBeenCalled();
	expect(() =>
		createOwnerBrowserAdmissionHandler({
			...c.options,
			config: { ...config, redirectUri: `${ORIGIN}${OWNER_BROWSER_ADMISSION_PATH}` },
		}),
	).toThrow("owner_admission_callback_collision");
});

it.each([
	"foreign-origin",
	"missing-origin",
	"query",
	"fragment",
	"wrong-method",
	"invalid-client",
	"long-client",
] as const)("rejects %s before database or body reads", async (mode) => {
	// Arrange
	const c = await fixture();
	const body = c.upload("not-read");
	const first = vi.spyOn(f.backend, "first");
	let path = OWNER_BROWSER_ADMISSION_PATH;
	if (mode === "query") path += "?unexpected=1";
	if (mode === "fragment") path += "#unexpected";
	const headers: Record<string, string> = {};
	if (mode !== "missing-origin") headers.origin = ORIGIN;
	if (mode === "foreign-origin") headers.origin = "https://other.example.test";
	let client = "socket-a";
	if (mode === "invalid-client") client = " invalid-client";
	if (mode === "long-client") client = "a".repeat(129);
	const method = mode === "wrong-method" ? "PUT" : "POST";
	// Act / Assert
	await deniedWithoutEffects(
		c,
		() => c.send({ method, headers, body }, client, path),
		method === "PUT" ? 405 : 400,
	);
	expect(first).not.toHaveBeenCalled();
});

it.each(["client", "identity"] as const)(
	"enforces trusted %s quota before consuming upload",
	async (mode) => {
		// Arrange
		const c = await fixture();
		const check = vi.fn((key: string) => ({
			allowed: !key.includes(`owner-admit-${mode}`),
			retryAfterS: 1,
		}));
		c.options.limiter.check = check;
		const request = new Request(`${ORIGIN}${OWNER_BROWSER_ADMISSION_PATH}`, {
			method: "POST",
			headers: { cookie: c.cookie, origin: ORIGIN, "x-forwarded-for": "untrusted" },
			body: "unread",
		});
		// Act / Assert
		await deniedWithoutEffects(
			c,
			async () => {
				const response = await c.handle(request, "socket-a");
				if (!response) throw new Error("Unhandled");
				return response;
			},
			429,
		);
		expect(request.bodyUsed).toBe(false);
		expect(check.mock.calls).toContainEqual([
			JSON.stringify(["owner-admit-client", config.coordinatorId, "socket-a"]),
			20,
		]);
		if (mode === "identity")
			expect(check.mock.calls).toContainEqual([
				JSON.stringify(["owner-admit-identity", config.coordinatorId, "identity-a"]),
				10,
			]);
	},
);

it.each([
	"bad-csrf",
	"duplicate-csrf",
	"duplicate-file",
	"unknown-field",
	"string-file",
	"csrf-file",
	"bad-json",
	"duplicate-json",
	"escaped-duplicate",
	"unknown-json",
	"missing-json",
	"nested-json",
	"invalid-utf8",
] as const)("rejects %s upload without composition or writes", async (mode) => {
	// Arrange
	const c = await fixture();
	let raw: string | Uint8Array<ArrayBuffer> = JSON.stringify({ start: c.start });
	if (mode === "bad-json") raw = "{";
	if (mode === "duplicate-json") raw = raw.replace('"deviceId":', '"deviceId":"other","deviceId":');
	if (mode === "escaped-duplicate")
		raw = raw.replace('"deviceId":', '"device\\u0049d":"other","deviceId":');
	if (mode === "unknown-json") raw = JSON.stringify({ start: { ...c.start, extra: "value" } });
	if (mode === "missing-json")
		raw = JSON.stringify({ start: { ...c.start, signature: undefined } });
	if (mode === "nested-json") raw = JSON.stringify({ start: { ...c.start, deviceId: {} } });
	if (mode === "invalid-utf8") raw = new Uint8Array([0xc3, 0x28]);
	const body = c.upload(await c.page(), raw);
	if (mode === "bad-csrf") body.set("csrf", "invalid");
	if (mode === "duplicate-csrf") body.append("csrf", "extra");
	if (mode === "duplicate-file") body.append("request", new File([raw], "second.json"));
	if (mode === "unknown-field") body.append("unknown", "extra");
	if (mode === "string-file") body.set("request", raw as string);
	if (mode === "csrf-file") body.set("csrf", new File(["csrf"], "csrf"));
	// Act / Assert
	await deniedWithoutEffects(c, () => c.post(body));
});

it.each(["malformed", "invalid-ed25519", "other-key"] as const)(
	"rejects invalid pending-key proof before composition or writes (%s)",
	async (mode) => {
		// Arrange: keep the real pending public key and signed tuple; vary only the proof.
		const c = await fixture();
		let signature = "invalid";
		if (mode === "invalid-ed25519") signature = Buffer.alloc(64, 0xff).toString("base64url");
		if (mode === "other-key")
			signature = commitPendingKey().sign(
				ownerEnrollmentStartMessage(c.start, { ...config, origin: ORIGIN }),
			);
		const body = c.upload(await c.page(), JSON.stringify({ start: { ...c.start, signature } }));
		const before = f.snapshot();
		const run = vi.spyOn(f.backend, "run");
		const batch = vi.spyOn(f.backend, "batch");
		// Act
		const response = await c.post(body);
		// Assert: canonical 64-byte proofs must fail cryptographic verification, not just parsing.
		if (mode !== "malformed") {
			expect(Buffer.from(signature, "base64url")).toHaveLength(64);
			expect(Buffer.from(signature, "base64url").toString("base64url")).toBe(signature);
			expect(signature).not.toBe(c.start.signature);
		}
		expect(response.status).toBe(400);
		expect(run).not.toHaveBeenCalled();
		expect(batch).not.toHaveBeenCalled();
		expect(f.snapshot()).toEqual(before);
		expect(c.composition).not.toHaveBeenCalled();
		expect(c.provider.fetch).not.toHaveBeenCalled();
	},
);

it.each([
	"oversize-stream",
	"oversize-declared",
	"negative-length",
	"invalid-length",
	"oversize-file",
	"wrong-type",
] as const)("rejects %s body", async (mode) => {
	// Arrange
	const c = await fixture();
	const csrf = await c.page();
	const headers: Record<string, string> = {};
	let body: BodyInit = c.upload(csrf);
	if (mode === "oversize-stream" || mode === "oversize-file")
		body = c.upload(csrf, "x".repeat(OWNER_ADMISSION_BODY_MAX_BYTES + 1));
	if (mode === "oversize-declared")
		headers["content-length"] = String(OWNER_ADMISSION_BODY_MAX_BYTES + 1);
	if (mode === "negative-length") headers["content-length"] = "-1";
	if (mode === "invalid-length") headers["content-length"] = "1e3";
	if (mode === "wrong-type") {
		body = JSON.stringify({ start: c.start });
		headers["content-type"] = "application/json";
	}
	// Act / Assert
	await deniedWithoutEffects(c, () => c.post(body, headers));
});

it.each(["exact", "overflow", "lying-length", "read-error"] as const)(
	"handles %s chunked upload at the whole-body limit",
	async (mode) => {
		// Arrange: valid multipart, padded with an epilogue to test the byte limit itself.
		const c = await fixture();
		const encoded = new Request(`${ORIGIN}${OWNER_BROWSER_ADMISSION_PATH}`, {
			method: "POST",
			body: c.upload(await c.page()),
		});
		const multipart = new Uint8Array(await encoded.arrayBuffer());
		const bytes = new Uint8Array(
			OWNER_ADMISSION_BODY_MAX_BYTES + (mode === "overflow" || mode === "lying-length" ? 1 : 0),
		).fill(32);
		bytes.set(multipart);
		const cancel = vi.fn();
		let chunk = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (mode === "read-error") {
					controller.error(new Error("Upload interrupted"));
					return;
				}
				if (chunk === 0) controller.enqueue(bytes.subarray(0, 8192));
				else if (chunk === 1) controller.enqueue(bytes.subarray(8192));
				else if (mode === "exact") controller.close();
				chunk++;
			},
			cancel,
		});
		const headers = new Headers({
			cookie: c.cookie,
			origin: ORIGIN,
			"content-type": encoded.headers.get("content-type") ?? "",
		});
		if (mode === "lying-length") headers.set("content-length", "1");
		const request = new Request(encoded.url, {
			method: "POST",
			headers,
			body,
			duplex: "half",
		} as RequestInit);
		const before = f.snapshot();
		// Act
		const response = await c.handle(request, "socket-a");
		// Assert: observed bytes, not Content-Length, decide whether a write is allowed.
		expect(response?.status).toBe(mode === "exact" ? 200 : 400);
		if (mode === "exact") expect(f.rows(ATTEMPTS)).toHaveLength(1);
		else {
			expect(f.snapshot()).toEqual(before);
			expect(c.composition).not.toHaveBeenCalled();
		}
		if (mode === "overflow" || mode === "lying-length") expect(cancel).toHaveBeenCalledTimes(1);
	},
);
