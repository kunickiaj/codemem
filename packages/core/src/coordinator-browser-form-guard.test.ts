import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BROWSER_COOKIE_NAMES,
	type CookieKind,
	issueBrowserCookie,
} from "./coordinator-browser-credential.js";
import { importBrowserCsrfKey, issueBrowserCsrfToken } from "./coordinator-browser-csrf.js";
import { guardBrowserForm } from "./coordinator-browser-form-guard.js";
import { createInMemoryRequestRateLimiter } from "./request-rate-limit.js";

type Input = Parameters<typeof guardBrowserForm>[0];
type Result = Awaited<ReturnType<typeof guardBrowserForm>>;
const PRIVATE_CAUSE = "private-guard-fixture-cause";
const RAW_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const ORIGIN = "https://coordinator.example";
const ATTEMPT = "attempt-fixture";
const encoder = new TextEncoder();

beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error(PRIVATE_CAUSE));
	for (const method of ["log", "warn", "error", "info", "debug"] as const) {
		vi.spyOn(console, method).mockImplementation(() => {});
	}
	vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
		if (!(array instanceof Uint8Array)) throw new Error("unexpected entropy destination");
		array.fill(17);
		return array;
	});
});
afterEach(() => {
	try {
		expect(globalThis.fetch).not.toHaveBeenCalled();
		for (const method of ["log", "warn", "error", "info", "debug"] as const) {
			expect(console[method]).not.toHaveBeenCalled();
		}
	} finally {
		vi.restoreAllMocks();
	}
});

function scope() {
	return {
		publicOrigin: ORIGIN,
		store: { coordinatorId: "coordinator-fixture", revision: "a".repeat(64) },
	};
}
function stream(bytes: Uint8Array = encoder.encode("unused")) {
	let sent = false;
	const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
		if (sent) controller.close();
		else {
			sent = true;
			controller.enqueue(bytes);
		}
	});
	return { body: new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 }), pull };
}
function request(headers: Headers, body: ReadableStream<Uint8Array>, url = `${ORIGIN}/form`) {
	return new Request(url, { method: "POST", headers, body, duplex: "half" } as RequestInit);
}
async function fixture(kind: CookieKind = "transaction") {
	const binding = scope();
	const csrfKey = await importBrowserCsrfKey(RAW_KEY.slice());
	const credential = await issueBrowserCookie(kind);
	const cookie = credential.setCookie.split(";")[0];
	const token = await issueBrowserCsrfToken(csrfKey, credential.secret, kind, binding);
	const action = kind === "transaction" ? "transaction_attempt" : "session_logout";
	const text = kind === "transaction" ? `csrf=${token}&attempt_id=${ATTEMPT}` : `csrf=${token}`;
	const headers = new Headers({
		origin: ORIGIN,
		"content-type": "application/x-www-form-urlencoded",
		cookie,
	});
	const source = stream(encoder.encode(text));
	const check = vi.fn((_key: string, _limit: number) => ({ allowed: true, retryAfterS: 0 }));
	const input: Input = {
		request: request(headers, source.body),
		scope: binding,
		csrfKey,
		action,
		limiter: { check },
		clientKey: "trusted-client",
	};
	return { input, headers, source, credential, cookie, token, text, check };
}
function deny(result: Result, error: string, secrets: string[] = []) {
	expect(result).toEqual({ ok: false, error });
	expect(Object.isFrozen(result)).toBe(true);
	const json = JSON.stringify(result);
	for (const secret of [...secrets, PRIVATE_CAUSE, Buffer.from(RAW_KEY).toString("hex")]) {
		expect(json).not.toContain(secret);
	}
}
function replaceBody(f: Awaited<ReturnType<typeof fixture>>, text: string | Uint8Array) {
	const source = stream(typeof text === "string" ? encoder.encode(text) : text);
	f.input.request = request(f.headers, source.body);
	return source;
}
function untyped(input: unknown) {
	return guardBrowserForm(input as Input);
}

