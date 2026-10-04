import { expect, it, vi } from "vitest";
import {
	BROWSER_COOKIE_NAMES,
	browserCookieValue,
	issueBrowserCookie,
} from "../../core/src/coordinator-browser-credential.js";
import {
	type BrowserCsrfKey,
	importBrowserCsrfKey,
	issueBrowserCsrfToken,
} from "../../core/src/coordinator-browser-csrf.js";
import {
	type BrowserFormGuardInput,
	guardBrowserForm,
} from "../../core/src/coordinator-browser-form-guard.js";
import { createInMemoryRequestRateLimiter } from "../../core/src/request-rate-limit.js";

const scope = {
	publicOrigin: "https://app.example.test",
	store: { coordinatorId: "coord-a", revision: "a".repeat(64) },
};
type Action = BrowserFormGuardInput["action"];
const encoder = new TextEncoder();
async function fixture(action: Action, tokenScope = scope) {
	// Public fixture key, not configuration or a provider credential.
	const csrfKey = await importBrowserCsrfKey(new Uint8Array(32));
	const purposes = {
		transaction_attempt: "transaction",
		session_logout: "session",
		signin_start: "start",
	} as const;
	const purpose = purposes[action];
	const issued = await issueBrowserCookie(purpose);
	const rawCookie = browserCookieValue(issued.secret, purpose);
	const csrf = await issueBrowserCsrfToken(csrfKey, issued.secret, purpose, tokenScope);
	const form = new URLSearchParams({ csrf });
	if (action === "transaction_attempt") form.set("attempt_id", "雪+a b");
	const headers = new Headers({
		Origin: scope.publicOrigin,
		Cookie: `${BROWSER_COOKIE_NAMES[purpose]}=${rawCookie}`,
		"Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
	});
	return { action, csrfKey, csrf, rawCookie, cookieHash: issued.cookieHash, form, headers };
}
function request(headers: Headers, body: BodyInit, url = `${scope.publicOrigin}/form`) {
	return new Request(url, { method: "POST", headers, body });
}
function unreadBody() {
	const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
		controller.enqueue(encoder.encode("csrf=unread"));
		controller.close();
	});
	return { pull, body: new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 }) };
}
function run(
	f: Awaited<ReturnType<typeof fixture>>,
	native = request(f.headers, f.form),
	overrides: Partial<BrowserFormGuardInput> = {},
) {
	return guardBrowserForm({
		request: native,
		scope,
		csrfKey: f.csrfKey,
		action: f.action,
		limiter: createInMemoryRequestRateLimiter(),
		clientKey: "trusted-client",
		...overrides,
	});
}
function fixedError(result: unknown, error: string) {
	expect(result).toEqual({ ok: false, error });
	expect(Object.isFrozen(result)).toBe(true);
}

it("verifies native start HMACs and shares the pinned budget with both old actions", async () => {
	// Arrange: unmounted helpers, real WebCrypto, no authorization or database lookup.
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
	try {
		const start = await fixture("signin_start");
		start.headers.set("Content-Type", "Application/X-Www-Form-Urlencoded ; CHARSET=UTF-8");
		const limiter = createInMemoryRequestRateLimiter({ now: () => 0 });
		const check = vi.spyOn(limiter, "check");
		const foreignHeaders = new Headers(start.headers);
		foreignHeaders.set("Origin", "https://other.example.test");
		const foreign = unreadBody();
		const foreignRequest = request(foreignHeaders, foreign.body);
		// Act / Assert: rejected origins cannot pin a different policy or pull the body.
		fixedError(await run(start, foreignRequest, { limiter, limit: 4 }), "origin_rejected");
		expect(check).not.toHaveBeenCalled();
		expect(foreign.pull).not.toHaveBeenCalled();
		expect(foreignRequest.bodyUsed).toBe(false);
		// Arrange / Act: matching native request Origin still cannot validate a foreign-origin MAC.
		const foreignMac = await fixture("signin_start", {
			...scope,
			publicOrigin: "https://other.example.test",
		});
		const invalidMac = await run(foreignMac);
		// Assert
		fixedError(invalidMac, "csrf_invalid");
		// Arrange / Act: all three valid native actions spend the same client's quota.
		const transaction = await fixture("transaction_attempt");
		const session = await fixture("session_logout");
		const accepted = await run(start, undefined, { limiter, limit: 3 });
		const oldActions = [
			await run(transaction, undefined, { limiter, limit: 3 }),
			await run(session, undefined, { limiter, limit: 3 }),
		];
		// Assert
		expect(accepted).toEqual({ ok: true, action: "signin_start", cookieHash: start.cookieHash });
		expect(Object.isFrozen(accepted)).toBe(true);
		expect(JSON.stringify(accepted)).not.toContain(start.csrf);
		expect(JSON.stringify(accepted)).not.toContain(start.rawCookie);
		for (const result of oldActions) expect(result.ok).toBe(true);
		expect(new Set(check.mock.calls.map(([key]) => key)).size).toBe(1);
		for (const [limit, error] of [
			[4, "invalid_input"],
			[3, "rate_limited"],
		] as const) {
			// Arrange
			const source = unreadBody();
			const native = request(start.headers, source.body);
			check.mockClear();
			// Act
			const result = await run(start, native, { limiter, limit });
			// Assert
			expect(result).toMatchObject({ ok: false, error });
			expect(Object.isFrozen(result)).toBe(true);
			expect(check).toHaveBeenCalledTimes(limit === 4 ? 0 : 1);
			expect(source.pull).not.toHaveBeenCalled();
			expect(native.bodyUsed).toBe(false);
		}
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		fetch.mockRestore();
	}
});

