import type { CustomFetch } from "openid-client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import { importBrowserCsrfKey } from "./coordinator-browser-csrf.js";
import { oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";
import { commitPendingKey } from "./coordinator-owner-enrollment-commit-test-fixtures.js";
import {
	ownerStartFixture,
	seedOwnerCallbackAuthority,
} from "./coordinator-owner-enrollment-historical-test-fixture.js";
import { createCoordinatorOwnerEnrollmentHttp } from "./coordinator-owner-enrollment-http.js";
import {
	ATTEMPTS,
	config,
	ORIGIN,
	proof,
} from "./coordinator-owner-enrollment-start-test-fixtures.js";
import {
	importOwnerEnrollmentAdmissionKey,
	issueOwnerEnrollmentAdmission,
	verifyOwnerEnrollmentAdmission,
} from "./owner-enrollment-admission.js";
import {
	createCoordinatorOwnerEnrollment,
	ownerEnrollmentStartMessage,
} from "./owner-enrollment-start.js";
import { createInMemoryRequestRateLimiter } from "./request-rate-limit.js";

let f: ReturnType<typeof ownerStartFixture>;
beforeEach(() => {
	f = ownerStartFixture();
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("live network forbidden"));
});
afterEach(() => {
	try {
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		f.close();
		vi.useRealTimers();
		vi.restoreAllMocks();
	}
});
const pin = {
	coordinatorId: config.coordinatorId,
	origin: ORIGIN,
	issuer: config.issuer,
	revision: config.revision,
};
async function fixture() {
	const key = await importOwnerEnrollmentAdmissionKey(new Uint8Array(32).fill(23));
	const start = {
		attemptId: "attempt-a",
		deviceId: "device-a",
		publicKey: f.key.publicKey,
		loopbackRedirect: "http://127.0.0.1:43210/codemem/auth/complete",
		browserStartCode: proof(),
		signature: "",
	};
	start.signature = f.key.sign(ownerEnrollmentStartMessage(start, pin));
	const token = await issueOwnerEnrollmentAdmission(key, pin, start, { nowMs: NOW, ttlMs: 900000 });
	const csrfKey = await importBrowserCsrfKey(new Uint8Array(32).fill(23));
	const limiter = createInMemoryRequestRateLimiter({ now: () => NOW });
	return { key, start, token, csrfKey, limiter };
}

it("accepts only within the issued interval and maximum TTL", async () => {
	const c = await fixture();
	for (const [time, accepted] of [
		[NOW - 1, false],
		[NOW, true],
		[NOW + 899999, true],
		[NOW + 900000, false],
	] as const) {
		expect(await verifyOwnerEnrollmentAdmission(c.key, c.token, pin, c.start, time)).toBe(accepted);
	}
	for (const ttlMs of [0, -1, 900001, 0.5, Number.MAX_SAFE_INTEGER]) {
		await expect(
			issueOwnerEnrollmentAdmission(c.key, pin, c.start, { nowMs: NOW, ttlMs }),
		).rejects.toThrow();
	}
});

it.each([
	"attemptId",
	"deviceId",
	"publicKey",
	"loopbackRedirect",
	"browserStartCode",
	"signature",
] as const)("rejects a changed %s even when the pending device signs it", async (field) => {
	const c = await fixture();
	const replacements = {
		attemptId: "attempt-b",
		deviceId: "device-b",
		publicKey: `${c.start.publicKey} comment`,
		loopbackRedirect: "http://127.0.0.1:43211/codemem/auth/complete",
		browserStartCode: proof(),
		signature: "A".repeat(86),
	};
	const changed = { ...c.start, [field]: replacements[field] };
	if (field !== "signature")
		changed.signature = f.key.sign(ownerEnrollmentStartMessage(changed, pin));
	expect(await verifyOwnerEnrollmentAdmission(c.key, c.token, pin, changed, NOW)).toBe(false);
});

it.each(["coordinatorId", "origin", "issuer", "revision"] as const)(
	"rejects changed %s pins",
	async (field) => {
		const c = await fixture();
		expect(
			await verifyOwnerEnrollmentAdmission(
				c.key,
				c.token,
				{ ...pin, [field]: `${pin[field]}-changed` },
				c.start,
				NOW,
			),
		).toBe(false);
	},
);