describe("browser form guard caller contract", () => {
	it.each(["transaction", "session"] as const)(
		"verifies %s without claiming authentication",
		async (kind) => {
			// Arrange: real minted credentials, deliberately no database or authenticated row.
			const f = await fixture(kind);
			// Act
			const result = await guardBrowserForm(f.input);
			// Assert: caller must subsequently look up cookieHash and validate the live row.
			const expected = { ok: true, action: f.input.action, cookieHash: f.credential.cookieHash };
			expect(result).toEqual(
				kind === "transaction" ? { ...expected, attemptId: ATTEMPT } : expected,
			);
			expect(Object.isFrozen(result)).toBe(true);
			expect(f.check).toHaveBeenCalledOnce();
			expect(f.check.mock.calls[0]?.[1]).toBe(20);
			for (const secret of [f.token, f.cookie, Buffer.from(RAW_KEY).toString("hex")]) {
				expect(JSON.stringify(result)).not.toContain(secret);
			}
		},
	);
	it("does not let logout accept transaction-only fields", async () => {
		// Arrange
		const f = await fixture("session");
		replaceBody(f, `${f.text}&attempt_id=${ATTEMPT}`);
		// Act
		const result = await guardBrowserForm(f.input);
		// Assert
		deny(result, "form_invalid", [f.token, f.cookie]);
	});
	it.each([null, [], {}, "transaction", "callback"])(
		"rejects unsupported action %j",
		async (action) => {
			// Arrange
			const f = await fixture();
			// Act
			const result = await untyped({ ...f.input, action });
			// Assert
			deny(result, "invalid_input", [f.token, f.cookie]);
			expect(f.source.pull).not.toHaveBeenCalled();
		},
	);
});

describe("early request gates", () => {
	it("rejects GET before allocating a bucket or pulling a body", async () => {
		// Arrange
		const f = await fixture();
		f.headers.delete("origin");
		f.input.request = new Request(`${ORIGIN}/form`, { headers: f.headers });
		// Act
		const result = await guardBrowserForm(f.input);
		// Assert
		deny(result, "method_not_allowed");
		expect(f.check).not.toHaveBeenCalled();
		expect(f.source.pull).not.toHaveBeenCalled();
	});
	it.each([null, "", " ", " client", "client ", "x".repeat(129), "a\nb", "a\u0000b"])(
		"rejects unidentified client %j before limiter and body",
		async (clientKey) => {
			// Arrange
			const f = await fixture();
			// Act
			const result = await untyped({ ...f.input, clientKey });
			// Assert
			deny(result, "client_unidentified");
			expect(f.check).not.toHaveBeenCalled();
			expect(f.source.pull).not.toHaveBeenCalled();
		},
	);
	it("accepts a 128-character trusted client key", async () => {
		// Arrange
		const f = await fixture();
		f.input.clientKey = "x".repeat(128);
		// Act
		const result = await guardBrowserForm(f.input);
		// Assert
		expect(result.ok).toBe(true);
	});
	it.each([0, 1001, Infinity, NaN, 1.5, "20", { valueOf: () => 20 }])(
		"rejects invalid limit %j without coercion",
		async (limit) => {
			// Arrange
			const f = await fixture();
			// Act
			const result = await untyped({ ...f.input, limit });
			// Assert
			deny(result, "invalid_input");
			expect(f.check).not.toHaveBeenCalled();
			expect(f.source.pull).not.toHaveBeenCalled();
		},
	);
	it.each([1, 1000])("accepts explicit limit boundary %i", async (limit) => {
		// Arrange
		const f = await fixture();
		// Act
		const result = await guardBrowserForm({ ...f.input, limit });
		// Assert
		expect(result.ok).toBe(true);
		expect(f.check).toHaveBeenCalledWith(expect.any(String), limit);
	});
	it.each([
		null,
		"null",
		`${ORIGIN}/`,
		"https://COORDINATOR.example",
		`${ORIGIN}, ${ORIGIN}`,
		"https://evil.example",
	])("requires exact Origin %j despite forwarded or Referer hints", async (origin) => {
		// Arrange
		const f = await fixture();
		if (origin === null) f.headers.delete("origin");
		else f.headers.set("origin", origin);
		f.headers.set("referer", `${ORIGIN}/legitimate`);
		f.headers.set("x-forwarded-host", "coordinator.example");
		f.headers.set("x-forwarded-proto", "https");
		f.input.request = request(f.headers, f.source.body);
		// Act
		const result = await guardBrowserForm(f.input);
		// Assert
		deny(result, "origin_rejected");
		expect(f.check).not.toHaveBeenCalled();
		expect(f.source.pull).not.toHaveBeenCalled();
		expect(f.input.request.bodyUsed).toBe(false);
	});
	it.each([
		"https://evil.example/form",
		"http://coordinator.example/form",
		"https://coordinator.example:444/form",
	])("rejects request URL origin mismatch %s", async (url) => {
		// Arrange
		const f = await fixture();
		f.input.request = request(f.headers, f.source.body, url);
		// Act
		const result = await guardBrowserForm(f.input);
		// Assert
		deny(result, "origin_rejected");
		expect(f.check).not.toHaveBeenCalled();
		expect(f.source.pull).not.toHaveBeenCalled();
		expect(f.input.request.bodyUsed).toBe(false);
	});
});

