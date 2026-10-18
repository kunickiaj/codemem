import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import { issueBrowserCookie } from "./coordinator-browser-credential.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import { oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";
import {
	ownerStartFixture,
	seedOwnerCallbackAuthority,
} from "./coordinator-owner-enrollment-historical-test-fixture.js";
import { createCoordinatorOwnerEnrollmentHttp } from "./coordinator-owner-enrollment-http.js";
import { ownerEnrollmentFinalMessage } from "./coordinator-owner-enrollment-proof.js";
import {
	ATTEMPTS,
	config,
	hash,
	ORIGIN,
	ownerStartTransaction,
	proof,
} from "./coordinator-owner-enrollment-start-test-fixtures.js";
import { ownerEnrollmentStartMessage } from "./owner-enrollment-start.js";

let f: ReturnType<typeof ownerStartFixture>;
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

// Read actual rendered forms; do not supply fixture CSRF or browser credentials.
function fields(html: string) {
	return Object.fromEntries(
		[...html.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2]]),
	);
}
async function fixture() {
	const provider = oidcFixture({ issuer: config.issuer });
	const http = await createCoordinatorOwnerEnrollmentHttp({
		config: { ...config, clientId: PROVIDER.clientId, clientSecret: PROVIDER.clientSecret },
		backend: f.backend,
		oidcOptions: { fetch: provider.fetch },
		clock: () => NOW,
	});
	const send = (path: string, init: RequestInit = {}, client = "socket-a") =>
		http.handle(new Request(`${ORIGIN}${path}`, init), client);
	const post = (path: string, body: unknown) =>
		send(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	const start = {
		attemptId: "attempt-a",
		deviceId: "device-b",
		publicKey: f.key.publicKey,
		loopbackRedirect: "http://127.0.0.1:43210/codemem/auth/complete",
		browserStartCode: proof(),
		signature: "",
	};
	start.signature = f.key.sign(ownerEnrollmentStartMessage(start, http.pin));
	return { http, provider, send, post, start };
}
async function verified(c: Awaited<ReturnType<typeof fixture>>) {
	expect((await c.post("/v1/auth/owner-attempts", c.start)).status).toBe(200);
	const page = await c.send(
		`/auth/owner/start?attempt_id=${c.start.attemptId}&start_code=${c.start.browserStartCode}`,
	);
	const startFields = fields(await page.text());
	const cookie = page.headers.getSetCookie()[0]?.split(";")[0] ?? "";
	const claim = await c.send("/auth/owner/start", {
		method: "POST",
		headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(startFields),
	});
	expect(claim.status).toBe(303);
	const transaction = claim.headers.getSetCookie()[0]?.split(";")[0] ?? "";
	seedOwnerCallbackAuthority(f);
	const callback = await c.http.handle(
		new Request(c.provider.authorize(claim.headers.get("location") ?? ""), {
			headers: { cookie: transaction },
		}),
		"socket-a",
	);
	return { callback, transaction, startFields };
}

it("publishes only authenticated coordinator pins and rejects other origins", async () => {
	// Arrange
	const c = await fixture();
	// Act
	const response = await c.send("/v1/auth/owner-pilot");
	const wrong = await c.http.handle(
		new Request("https://other.example.test/v1/auth/owner-pilot"),
		"socket-a",
	);
	// Assert
	expect(await response.json()).toEqual(c.http.pin);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(wrong.status).toBe(400);
});

it.each(["missing", "expired"] as const)(
	"renders and claims with a %s transaction without clearing it on late GET",
	async (mode) => {
		// Arrange: session credential must not be cleared or replaced by owner start.
		const c = await fixture();
		expect((await c.post("/v1/auth/owner-attempts", c.start)).status).toBe(200);
		const transaction = await ownerStartTransaction(f, mode);
		const session = await issueBrowserCookie("session");
		const existing = `${transaction}; ${session.setCookie.split(";")[0]}`;
		const path = `/auth/owner/start?attempt_id=${c.start.attemptId}&start_code=${c.start.browserStartCode}`;
		const before = f.snapshot();
		// Act
		const page = await c.send(path, { headers: { cookie: existing } });
		// Assert: GET issues only start CSRF state, never a transaction/session deletion.
		expect(page.status).toBe(200);
		expect(f.snapshot()).toEqual(before);
		expect(page.headers.getSetCookie()).toHaveLength(1);
		expect(page.headers.getSetCookie()[0]).toMatch(/^__Host-codemem-auth-start=/);
		const form = fields(await page.text());
		const startCookie = page.headers.getSetCookie()[0]?.split(";")[0];
		// Act: a valid proof and actual rendered CSRF form are still required.
		const claim = await c.send("/auth/owner/start", {
			method: "POST",
			headers: {
				cookie: `${existing}; ${startCookie}`,
				origin: ORIGIN,
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams(form),
		});
		const late = await c.send(path, { headers: { cookie: existing } });
		// Assert: only the committed POST replaces the transaction; late GET cannot erase it.
		expect(claim.status).toBe(303);
		expect(claim.headers.getSetCookie()).toHaveLength(2);
		expect(claim.headers.getSetCookie()[0]).toMatch(/^__Host-codemem-auth-transaction=/);
		expect(
			claim.headers.getSetCookie().some((value) => value.startsWith("__Host-codemem-session=")),
		).toBe(false);
		expect(late.status).toBe(200);
		expect(
			late.headers.getSetCookie().every((value) => value.startsWith("__Host-codemem-auth-start=")),
		).toBe(true);
		expect(f.rows("coordinator_auth_sessions")).toEqual(before[8]);
		expect(f.rows("coordinator_device_ownership_bindings")).toEqual([]);
	},
);

it.each(["signin", "link", "owner_enroll", "drift", "malformed", "read-fault"] as const)(
	"denies %s transaction on GET and independently valid POST without writes",
	async (mode) => {
		// Arrange: get a valid form before adding the conflicting transaction credential.
		const c = await fixture();
		expect((await c.post("/v1/auth/owner-attempts", c.start)).status).toBe(200);
		const path = `/auth/owner/start?attempt_id=${c.start.attemptId}&start_code=${c.start.browserStartCode}`;
		const valid = await c.send(path);
		const body = fields(await valid.text());
		const transaction =
			mode === "malformed"
				? "__Host-codemem-auth-transaction=invalid"
				: await ownerStartTransaction(f, mode === "read-fault" ? "missing" : mode);
		const cookie = `${valid.headers.getSetCookie()[0]?.split(";")[0]}; ${transaction}`;
		const before = f.snapshot();
		if (mode === "read-fault") {
			const first = f.backend.first.bind(f.backend);
			vi.spyOn(f.backend, "first").mockImplementation((statement) => {
				if (statement.sql.includes("AS activity")) {
					return Promise.reject(new Error("activity read failed"));
				}
				return first(statement);
			});
		}
		// Act
		const page = await c.send(path, { headers: { cookie } });
		const claim = await c.send("/auth/owner/start", {
			method: "POST",
			headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(body),
		});
		// Assert
		for (const response of [page, claim]) {
			expect(response.status).toBeGreaterThanOrEqual(400);
			expect(response.headers.getSetCookie()).toEqual([]);
			expect(response.headers.get("location")).toBeNull();
		}
		expect(f.snapshot()).toEqual(before);
	},
);

it("uses genuine SDK forms then redirects only to signed loopback and returns row identity", async () => {
	// Arrange
	const c = await fixture();
	const { callback, transaction } = await verified(c);
	const html = await callback.text();
	const form = fields(html);
	expect(callback.status).toBe(200);
	expect(html).toContain("identity-a");
	expect(html).not.toContain("completionSecret");
	// Act
	const confirmed = await c.send("/auth/owner/confirm", {
		method: "POST",
		headers: {
			cookie: transaction,
			origin: ORIGIN,
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams(form),
	});
	const destination = new URL(confirmed.headers.get("location") ?? "");
	const completionSecret = destination.searchParams.get("completion") ?? "";
	const signed = {
		coordinator_id: config.coordinatorId,
		origin: ORIGIN,
		auth_config_revision: config.revision,
		attempt_id: c.start.attemptId,
		device_id: c.start.deviceId,
		public_key: c.start.publicKey,
		key_id: await ed25519KeyId(c.start.publicKey),
		fingerprint: hash(c.start.publicKey),
		issuer: config.issuer,
		confirmation_hash: destination.searchParams.get("confirmation"),
	};
	const input = {
		attemptId: c.start.attemptId,
		completionSecret,
		signature: f.key.sign(ownerEnrollmentFinalMessage(signed, completionSecret)),
	};
	const final = await (await c.post("/v1/auth/owner-attempts/finalize", input)).json();
	const retry = await (await c.post("/v1/auth/owner-attempts/finalize", input)).json();
	// Assert: no completion HTML or identity supplied by B, and old receipt remains exact.
	expect(confirmed.status).toBe(303);
	expect(await confirmed.text()).toBe("");
	expect(destination.origin + destination.pathname).toBe(c.start.loopbackRedirect);
	expect([...destination.searchParams.keys()].sort()).toEqual([
		"attempt_id",
		"completion",
		"confirmation",
	]);
	expect(confirmed.headers.get("referrer-policy")).toBe("no-referrer");
	const row = f.rows(ATTEMPTS)[0];
	expect(final).toEqual({
		kind: "finalized",
		bindingId: row?.binding_id,
		identityId: row?.identity_id,
		groups: ["group-a", "group-b"],
	});
	expect(retry).toEqual({ ...final, kind: "prior_commit" });
	expect(JSON.parse(row?.final_outcome_json as string)).toEqual({
		kind: final.kind,
		bindingId: final.bindingId,
		groups: final.groups,
	});
	expect(f.rows("coordinator_owner_enrollment_audit_log")).toHaveLength(1);
	expect(c.provider.requests.some(({ url }) => url.endsWith("/jwks"))).toBe(true);
});

it.each(["origin", "cookie", "csrf", "commitment", "duplicate", "extra"])(
	"rejects %s on the actual confirmation form without authority writes",
	async (fault) => {
		// Arrange
		const c = await fixture();
		const { callback, transaction } = await verified(c);
		const form = fields(await callback.text());
		const body = new URLSearchParams(form);
		if (fault === "csrf") body.set("csrf", proof());
		if (fault === "commitment") body.set("confirmation_hash", "f".repeat(64));
		if (fault === "duplicate") body.append("confirmation_hash", form.confirmation_hash ?? "");
		if (fault === "extra")
			body.set("loopback_redirect", "http://127.0.0.1:12345/codemem/auth/complete");
		const before = f.snapshot();
		// Act
		const response = await c.send("/auth/owner/confirm", {
			method: "POST",
			headers: {
				cookie: fault === "cookie" ? "" : transaction,
				origin: fault === "origin" ? "https://other.example.test" : ORIGIN,
				"content-type": "application/x-www-form-urlencoded",
			},
			body,
		});
		// Assert
		expect(response.status).toBe(400);
		expect(response.headers.get("location")).toBeNull();
		expect(f.snapshot()).toEqual(before);
	},
);

it.each(["account", "signature"])(
	"rejects provider %s through actual SDK callback",
	async (fault) => {
		// Arrange
		const c = await fixture();
		if (fault === "account") c.provider.claims.sub = "unlinked-subject";
		else c.provider.settings.signature = "wrong-key";
		// Act
		const { callback } = await verified(c);
		// Assert
		expect(callback.status).toBe(400);
		expect(f.rows("coordinator_device_ownership_bindings")).toEqual([]);
	},
);

it.each(["malformed", "array", "extra", "oversize", "content-type", "method", "query"])(
	"rejects %s transport before creating an attempt",
	async (fault) => {
		// Arrange
		const c = await fixture();
		let body = JSON.stringify(c.start);
		if (fault === "malformed") body = "{";
		if (fault === "array") body = "[]";
		if (fault === "extra") body = JSON.stringify({ ...c.start, identityId: "injected" });
		if (fault === "oversize") body = "x".repeat(16385);
		const before = f.snapshot();
		// Act
		const response = await c.send(`/v1/auth/owner-attempts${fault === "query" ? "?x=y" : ""}`, {
			method: fault === "method" ? "PUT" : "POST",
			headers: { "content-type": fault === "content-type" ? "text/plain" : "application/json" },
			body,
		});
		// Assert
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(f.snapshot()).toEqual(before);
	},
);

it("limits by trusted socket key despite spoofed forwarding headers", async () => {
	// Arrange
	const c = await fixture();
	// Act
	const responses = [];
	for (let i = 0; i < 61; i++)
		responses.push(
			await c.send("/v1/auth/owner-pilot", { headers: { "x-forwarded-for": `fake-${i}` } }),
		);
	const other = await c.send("/v1/auth/owner-pilot", {}, "socket-b");
	// Assert
	expect(responses[0]?.status).toBe(200);
	expect(responses[60]?.status).toBe(429);
	expect(other.status).toBe(200);
});