it("rejects forged MACs, other keys and ambiguous token encodings", async () => {
	const c = await fixture();
	const other = await importOwnerEnrollmentAdmissionKey(new Uint8Array(32).fill(24));
	expect(await verifyOwnerEnrollmentAdmission(other, c.token, pin, c.start, NOW)).toBe(false);
	const mac = c.token.split(".")[3] ?? "";
	const ambiguousMac = mac.slice(0, -1) + String.fromCharCode(mac.charCodeAt(mac.length - 1) + 1);
	for (const token of [
		`${c.token}=`,
		` ${c.token}`,
		c.token.replace(`.${NOW}.`, `.0${NOW}.`),
		c.token.replace(mac, ambiguousMac),
		c.token.replace(mac, "A".repeat(43)),
		`v1.${NOW}.${NOW + 900001}.${mac}`,
		`${c.token}.extra`,
		"x".repeat(1000),
	])
		expect(await verifyOwnerEnrollmentAdmission(c.key, token, pin, c.start, NOW)).toBe(false);
});

it("issuer rejects noncanonical key spelling and invalid pending-key proof", async () => {
	const c = await fixture();
	for (const changed of [
		{ ...c.start, publicKey: `${c.start.publicKey} comment` },
		{ ...c.start, publicKey: ` ${c.start.publicKey}` },
		{ ...c.start, signature: "A".repeat(86) },
	])
		await expect(
			issueOwnerEnrollmentAdmission(c.key, pin, changed, { nowMs: NOW, ttlMs: 60000 }),
		).rejects.toThrow();
	await expect(importOwnerEnrollmentAdmissionKey(new Uint8Array(31))).rejects.toThrow();
});

it("a different canonical device key cannot use the reviewed capability", async () => {
	const c = await fixture();
	const other = commitPendingKey();
	const changed = { ...c.start, publicKey: other.publicKey };
	changed.signature = other.sign(ownerEnrollmentStartMessage(changed, pin));
	expect(await verifyOwnerEnrollmentAdmission(c.key, c.token, pin, changed, NOW)).toBe(false);
});

it("production permits SDK default fetch and denies starts without any storage or provider calls", async () => {
	const c = await fixture();
	let now = NOW;
	const run = vi.spyOn(f.backend, "run");
	const first = vi.spyOn(f.backend, "first");
	const batch = vi.spyOn(f.backend, "batch");
	const created = await createCoordinatorOwnerEnrollment({
		mode: "production",
		purpose: "owner_enroll",
		config,
		backend: f.backend,
		csrfKey: c.csrfKey,
		limiter: c.limiter,
		admissionKey: c.key,
		oidcOptions: {},
		clock: () => now,
	});
	if (!created.ok) throw new Error("production composition failed");
	for (const token of [undefined, "invalid", c.token.replace(`.${NOW}.`, `.${NOW + 1}.`)]) {
		expect((await created.enrollment.start(c.start, "socket-a", token)).kind).toBe("rejected");
	}
	const changed = { ...c.start, attemptId: "arbitrary-attempt" };
	changed.signature = f.key.sign(ownerEnrollmentStartMessage(changed, pin));
	expect((await created.enrollment.start(changed, "socket-a", c.token)).kind).toBe("rejected");
	expect(run).not.toHaveBeenCalled();
	expect(first).not.toHaveBeenCalled();
	expect(batch).not.toHaveBeenCalled();
	expect((await created.enrollment.start(c.start, "socket-a", c.token)).kind).toBe("started");
	expect((await created.enrollment.start(c.start, "socket-a", c.token)).kind).toBe("rejected");
	now += 600001;
	expect((await created.enrollment.start(c.start, "socket-a", c.token)).kind).toBe("rejected");
	expect(f.rows(ATTEMPTS)).toHaveLength(1);
});

async function httpFixture(wrapFetch: (fetch: CustomFetch) => CustomFetch = (fetch) => fetch) {
	const c = await fixture();
	const provider = oidcFixture({ issuer: config.issuer });
	const options = {
		mode: "production" as const,
		config: { ...config, clientId: PROVIDER.clientId, clientSecret: PROVIDER.clientSecret },
		backend: f.backend,
		csrfKey: c.csrfKey,
		limiter: c.limiter,
		admissionKey: c.key,
		oidcOptions: { fetch: wrapFetch(provider.fetch) },
		clock: () => NOW,
	};
	const http = await createCoordinatorOwnerEnrollmentHttp(options);
	return { ...c, provider, http, options };
}