describe("media and length gates", () => {
	it.each([
		"application/x-www-form-urlencoded",
		"Application/X-Www-Form-Urlencoded ; CHARSET=UTF-8",
		"application/x-www-form-urlencoded; charset=utf-8",
	])("accepts supported media type %s", async (media) => {
		// Arrange
		const f = await fixture();
		f.headers.set("content-type", media);
		f.input.request = request(f.headers, f.source.body);
		// Act
		const result = await guardBrowserForm(f.input);
		// Assert
		expect(result.ok).toBe(true);
	});
	it.each([
		null,
		"text/plain",
		"multipart/form-data",
		"application/x-www-form-urlencoded; charset=latin1",
		'application/x-www-form-urlencoded; charset="utf-8"',
		"application/x-www-form-urlencoded; foo=bar",
		"application/x-www-form-urlencoded; charset=utf-8; charset=utf-8",
	])("rejects unsupported media %j before body", async (media) => {
		// Arrange
		const f = await fixture();
		if (media === null) f.headers.delete("content-type");
		else f.headers.set("content-type", media);
		f.input.request = request(f.headers, f.source.body);
		// Act
		const result = await guardBrowserForm(f.input);
		// Assert
		deny(result, "unsupported_media_type");
		expect(f.source.pull).not.toHaveBeenCalled();
	});
	it.each(["", "+10", "-1", "1.5", "10,10", "00000000000", "1e2"])(
		"rejects declared length %j",
		async (length) => {
			// Arrange
			const f = await fixture();
			f.headers.set("content-length", length);
			f.input.request = request(f.headers, f.source.body);
			// Act
			const result = await guardBrowserForm(f.input);
			// Assert
			deny(result, "form_invalid");
			expect(f.source.pull).not.toHaveBeenCalled();
		},
	);
	it.each(["0", "0000000010", "4096"])(
		"accepts length grammar %s without trusting it as actual size",
		async (length) => {
			// Arrange
			const f = await fixture();
			f.headers.set("content-length", length);
			f.input.request = request(f.headers, f.source.body);
			// Act
			const result = await guardBrowserForm(f.input);
			// Assert
			expect(result.ok).toBe(true);
		},
	);
	it("rejects oversized declared body before any pull", async () => {
		// Arrange
		const f = await fixture();
		f.headers.set("content-length", "4097");
		f.input.request = request(f.headers, f.source.body);
		// Act
		const result = await guardBrowserForm(f.input);
		// Assert
		deny(result, "body_too_large");
		expect(f.source.pull).not.toHaveBeenCalled();
	});
});