it("accepts native encoded forms for both actions without returning credentials", async () => {
	// Arrange: this unmounted helper validates input, not database authorization or browser policy.
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
	try {
		for (const action of ["transaction_attempt", "session_logout"] as const) {
			const f = await fixture(action);
			f.headers.set("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8");
			const valid = request(f.headers, f.form);
			const wrongCookie = await fixture(action);
			const badHeaders = new Headers(f.headers);
			badHeaders.set("Cookie", wrongCookie.headers.get("Cookie") ?? "");
			// Act
			const accepted = await run(f, valid);
			const denied = await run(f, request(badHeaders, f.form));
			// Assert: decoded plus and space survive, while a different same-kind cookie fails the MAC.
			const expected = { ok: true, action, cookieHash: f.cookieHash };
			expect(accepted).toEqual(
				action === "transaction_attempt" ? { ...expected, attemptId: "雪+a b" } : expected,
			);
			expect(Object.isFrozen(accepted)).toBe(true);
			expect(valid.bodyUsed).toBe(true);
			expect(valid.body?.locked).toBe(false);
			fixedError(denied, "csrf_invalid");
			for (const result of [accepted, denied]) {
				expect(JSON.stringify(result)).not.toContain(f.csrf);
				expect(JSON.stringify(result)).not.toContain(f.rawCookie);
				expect(result).not.toHaveProperty("csrfKey");
			}
		}
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		fetch.mockRestore();
	}
});

it("rejects merged or absent Origin and wrong URL hosts before pulling native bodies", async () => {
	// Arrange: forwarded and Referer headers cannot replace an exact Origin and URL match.
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
	try {
		const f = await fixture("session_logout");
		const duplicate = new Headers(f.headers);
		duplicate.append("Origin", scope.publicOrigin);
		const absent = new Headers(f.headers);
		absent.delete("Origin");
		absent.set("Referer", `${scope.publicOrigin}/form`);
		absent.set("X-Forwarded-Host", "app.example.test");
		absent.set("X-Forwarded-Proto", "https");
		const wrong = new Headers(f.headers);
		wrong.set("Origin", "https://other.example.test");
		const opaque = new Headers(f.headers);
		opaque.set("Origin", "null");
		// Act
		const accepted = await run(f);
		const denied = [];
		for (const [headers, url] of [
			[duplicate, scope.publicOrigin],
			[absent, scope.publicOrigin],
			[wrong, scope.publicOrigin],
			[opaque, scope.publicOrigin],
			[f.headers, "https://other.example.test"],
		] as const) {
			const stream = unreadBody();
			const native = request(headers, stream.body, `${url}/form`);
			denied.push({ result: await run(f, native), stream, native });
		}
		// Assert
		expect(accepted.ok).toBe(true);
		expect(duplicate.get("Origin")).toBe(`${scope.publicOrigin}, ${scope.publicOrigin}`);
		for (const { result, stream, native } of denied) {
			fixedError(result, "origin_rejected");
			expect(stream.pull).not.toHaveBeenCalled();
			expect(native.bodyUsed).toBe(false);
		}
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		fetch.mockRestore();
	}
});