async function admittedBrowserClaim(c: Awaited<ReturnType<typeof httpFixture>>, suffix: string) {
	const key = commitPendingKey();
	const start = {
		...c.start,
		attemptId: `attempt-${suffix}`,
		deviceId: `device-${suffix}`,
		publicKey: key.publicKey,
		browserStartCode: proof(),
	};
	start.signature = key.sign(ownerEnrollmentStartMessage(start, pin));
	const token = await issueOwnerEnrollmentAdmission(c.key, pin, start, {
		nowMs: NOW,
		ttlMs: 900000,
	});
	const admitted = await c.http.handle(
		new Request(`${ORIGIN}/v1/auth/owner-attempts`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify(start),
		}),
		`socket-${suffix}`,
	);
	if (admitted.status !== 200) throw new Error("fixture admission failed");
	const page = await c.http.handle(
		new Request(
			`${ORIGIN}/auth/owner/start?attempt_id=${start.attemptId}&start_code=${start.browserStartCode}`,
		),
		`socket-${suffix}`,
	);
	if (page.status !== 200) throw new Error("fixture browser page failed");
	const fields = Object.fromEntries(
		[...(await page.text()).matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2]]),
	);
	return new Request(`${ORIGIN}/auth/owner/start`, {
		method: "POST",
		headers: {
			origin: ORIGIN,
			cookie: page.headers.getSetCookie()[0]?.split(";")[0] ?? "",
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams(fields),
	});
}

// A deadlock watchdog only: success depends on explicit discovery gates, not elapsed time.
async function withoutDeadlock<T>(work: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("independent browser claim deadlocked")), 5000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

it.each(["success", "failure"] as const)(
	"production completes an independent browser claim while first discovery is held, then reuses success after first %s",
	async (outcome) => {
		// Arrange: real SDK discovery over fixture transport, through one production adapter.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
		const entered = Promise.withResolvers<void>();
		const held = Promise.withResolvers<void>();
		let discoveries = 0;
		let firstSettled = false;
		const c = await httpFixture((fetch) => async (url, options) => {
			if (url === `${config.issuer}/.well-known/openid-configuration`) {
				if (++discoveries === 1) {
					entered.resolve();
					await held.promise;
					if (outcome === "failure") throw new Error("fixture discovery failed");
				}
			}
			return fetch(url, options);
		});
		seedOwnerCallbackAuthority(f);
		const firstRequest = await admittedBrowserClaim(c, "first");
		const secondRequest = await admittedBrowserClaim(c, "second");
		expect(discoveries).toBe(0);
		const first = c.http.handle(firstRequest, "socket-first").finally(() => {
			firstSettled = true;
		});
		try {
			// Act: leave discovery one blocked until finally; browser two must finish alone.
			await withoutDeadlock(entered.promise);
			const second = await withoutDeadlock(c.http.handle(secondRequest, "socket-second"));
			expect(second.status).toBe(303);
			const callback = await withoutDeadlock(
				c.http.handleCallback(
					new Request(c.provider.authorize(second.headers.get("location") ?? ""), {
						headers: { cookie: second.headers.getSetCookie()[0]?.split(";")[0] ?? "" },
					}),
					"socket-second",
				),
			);
			const thirdRequest = await admittedBrowserClaim(c, "third");
			const third = await withoutDeadlock(c.http.handle(thirdRequest, "socket-third"));

			// Assert: callbacks and later claims reuse only browser two's settled success.
			expect(callback.status).toBe(200);
			expect(third.status).toBe(303);
			expect(discoveries).toBe(2);
			expect(firstSettled).toBe(false);
			expect(f.rows(ATTEMPTS).find((row) => row.attempt_id === "attempt-second")?.state).toBe(
				"oidc_verified",
			);
		} finally {
			held.resolve();
			expect((await first).status).toBe(outcome === "success" ? 303 : 400);
		}
		const fourthRequest = await admittedBrowserClaim(c, "fourth");
		expect((await c.http.handle(fourthRequest, "socket-fourth")).status).toBe(303);
		expect(discoveries).toBe(2);
	},
	15000,
);