describe("limiter boundary", () => {
	it.each([
		null,
		{},
		[],
		{ allowed: 1, retryAfterS: 0 },
		{ allowed: "true", retryAfterS: 0 },
		{ allowed: false, retryAfterS: NaN },
		{
			get allowed() {
				throw new Error(PRIVATE_CAUSE);
			},
			retryAfterS: 0,
		},
	])("rejects malformed limiter output case %# without body read", async (output) => {
		// Arrange
		const f = await fixture();
		const limiter = { check: vi.fn(() => output) };
		// Act
		const result = await untyped({ ...f.input, limiter });
		// Assert
		deny(result, "invalid_input");
		expect(f.source.pull).not.toHaveBeenCalled();
	});
	it("contains limiter exceptions for a valid same-origin request", async () => {
		// Arrange
		const f = await fixture();
		f.check.mockImplementation(() => {
			throw new Error(PRIVATE_CAUSE);
		});
		// Act
		const result = await guardBrowserForm(f.input);
		// Assert
		deny(result, "invalid_input");
		expect(f.check).toHaveBeenCalledOnce();
		expect(f.source.pull).not.toHaveBeenCalled();
	});
	it.each([null, "https://evil.example"])(
		"rejects Origin %j before even a throwing limiter",
		async (origin) => {
			// Arrange
			const f = await fixture();
			if (origin === null) f.headers.delete("origin");
			else f.headers.set("origin", origin);
			f.input.request = request(f.headers, f.source.body);
			f.check.mockImplementation(() => {
				throw new Error(PRIVATE_CAUSE);
			});
			// Act
			const result = await guardBrowserForm(f.input);
			// Assert
			deny(result, "origin_rejected");
			expect(f.check).not.toHaveBeenCalled();
			expect(f.source.pull).not.toHaveBeenCalled();
			expect(f.input.request.bodyUsed).toBe(false);
		},
	);
	it.each([
		[0, 1],
		[-100, 1],
		[1.1, 2],
		[4000, 3600],
	])("clamps denied retry %i to %i", async (raw, retryAfterS) => {
		// Arrange
		const f = await fixture();
		f.check.mockReturnValue({ allowed: false, retryAfterS: raw });
		// Act
		const result = await guardBrowserForm(f.input);
		// Assert
		expect(result).toEqual({ ok: false, error: "rate_limited", retryAfterS });
		expect(Object.isFrozen(result)).toBe(true);
		expect(f.source.pull).not.toHaveBeenCalled();
	});
	it("shares the actual limiter across fresh requests and both action kinds", async () => {
		// Arrange: a fixed clock prevents refill; this is per-isolate, not fleet enforcement.
		// limiter/src/clock.ts uses performance.now, independently of the wrapper's now option.
		const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
		const limiter = createInMemoryRequestRateLimiter({ windowMs: 60_000, now: () => 1000 });
		const results: Result[] = [];
		// Act
		for (let index = 0; index < 21; index++) {
			const f = await fixture(index % 2 ? "session" : "transaction");
			results.push(await guardBrowserForm({ ...f.input, limiter }));
		}
		const isolated = await fixture();
		const otherClient = await guardBrowserForm({
			...isolated.input,
			limiter,
			clientKey: "other-client",
		});
		const otherCoordinator = await fixture();
		otherCoordinator.input.scope.store.coordinatorId = "other-coordinator";
		const token = await issueBrowserCsrfToken(
			otherCoordinator.input.csrfKey,
			otherCoordinator.credential.secret,
			"transaction",
			otherCoordinator.input.scope,
		);
		replaceBody(otherCoordinator, `csrf=${token}&attempt_id=${ATTEMPT}`);
		const otherResult = await guardBrowserForm({ ...otherCoordinator.input, limiter });
		clock.mockReturnValue(61_001);
		const rolledOver = await fixture();
		const afterWindow = await guardBrowserForm({ ...rolledOver.input, limiter });
		// Assert
		expect(results.slice(0, 20).map((result) => result.ok)).toEqual(Array(20).fill(true));
		expect(results[20]).toEqual({ ok: false, error: "rate_limited", retryAfterS: 3 });
		expect(otherClient.ok).toBe(true);
		expect(otherResult.ok).toBe(true);
		expect(afterWindow.ok).toBe(true);
	});
	it("uses unambiguous framed coordinator/client bucket identifiers", async () => {
		// Arrange: colon-delimited concatenation would collide for these pairs.
		const a = await fixture();
		const b = await fixture();
		a.input.scope.store.coordinatorId = "coordinator:a";
		a.input.clientKey = "b";
		b.input.scope.store.coordinatorId = "coordinator";
		b.input.clientKey = "a:b";
		// Act: CSRF fails later, but both bucket identities must already be captured.
		await guardBrowserForm(a.input);
		await guardBrowserForm(b.input);
		// Assert
		expect(a.check).toHaveBeenCalledOnce();
		expect(b.check).toHaveBeenCalledOnce();
		expect(a.check.mock.calls[0]?.[0]).not.toBe(b.check.mock.calls[0]?.[0]);
	});
});