it("shares a local limiter across actions but separates trusted clients and coordinators", async () => {
	// Arrange: deterministic time; this is a per-isolate brake, not fleet-wide enforcement.
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
	vi.useFakeTimers();
	vi.setSystemTime(0);
	try {
		const transaction = await fixture("transaction_attempt");
		const session = await fixture("session_logout");
		const limiter = createInMemoryRequestRateLimiter({ now: () => 0 });
		const otherScope = { ...scope, store: { ...scope.store, coordinatorId: "coord-b" } };
		const other = await fixture("session_logout", otherScope);
		const stream = unreadBody();
		const native = request(session.headers, stream.body);
		const limited = (f: typeof session, overrides: Partial<BrowserFormGuardInput> = {}) =>
			run(f, undefined, { limiter, limit: 2, ...overrides });
		// Act
		const first = await limited(transaction);
		const second = await limited(session);
		const denied = await run(session, native, { limiter, limit: 2 });
		const separateClient = await limited(session, { clientKey: "other-trusted-client" });
		const separateCoordinator = await limited(other, { scope: otherScope });
		// Assert: the third action is denied without reading its body.
		for (const result of [first, second, separateClient, separateCoordinator])
			expect(result.ok).toBe(true);
		expect(denied).toEqual({ ok: false, error: "rate_limited", retryAfterS: 30 });
		expect(Object.isFrozen(denied)).toBe(true);
		expect(stream.pull).not.toHaveBeenCalled();
		expect(native.bodyUsed).toBe(false);
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		vi.useRealTimers();
		fetch.mockRestore();
	}
});

it("rejects foreign origins without spending the trusted client's local rate budget", async () => {
	// Arrange: a pass-through spy observes the real shared limiter, not a canned allowance.
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
	try {
		const f = await fixture("session_logout");
		const real = createInMemoryRequestRateLimiter();
		const check = vi.fn((key: string, limit: number) => real.check.call(real, key, limit));
		const overrides = { limiter: { check }, limit: 2 };
		const headers = new Headers(f.headers);
		headers.set("Origin", "https://other.example.test");
		const foreign = Array.from({ length: 3 }, () => {
			const stream = unreadBody();
			return { stream, native: request(headers, stream.body) };
		});
		// Act: send more foreign-origin requests than the victim's entire allowance.
		const rejected = [];
		for (const { native } of foreign) rejected.push(await run(f, native, overrides));
		// Assert: origin rejection happens before any bucket access or body consumption.
		for (const result of rejected) fixedError(result, "origin_rejected");
		expect(check).not.toHaveBeenCalled();
		for (const { native, stream } of foreign) {
			expect(stream.pull).not.toHaveBeenCalled();
			expect(native.bodyUsed).toBe(false);
		}
		// Act: fresh native requests use the same trusted client and coordinator bucket.
		const first = await run(f, undefined, overrides);
		const second = await run(f, undefined, overrides);
		const stream = unreadBody();
		const third = request(f.headers, stream.body);
		const exhausted = await run(f, third, overrides);
		// Assert: both valid forms verify; only the third valid-origin request is limited.
		for (const result of [first, second]) {
			expect(result).toEqual({ ok: true, action: "session_logout", cookieHash: f.cookieHash });
			expect(Object.isFrozen(result)).toBe(true);
		}
		expect(check).toHaveBeenCalledTimes(3);
		expect(new Set(check.mock.calls.map(([key]) => key)).size).toBe(1);
		expect(exhausted).toEqual({ ok: false, error: "rate_limited", retryAfterS: 30 });
		expect(Object.isFrozen(exhausted)).toBe(true);
		expect(stream.pull).not.toHaveBeenCalled();
		expect(third.bodyUsed).toBe(false);
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		fetch.mockRestore();
	}
});