it("production retries discovery after failure instead of caching a rejected client promise", async () => {
	// Arrange: fail exactly the first real SDK discovery, with no successful client cached yet.
	let discoveries = 0;
	const c = await httpFixture((fetch) => async (url, options) => {
		if (url === `${config.issuer}/.well-known/openid-configuration` && ++discoveries === 1)
			throw new Error("fixture discovery failed");
		return fetch(url, options);
	});
	const firstRequest = await admittedBrowserClaim(c, "failed");
	const secondRequest = await admittedBrowserClaim(c, "retry");
	const thirdRequest = await admittedBrowserClaim(c, "cached");

	// Act: a failed claim must not pin a failed promise for independent eligible claims.
	const failed = await c.http.handle(firstRequest, "socket-failed");
	const retry = await c.http.handle(secondRequest, "socket-retry");
	const cached = await c.http.handle(thirdRequest, "socket-cached");

	// Assert: fail closed once, then discover successfully and reuse the settled client.
	expect(failed.status).toBe(400);
	expect(retry.status).toBe(303);
	expect(cached.status).toBe(303);
	expect(discoveries).toBe(2);
});

it("production exposes narrow owner paths and a separate shared callback handler", async () => {
	const c = await httpFixture();
	expect(c.http.matchesPath("/v1/auth/owner-config")).toBe(true);
	expect(c.http.matchesPath("/v1/auth/owner-pilot")).toBe(false);
	expect(c.http.matchesPath("/auth/callback")).toBe(false);
	expect(c.http.matchesPath("/v1/auth/signin")).toBe(false);
	expect(
		(await c.http.handle(new Request(`${ORIGIN}/v1/auth/owner-config`), "socket-a")).status,
	).toBe(200);
	expect((await c.http.handle(new Request(`${ORIGIN}/auth/callback`), "socket-a")).status).toBe(
		404,
	);
	expect(
		(await c.http.handleCallback(new Request(`${ORIGIN}/v1/auth/owner-config`), "socket-a")).status,
	).toBe(404);
	expect(
		(await c.http.handleCallback(new Request(`${ORIGIN}/auth/callback`), "socket-a")).status,
	).toBe(400);
	expect(c.provider.requests).toHaveLength(0);
});

it("HTTP requires a Bearer capability and accepts start CSRF across separate adapters", async () => {
	const c = await httpFixture();
	const run = vi.spyOn(f.backend, "run");
	const request = (authorization?: string) =>
		new Request(`${ORIGIN}/v1/auth/owner-attempts`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
			body: JSON.stringify(c.start),
		});
	for (const authorization of [
		undefined,
		c.token,
		`Bearer ${c.token}=`,
		`Bearer ${c.token},${c.token}`,
	]) {
		expect((await c.http.handle(request(authorization), "socket-a")).status).toBe(400);
	}
	expect(run).not.toHaveBeenCalled();
	expect(c.provider.requests).toHaveLength(0);
	expect((await c.http.handle(request(`Bearer ${c.token}`), "socket-a")).status).toBe(200);
	const page = await c.http.handle(
		new Request(
			`${ORIGIN}/auth/owner/start?attempt_id=${c.start.attemptId}&start_code=${c.start.browserStartCode}`,
		),
		"socket-a",
	);
	const fields = Object.fromEntries(
		[...(await page.text()).matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2]]),
	);
	const second = await createCoordinatorOwnerEnrollmentHttp({
		...c.options,
		csrfKey: await importBrowserCsrfKey(new Uint8Array(32).fill(23)),
	});
	const claim = await second.handle(
		new Request(`${ORIGIN}/auth/owner/start`, {
			method: "POST",
			headers: {
				origin: ORIGIN,
				cookie: page.headers.getSetCookie()[0]?.split(";")[0] ?? "",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams(fields),
		}),
		"socket-a",
	);
	expect(claim.status).toBe(303);
	expect(c.provider.requests.length).toBeGreaterThan(0);
	seedOwnerCallbackAuthority(f);
	const callbackRequest = () =>
		new Request(c.provider.authorize(claim.headers.get("location") ?? ""), {
			headers: { cookie: claim.headers.getSetCookie()[0]?.split(";")[0] ?? "" },
		});
	// Shared dispatch must not probe the owner consumer through the ordinary mount.
	const callback = callbackRequest();
	expect((await second.handle(callback.clone(), "socket-a")).status).toBe(404);
	expect((await second.handleCallback(callback, "socket-a")).status).toBe(200);
});