describe("coordinator-wide limiter policy", () => {
	it("cannot replenish a mixed-action budget by changing limit or trusted client", async () => {
		// Arrange: exercise the real primitive whose bucket identity includes the limit.
		const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
		const limiter = createInMemoryRequestRateLimiter({ now: () => 1000 });
		const check = vi.spyOn(limiter, "check");
		const transaction = await fixture();
		const session = await fixture("session");
		// Act
		const first = await guardBrowserForm({ ...transaction.input, limiter, limit: 2 });
		const second = await guardBrowserForm({ ...session.input, limiter, limit: 2 });
		// Assert: both real cookie/MAC action kinds share the chosen policy.
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		for (const [limit, clientKey] of [
			[3, "trusted-client"],
			[undefined, "trusted-client"],
			[20, "other-client"],
		] as const) {
			// Arrange
			const f = await fixture("session");
			check.mockClear();
			// Act
			const result = await guardBrowserForm({ ...f.input, limiter, limit, clientKey });
			// Assert: mismatch is rejected before bucket access or body consumption.
			deny(result, "invalid_input");
			expect(check).not.toHaveBeenCalled();
			expect(f.source.pull).not.toHaveBeenCalled();
			expect(f.input.request.bodyUsed).toBe(false);
		}
		// Arrange / Act: the original policy remains exhausted; rollover cannot replace it.
		const exhausted = await fixture();
		const original = await guardBrowserForm({ ...exhausted.input, limiter, limit: 2 });
		clock.mockReturnValue(61_001);
		const changed = await fixture();
		check.mockClear();
		const afterWindow = await guardBrowserForm({ ...changed.input, limiter, limit: 3 });
		const callsAfterMismatch = check.mock.calls.length;
		const renewed = await fixture();
		const samePolicy = await guardBrowserForm({ ...renewed.input, limiter, limit: 2 });
		// Assert
		expect(original).toEqual({ ok: false, error: "rate_limited", retryAfterS: 30 });
		deny(afterWindow, "invalid_input");
		expect(callsAfterMismatch).toBe(0);
		expect(changed.source.pull).not.toHaveBeenCalled();
		expect(changed.input.request.bodyUsed).toBe(false);
		expect(samePolicy.ok).toBe(true);
	});
	it.each(["origin", "client", "limit"])(
		"does not pin policy from rejected %s input",
		async (gate) => {
			// Arrange
			const f = await fixture();
			const limiter = createInMemoryRequestRateLimiter({ now: () => 1000 });
			const check = vi.spyOn(limiter, "check");
			if (gate === "origin") {
				f.headers.set("origin", "https://evil.example");
				f.input.request = request(f.headers, f.source.body);
			}
			// Act
			const rejected = await guardBrowserForm({
				...f.input,
				limiter,
				limit: gate === "limit" ? 0 : 100,
				clientKey: gate === "client" ? "" : "trusted-client",
			});
			const callsAfterRejection = check.mock.calls.length;
			const valid = await fixture();
			const accepted = await guardBrowserForm({ ...valid.input, limiter, limit: 2 });
			// Assert
			const errors = {
				origin: "origin_rejected",
				client: "client_unidentified",
				limit: "invalid_input",
			};
			deny(rejected, errors[gate as keyof typeof errors]);
			expect(callsAfterRejection).toBe(0);
			expect(f.source.pull).not.toHaveBeenCalled();
			expect(f.input.request.bodyUsed).toBe(false);
			expect(accepted.ok).toBe(true);
		},
	);
});

describe("limiter policy isolation and failures", () => {
	it.each(["coordinator", "limiter"])(
		"allows independent policy for a different %s",
		async (isolation) => {
			// Arrange
			const first = await fixture();
			const other = await fixture();
			const limiter = createInMemoryRequestRateLimiter({ now: () => 1000 });
			let otherLimiter = limiter;
			if (isolation === "limiter")
				otherLimiter = createInMemoryRequestRateLimiter({ now: () => 1000 });
			else {
				other.input.scope.store.coordinatorId = "other-coordinator";
				const token = await issueBrowserCsrfToken(
					other.input.csrfKey,
					other.credential.secret,
					"transaction",
					other.input.scope,
				);
				replaceBody(other, `csrf=${token}&attempt_id=${ATTEMPT}`);
			}
			// Act
			const initial = await guardBrowserForm({ ...first.input, limiter, limit: 2 });
			const separate = await guardBrowserForm({ ...other.input, limiter: otherLimiter, limit: 3 });
			// Assert
			expect(initial.ok).toBe(true);
			expect(separate.ok).toBe(true);
		},
	);
	it.each(["malformed", "throwing"])(
		"retains trusted policy after %s limiter output",
		async (failure) => {
			// Arrange
			const first = await fixture();
			const check = vi.fn<() => unknown>(() => {
				if (failure === "throwing") throw new Error(PRIVATE_CAUSE);
				return { allowed: "yes", retryAfterS: 0 };
			});
			const limiter = { check };
			// Act
			const failed = await untyped({ ...first.input, limiter, limit: 2 });
			check.mockClear();
			check.mockReturnValue({ allowed: true, retryAfterS: 0 });
			const changed = await fixture();
			const mismatch = await untyped({ ...changed.input, limiter, limit: 3 });
			const callsAfterMismatch = check.mock.calls.length;
			const valid = await fixture();
			const recovered = await untyped({ ...valid.input, limiter, limit: 2 });
			// Assert
			deny(failed, "invalid_input");
			deny(mismatch, "invalid_input");
			expect(callsAfterMismatch).toBe(0);
			expect(changed.source.pull).not.toHaveBeenCalled();
			expect(changed.input.request.bodyUsed).toBe(false);
			expect(recovered.ok).toBe(true);
		},
	);
});