it("rejects policy changes without creating a fresh native mixed-action rate budget", async () => {
	// Arrange: native workerd requests, real HMACs and a pass-through primitive spy.
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
	vi.useFakeTimers();
	vi.setSystemTime(0);
	try {
		const transaction = await fixture("transaction_attempt");
		const session = await fixture("session_logout");
		const limiter = createInMemoryRequestRateLimiter({ now: () => 0 });
		const check = vi.spyOn(limiter, "check");
		// Act
		const first = await run(transaction, undefined, { limiter, limit: 2 });
		const second = await run(session, undefined, { limiter, limit: 2 });
		// Assert
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		for (const limit of [3, 20]) {
			// Arrange
			const stream = unreadBody();
			const native = request(session.headers, stream.body);
			check.mockClear();
			// Act
			const mismatch = await run(session, native, { limiter, limit });
			// Assert
			fixedError(mismatch, "invalid_input");
			expect(check).not.toHaveBeenCalled();
			expect(stream.pull).not.toHaveBeenCalled();
			expect(native.bodyUsed).toBe(false);
		}
		// Arrange / Act: original policy still denies rather than resetting its quota.
		const stream = unreadBody();
		const native = request(transaction.headers, stream.body);
		const exhausted = await run(transaction, native, { limiter, limit: 2 });
		// Assert
		expect(exhausted).toEqual({ ok: false, error: "rate_limited", retryAfterS: 30 });
		expect(stream.pull).not.toHaveBeenCalled();
		expect(native.bodyUsed).toBe(false);
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		vi.useRealTimers();
		fetch.mockRestore();
	}
});

it("returns fixed errors for oversized forms, malformed bytes and independently invalid MAC context", async () => {
	// Arrange: a small Content-Length must not bypass the actual 4096-byte stream cap.
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
	try {
		const f = await fixture("session_logout");
		const cancel = vi.fn();
		const oversized = new ReadableStream<Uint8Array>(
			{
				pull(c) {
					c.enqueue(new Uint8Array(4097));
				},
				cancel,
			},
			{ highWaterMark: 0 },
		);
		const smallLength = new Headers(f.headers);
		smallLength.set("Content-Length", "10");
		const native = request(smallLength, oversized);
		const unsupported = new Headers(f.headers);
		unsupported.set("Content-Type", "application/json");
		const foreign = await Promise.all(
			[
				{ ...scope, publicOrigin: "https://other.example.test" },
				{ ...scope, store: { ...scope.store, revision: "b".repeat(64) } },
				{ ...scope, store: { ...scope.store, coordinatorId: "coord-b" } },
			].map((tokenScope) => fixture("session_logout", tokenScope)),
		);
		const getter = vi.fn(() => {
			throw new Error("private getter diagnostic");
		});
		const badScope = Object.defineProperty({ ...scope }, "publicOrigin", { get: getter });
		// Act
		const accepted = await run(f);
		const overflow = await run(f, native);
		const media = await run(f, request(unsupported, f.form));
		const malformed = await Promise.all(
			[
				new Uint8Array([255]),
				`csrf=${f.csrf}&%63srf=${f.csrf}`,
				`csrf=${f.csrf}&unknown=private`,
				"csrf=%FF",
				"csrf=%",
			].map((body) => run(f, request(f.headers, body))),
		);
		const mac = await Promise.all([
			...foreign.map((f) => run(f)),
			run(f, undefined, { csrfKey: await importBrowserCsrfKey(new Uint8Array(32).fill(1)) }),
			run(f, undefined, { csrfKey: {} as BrowserCsrfKey }),
		]);
		const accessor = await run(f, undefined, { scope: badScope });
		// Assert: no input or native diagnostic reaches the caller.
		expect(accepted.ok).toBe(true);
		fixedError(overflow, "body_too_large");
		fixedError(media, "unsupported_media_type");
		for (const result of malformed) fixedError(result, "form_invalid");
		for (const result of mac) fixedError(result, "csrf_invalid");
		fixedError(accessor, "invalid_input");
		expect(getter).not.toHaveBeenCalled();
		expect(cancel).toHaveBeenCalledOnce();
		expect(native.bodyUsed).toBe(true);
		expect(native.body?.locked).toBe(false);
		const json = JSON.stringify([overflow, media, malformed, mac, accessor]);
		for (const secret of [f.csrf, f.rawCookie, ...foreign.map((f) => f.csrf), "private"])
			expect(json).not.toContain(secret);
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		fetch.mockRestore();
	}
});