describe("cross-site requests cannot exhaust a trusted client's quota", () => {
	it.each([
		["missing", null, `${ORIGIN}/form`],
		["null", "null", `${ORIGIN}/form`],
		["merged", `${ORIGIN}, ${ORIGIN}`, `${ORIGIN}/form`],
		["wrong-origin", "https://evil.example", `${ORIGIN}/form`],
		["wrong-host", ORIGIN, "https://evil.example/form"],
	] as const)(
		"preserves the real shared bucket after a %s request flood",
		async (_forgery, origin, url) => {
			// Arrange: freeze the actual limiter clock as well as its wrapper clock.
			vi.spyOn(performance, "now").mockReturnValue(1000);
			const limiter = createInMemoryRequestRateLimiter({ windowMs: 60_000, now: () => 1000 });
			const check = vi.spyOn(limiter, "check");
			const limit = 3;
			const attacks = await Promise.all(Array.from({ length: limit + 2 }, () => fixture()));
			const legitimate = await Promise.all(Array.from({ length: limit + 1 }, () => fixture()));
			for (const f of attacks) {
				if (origin === null) f.headers.delete("origin");
				else f.headers.set("origin", origin);
				f.input.request = request(f.headers, f.source.body, url);
			}
			// Act: all attacks share the legitimate client's trusted key and coordinator.
			const rejected: Result[] = [];
			for (const f of attacks)
				rejected.push(await guardBrowserForm({ ...f.input, limiter, limit }));
			const callsAfterAttacks = check.mock.calls.length;
			const admitted: Result[] = [];
			for (const f of legitimate)
				admitted.push(await guardBrowserForm({ ...f.input, limiter, limit }));
			// Assert: no attack debits the shared quota, but legitimate calls still enforce its cap.
			for (const [index, f] of attacks.entries()) {
				deny(rejected[index], "origin_rejected", [f.token, f.cookie]);
				expect(f.source.pull).not.toHaveBeenCalled();
				expect(f.input.request.bodyUsed).toBe(false);
			}
			expect(callsAfterAttacks).toBe(0);
			for (const [index, f] of legitimate.slice(0, limit).entries()) {
				expect(admitted[index]).toEqual({
					ok: true,
					action: "transaction_attempt",
					cookieHash: f.credential.cookieHash,
					attemptId: ATTEMPT,
				});
			}
			expect(admitted[limit]).toEqual({ ok: false, error: "rate_limited", retryAfterS: 20 });
			expect(check).toHaveBeenCalledTimes(limit + 1);
			expect(legitimate[limit].source.pull).not.toHaveBeenCalled();
			expect(legitimate[limit].input.request.bodyUsed).toBe(false);
		},
	);
});

describe("owned snapshots and unusable bodies", () => {
	it("uses native Request fields rather than caller-owned overrides", async () => {
		// Arrange
		const f = await fixture();
		const getter = vi.fn(() => {
			throw new Error(PRIVATE_CAUSE);
		});
		for (const name of ["method", "url", "headers", "body"]) {
			Object.defineProperty(f.input.request, name, { get: getter });
		}
		// Act
		const result = await guardBrowserForm(f.input);
		// Assert
		expect(result.ok).toBe(true);
		expect(getter).not.toHaveBeenCalled();
	});
	it.each(["input", "scope", "store", "proxy", "array", "inherited", "origin", "revision"])(
		"rejects hostile %s without invoking accessors or reading body",
		async (shape) => {
			// Arrange
			const f = await fixture();
			const getter = vi.fn(() => {
				throw new Error(PRIVATE_CAUSE);
			});
			let input: unknown = f.input;
			const mutate: Record<string, () => unknown> = {
				input: () => Object.defineProperty(f.input, "action", { get: getter }),
				scope: () => Object.defineProperty(f.input.scope, "publicOrigin", { get: getter }),
				store: () => Object.defineProperty(f.input.scope.store, "revision", { get: getter }),
				proxy: () => {
					input = new Proxy(f.input, { getOwnPropertyDescriptor: getter });
				},
				array: () => {
					input = Object.assign([], f.input);
				},
				inherited: () => {
					input = Object.create(f.input);
				},
				origin: () => {
					f.input.scope.publicOrigin = `${ORIGIN}/callback`;
				},
				revision: () => {
					f.input.scope.store.revision = "A".repeat(64);
				},
			};
			mutate[shape]();
			// Act
			const result = await untyped(input);
			// Assert
			deny(result, "invalid_input");
			if (shape !== "proxy") expect(getter).not.toHaveBeenCalled();
			expect(f.source.pull).not.toHaveBeenCalled();
			expect(f.check).not.toHaveBeenCalled();
		},
	);
	it.each(["crypto", "body"])("retains original fields across deferred %s", async (stage) => {
		// Arrange: explicit gates, no sleeps or scheduling guesses.
		const f = await fixture();
		let release = () => {};
		let entered = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		if (stage === "crypto") {
			const digest = crypto.subtle.digest.bind(crypto.subtle);
			vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
				entered();
				await gate;
				return digest(...args);
			});
		} else {
			const body = new ReadableStream<Uint8Array>(
				{
					async pull(controller) {
						entered();
						await gate;
						controller.enqueue(encoder.encode(f.text));
						controller.close();
					},
				},
				{ highWaterMark: 0 },
			);
			f.input.request = request(f.headers, body);
		}
		const original = f.input.request;
		// Act
		const pending = guardBrowserForm(f.input);
		await started;
		for (const name of ["origin", "content-type", "content-length", "cookie"])
			original.headers.set(name, "changed");
		f.input.scope.publicOrigin = "https://changed.example";
		f.input.scope.store.coordinatorId = "changed";
		f.input.scope.store.revision = "b".repeat(64);
		f.input.action = "session_logout";
		f.input.csrfKey = await importBrowserCsrfKey(new Uint8Array(32).fill(99));
		f.input.clientKey = "changed";
		f.input.request = new Request("https://changed.example");
		f.input.limiter = {
			check: () => {
				throw new Error(PRIVATE_CAUSE);
			},
		};
		release();
		const result = await pending;
		// Assert
		expect(result).toEqual({
			ok: true,
			action: "transaction_attempt",
			cookieHash: f.credential.cookieHash,
			attemptId: ATTEMPT,
		});
		expect(f.check).toHaveBeenCalledOnce();
	});
	it.each(["locked", "disturbed"])(
		"contains already %s body without another read",
		async (state) => {
			// Arrange
			const f = await fixture();
			const reader = f.source.body.getReader();
			if (state === "disturbed") {
				await reader.read();
				reader.releaseLock();
			}
			const pulls = f.source.pull.mock.calls.length;
			// Act
			const result = await guardBrowserForm(f.input);
			// Assert
			deny(result, "form_invalid");
			expect(f.source.pull).toHaveBeenCalledTimes(pulls);
			if (state === "locked") reader.releaseLock();
		},
	);
});

describe("cookie, form and MAC checks", () => {
	it("rejects overlong cookie OWS before trimming and without pulling body", async () => {
		// Arrange: interior OWS survives native Headers outer-whitespace normalization.
		const f = await fixture();
		f.headers.set("cookie", `other=x;${" ".repeat(8192)}${f.cookie}`);
		f.input.request = request(f.headers, f.source.body);
		// Act
		const result = await guardBrowserForm(f.input);
		// Assert
		deny(result, "cookie_invalid", [f.token, f.cookie]);
		expect(f.source.pull).not.toHaveBeenCalled();
	});
	it.each([
		[null, "cookie_missing"],
		["", "cookie_missing"],
		["other=value", "cookie_missing"],
		["__host-codemem-auth-transaction=value", "cookie_invalid"],
	] as const)("rejects cookie %j without pulling", async (cookie, error) => {
		// Arrange
		const f = await fixture();
		if (cookie === null) f.headers.delete("cookie");
		else f.headers.set("cookie", cookie);
		f.input.request = request(f.headers, f.source.body);
		// Act
		const result = await guardBrowserForm(f.input);
		// Assert
		deny(result, error, [f.token, f.cookie]);
		expect(f.source.pull).not.toHaveBeenCalled();
	});
	it.each(["transaction", "session"] as const)(
		"rejects duplicate known %s cookie",
		async (kind) => {
			// Arrange
			const f = await fixture();
			const value = Buffer.alloc(32, 17).toString("base64url");
			f.headers.set(
				"cookie",
				`${f.cookie}; ${BROWSER_COOKIE_NAMES[kind]}=${value}; ${BROWSER_COOKIE_NAMES[kind]}=${value}`,
			);
			f.input.request = request(f.headers, f.source.body);
			// Act
			const result = await guardBrowserForm(f.input);
			// Assert
			deny(result, "cookie_invalid");
			expect(f.source.pull).not.toHaveBeenCalled();
		},
	);
	it.each([
		"",
		"attempt_id=attempt-fixture",
		"csrf=%",
		"csrf=%FF",
		"csrf=x&csrf=y&attempt_id=a",
		"csrf=x&unknown=y&attempt_id=a",
		"csrf=x&attempt_id=",
		`csrf=x&attempt_id=${"a".repeat(257)}`,
		"\uFEFFcsrf=x&attempt_id=a",
	])("rejects malformed form %j", async (text) => {
		// Arrange
		const f = await fixture();
		replaceBody(f, text);
		// Act
		const result = await guardBrowserForm(f.input);
		// Assert
		deny(result, "form_invalid", [f.token, f.cookie]);
	});
	it.each(["", "x"])("classifies malformed CSRF shape %j as csrf_invalid", async (token) => {
		// Arrange
		const f = await fixture();
		replaceBody(f, `csrf=${token}&attempt_id=${ATTEMPT}`);
		// Act
		const result = await guardBrowserForm(f.input);
		// Assert
		deny(result, "csrf_invalid");
	});
	it("accepts attempt identifier length 256", async () => {
		// Arrange
		const f = await fixture();
		const attemptId = "a".repeat(256);
		replaceBody(f, `csrf=${f.token}&attempt_id=${attemptId}`);
		// Act
		const result = await guardBrowserForm(f.input);
		// Assert
		expect(result).toEqual({
			ok: true,
			action: "transaction_attempt",
			cookieHash: f.credential.cookieHash,
			attemptId,
		});
	});
	it("enforces actual bytes despite small declared length", async () => {
		// Arrange
		const f = await fixture();
		f.headers.set("content-length", "10");
		replaceBody(f, "x".repeat(4097));
		// Act
		const result = await guardBrowserForm(f.input);
		// Assert
		deny(result, "body_too_large");
	});
});

describe("CSRF binding", () => {
	it.each(["key", "cookie", "kind", "coordinator", "origin", "revision", "tamper"])(
		"rejects changed CSRF binding %s",
		async (change) => {
			// Arrange: retain the otherwise-valid cookie to avoid confounding scope checks.
			const f = await fixture();
			if (change === "key")
				f.input.csrfKey = await importBrowserCsrfKey(new Uint8Array(32).fill(99));
			if (change === "cookie") {
				f.headers.set(
					"cookie",
					`${BROWSER_COOKIE_NAMES.transaction}=${Buffer.alloc(32, 99).toString("base64url")}`,
				);
				f.input.request = request(f.headers, f.source.body);
			}
			if (change === "kind") {
				const credential = await issueBrowserCookie("session");
				const token = await issueBrowserCsrfToken(
					f.input.csrfKey,
					credential.secret,
					"session",
					f.input.scope,
				);
				replaceBody(f, `csrf=${token}&attempt_id=${ATTEMPT}`);
			}
			if (change === "coordinator") f.input.scope.store.coordinatorId = "changed-coordinator";
			if (change === "revision") f.input.scope.store.revision = "b".repeat(64);
			if (change === "origin") {
				f.input.scope.publicOrigin = "https://changed.example";
				f.headers.set("origin", f.input.scope.publicOrigin);
				f.input.request = request(f.headers, f.source.body, `${f.input.scope.publicOrigin}/form`);
			}
			if (change === "tamper") {
				const bytes = Buffer.from(f.token, "base64url");
				bytes[0] ^= 1;
				replaceBody(f, `csrf=${bytes.toString("base64url")}&attempt_id=${ATTEMPT}`);
			}
			// Act
			const result = await guardBrowserForm(f.input);
			// Assert
			deny(result, "csrf_invalid", [f.token, f.cookie]);
		},
	);
	it("rejects a forged opaque key at the CSRF gate", async () => {
		// Arrange
		const f = await fixture();
		// Act
		const result = await untyped({ ...f.input, csrfKey: {} });
		// Assert
		deny(result, "csrf_invalid", [f.token, f.cookie]);
	});
});
