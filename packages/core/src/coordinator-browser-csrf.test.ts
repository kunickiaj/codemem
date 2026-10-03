import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BROWSER_COOKIE_NAMES,
	type BrowserCookieSecret,
	browserCookieValue,
	readBrowserCookie,
} from "./coordinator-browser-credential.js";
import {
	importBrowserCsrfKey,
	isBrowserCsrfToken,
	issueBrowserCsrfToken,
	verifyBrowserCsrfToken,
} from "./coordinator-browser-csrf.js";

const PURPOSES = ["transaction", "session"] as const;
type Purpose = (typeof PURPOSES)[number];
type Key = Awaited<ReturnType<typeof importBrowserCsrfKey>>;
type Scope = Parameters<typeof issueBrowserCsrfToken>[3];
const RAW_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const PRIVATE_ERROR = "synthetic-private-crypto-detail";
const INVALID = "auth_browser_csrf_invalid_input";

beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	try {
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		vi.restoreAllMocks();
	}
});

function scope(): Scope {
	return {
		publicOrigin: "https://coordinator.example",
		store: { coordinatorId: "coordinator-fixture", revision: "a".repeat(64) },
	};
}
async function cookie(purpose: Purpose, byte = 17) {
	const value = Buffer.alloc(32, byte).toString("base64url");
	const result = await readBrowserCookie(`${BROWSER_COOKIE_NAMES[purpose]}=${value}`, purpose);
	if (result.kind !== "present") throw new Error("fixture cookie missing");
	return result;
}
function entropy() {
	let frame = 0;
	return vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
		if (!(array instanceof Uint8Array)) throw new Error("expected byte array");
		array.fill(++frame);
		return array;
	});
}
function message(purpose: Purpose, binding: Scope, value: string, nonce: Uint8Array): string {
	return JSON.stringify([
		"codemem-browser-csrf-v1",
		purpose,
		binding.store.coordinatorId,
		binding.publicOrigin,
		binding.store.revision,
		value,
		Buffer.from(nonce).toString("base64url"),
	]);
}
function oracle(token: string, purpose: Purpose, binding: Scope, value: string, raw = RAW_KEY) {
	const bytes = Buffer.from(token, "base64url");
	const expected = createHmac("sha256", raw)
		.update(message(purpose, binding, value, bytes.subarray(32)), "utf8")
		.digest();
	expect(bytes.length).toBe(64);
	expect(bytes.subarray(0, 32)).toEqual(expected);
}
function opaque(value: Key): void {
	expect(Object.isFrozen(value)).toBe(true);
	expect(Reflect.ownKeys(value)).toEqual([]);
	expect(JSON.stringify(value)).toBe("{}");
}
async function fixture(purpose: Purpose) {
	const credential = await cookie(purpose);
	const key = await importBrowserCsrfKey(RAW_KEY.slice());
	const binding = scope();
	entropy();
	const token = await issueBrowserCsrfToken(key, credential.secret, purpose, binding);
	return { key, credential, binding, token };
}

describe("browser CSRF key import", () => {
	it("imports an independent nonextractable HMAC key behind an empty frozen handle", async () => {
		// Arrange
		const nativeImport = vi.spyOn(crypto.subtle, "importKey");
		const rng = vi.spyOn(crypto, "getRandomValues");
		// Act
		const key = await importBrowserCsrfKey(RAW_KEY.slice());
		const imported = await nativeImport.mock.results[0]?.value;
		// Assert
		opaque(key);
		expect(nativeImport).toHaveBeenCalledWith(
			"raw",
			RAW_KEY,
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign", "verify"],
		);
		expect(imported.extractable).toBe(false);
		expect(imported.algorithm).toMatchObject({ name: "HMAC", hash: { name: "SHA-256" } });
		expect(imported.usages).toEqual(["sign", "verify"]);
		expect(rng).not.toHaveBeenCalled();
	});
	it("copies raw bytes before asynchronous import completes", async () => {
		// Arrange: controlled completion, no timers.
		const raw = RAW_KEY.slice();
		const nativeImport = crypto.subtle.importKey.bind(crypto.subtle);
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.spyOn(crypto.subtle, "importKey").mockImplementation(async (...args) => {
			await gate;
			return nativeImport(...args);
		});
		const credential = await cookie("session");
		entropy();
		// Act
		const pending = importBrowserCsrfKey(raw);
		raw.fill(99);
		release?.();
		const key = await pending;
		const token = await issueBrowserCsrfToken(key, credential.secret, "session", scope());
		// Assert
		oracle(token, "session", scope(), browserCookieValue(credential.secret, "session"));
	});
	it.each([
		undefined,
		null,
		{},
		Array(32).fill(1),
		new DataView(new ArrayBuffer(32)),
		new Uint8Array(31),
		new Uint8Array(33),
		new Proxy(new Uint8Array(32), {}),
	])("rejects invalid raw key %j without importing or drawing entropy", async (input) => {
		// Arrange
		const nativeImport = vi.spyOn(crypto.subtle, "importKey");
		const rng = vi.spyOn(crypto, "getRandomValues");
		// Act
		const pending = importBrowserCsrfKey(input as Uint8Array<ArrayBuffer>);
		// Assert
		await expect(pending).rejects.toThrow(new Error(INVALID));
		expect(nativeImport).not.toHaveBeenCalled();
		expect(rng).not.toHaveBeenCalled();
	});
	it("rejects a detached raw key", async () => {
		// Arrange
		const raw = RAW_KEY.slice();
		structuredClone(raw, { transfer: [raw.buffer] });
		// Act
		const pending = importBrowserCsrfKey(raw);
		// Assert
		await expect(pending).rejects.toThrow(new Error(INVALID));
	});
	it("redacts native import failures", async () => {
		// Arrange
		vi.spyOn(crypto.subtle, "importKey").mockRejectedValue(new Error(PRIVATE_ERROR));
		// Act
		const pending = importBrowserCsrfKey(RAW_KEY.slice());
		// Assert
		await expect(pending).rejects.toThrow(new Error("auth_browser_csrf_crypto_failed"));
	});
});

describe("browser CSRF native key view snapshots", () => {
	it("rejects a native 31-byte subclass without reading its advertised 32-byte length", async () => {
		// Arrange
		const getter = vi.fn(() => 32);
		class Sub extends Uint8Array {
			get byteLength() {
				return getter();
			}
		}
		const raw = new Sub(31);
		const nativeImport = vi.spyOn(crypto.subtle, "importKey");
		// Act
		const pending = importBrowserCsrfKey(raw);
		// Assert
		await expect(pending).rejects.toThrow(new Error(INVALID));
		expect(getter).not.toHaveBeenCalled();
		expect(nativeImport).not.toHaveBeenCalled();
	});
	it("accepts a native 32-byte subclass without reading a throwing own length getter", async () => {
		// Arrange
		class Sub extends Uint8Array {}
		const raw = new Sub(RAW_KEY);
		const getter = vi.fn(() => {
			throw new Error(PRIVATE_ERROR);
		});
		Object.defineProperty(raw, "byteLength", { get: getter });
		const credential = await cookie("session");
		entropy();
		// Act
		const key = await importBrowserCsrfKey(raw);
		const token = await issueBrowserCsrfToken(key, credential.secret, "session", scope());
		// Assert
		opaque(key);
		oracle(token, "session", scope(), browserCookieValue(credential.secret, "session"));
		expect(getter).not.toHaveBeenCalled();
	});
	it("copies a shared-buffer view synchronously before import awaits", async () => {
		// Arrange: this proves a synchronous snapshot, not atomicity against another thread.
		const raw = new Uint8Array(new SharedArrayBuffer(32));
		raw.set(RAW_KEY);
		const nativeImport = crypto.subtle.importKey.bind(crypto.subtle);
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.spyOn(crypto.subtle, "importKey").mockImplementation(async (...args) => {
			await gate;
			return nativeImport(...args);
		});
		const credential = await cookie("session");
		entropy();
		// Act
		const pending = importBrowserCsrfKey(raw);
		raw.fill(99);
		release?.();
		const key = await pending;
		const token = await issueBrowserCsrfToken(key, credential.secret, "session", scope());
		// Assert
		oracle(token, "session", scope(), browserCookieValue(credential.secret, "session"));
	});
});

function registerTokenTests(purpose: Purpose): void {
	it("issues the exact independent HMAC frame and verifies it natively", async () => {
		// Arrange
		const credential = await cookie(purpose);
		const key = await importBrowserCsrfKey(RAW_KEY.slice());
		const binding = scope();
		const rng = entropy();
		const sign = vi.spyOn(crypto.subtle, "sign");
		const verify = vi.spyOn(crypto.subtle, "verify");
		// Act
		const token = await issueBrowserCsrfToken(key, credential.secret, purpose, binding);
		const valid = await verifyBrowserCsrfToken(key, credential.secret, purpose, binding, token);
		// Assert: MAC validity is not live-store authorization or a time-window proof.
		expect(valid).toBe(true);
		expect(isBrowserCsrfToken(token)).toBe(true);
		expect(token).toMatch(/^[A-Za-z0-9_-]{85}[AQgw]$/);
		oracle(token, purpose, binding, browserCookieValue(credential.secret, purpose));
		expect(rng).toHaveBeenCalledTimes(1);
		expect(rng.mock.calls[0]?.[0]?.byteLength).toBe(32);
		expect(sign.mock.calls[0]?.[0]).toBe("HMAC");
		expect(verify.mock.calls[0]?.[0]).toBe("HMAC");
		expect(verify.mock.calls[0]?.[1]).toBe(sign.mock.calls[0]?.[1]);
		expect(new Uint8Array(verify.mock.calls[0]?.[2] as ArrayBuffer)).toEqual(
			new Uint8Array(Buffer.from(token, "base64url").subarray(0, 32)),
		);
		const serialized = JSON.stringify({ token, key });
		expect(serialized).not.toContain(browserCookieValue(credential.secret, purpose));
		expect(serialized).not.toContain(credential.cookieHash);
	});
	it("draws fresh nonce frames and recomputes each MAC", async () => {
		// Arrange
		const { key, credential, binding, token } = await fixture(purpose);
		// Act
		const next = await issueBrowserCsrfToken(key, credential.secret, purpose, binding);
		// Assert
		expect(Buffer.from(token, "base64url").subarray(32)).toEqual(Buffer.alloc(32, 1));
		expect(Buffer.from(next, "base64url").subarray(32)).toEqual(Buffer.alloc(32, 2));
		expect(next).not.toBe(token);
		oracle(next, purpose, binding, browserCookieValue(credential.secret, purpose));
	});
	it("rejects a bit change in every MAC and nonce byte", async () => {
		// Arrange
		const { key, credential, binding, token } = await fixture(purpose);
		const variants = Array.from({ length: 64 }, (_, index) => {
			const bytes = Buffer.from(token, "base64url");
			bytes[index] = (bytes[index] ?? 0) ^ 1;
			return bytes.toString("base64url");
		});
		// Act
		const results = await Promise.all(
			variants.map((value) =>
				verifyBrowserCsrfToken(key, credential.secret, purpose, binding, value),
			),
		);
		// Assert
		expect(results).toEqual(Array(64).fill(false));
	});
	it.each(["cookie", "kind", "key", "coordinator", "origin", "revision"])(
		"rejects independent %s binding mismatch",
		async (field) => {
			// Arrange
			const { key, credential, binding, token } = await fixture(purpose);
			let candidateKey = key;
			let secret = credential.secret;
			if (field === "cookie") secret = (await cookie(purpose, 18)).secret;
			if (field === "kind")
				secret = (await cookie(purpose === "session" ? "transaction" : "session")).secret;
			if (field === "key") candidateKey = await importBrowserCsrfKey(new Uint8Array(32).fill(88));
			if (field === "coordinator") binding.store.coordinatorId = "other-coordinator";
			if (field === "origin") binding.publicOrigin = "https://other.example";
			if (field === "revision") binding.store.revision = "b".repeat(64);
			// Act
			const result = await verifyBrowserCsrfToken(candidateKey, secret, purpose, binding, token);
			// Assert
			expect(result).toBe(false);
		},
	);
}

function registerHandleTests(purpose: Purpose): void {
	it.each(["empty", "spread", "clone", "proxy", "native"])(
		"rejects %s key handles without accepting arbitrary CryptoKeys",
		async (variant) => {
			// Arrange
			const { key, credential, binding, token } = await fixture(purpose);
			const handles: Record<string, unknown> = {
				empty: {},
				spread: { ...key },
				clone: structuredClone(key),
				proxy: new Proxy(key, {}),
				native: await crypto.subtle.importKey(
					"raw",
					RAW_KEY,
					{ name: "HMAC", hash: "SHA-256" },
					false,
					["sign", "verify"],
				),
			};
			// Act
			const rejected = issueBrowserCsrfToken(
				handles[variant] as Key,
				credential.secret,
				purpose,
				binding,
			);
			const result = await verifyBrowserCsrfToken(
				handles[variant] as Key,
				credential.secret,
				purpose,
				binding,
				token,
			);
			// Assert
			await expect(rejected).rejects.toThrow(new Error(INVALID));
			expect(result).toBe(false);
		},
	);
	it.each(["forged", "spread", "clone", "proxy", "wrong-kind"])(
		"rejects %s cookie handles",
		async (variant) => {
			// Arrange
			const { key, credential, binding, token } = await fixture(purpose);
			const handles: Record<string, unknown> = {
				forged: {},
				spread: { ...credential.secret },
				clone: structuredClone(credential.secret),
				proxy: new Proxy(credential.secret, {}),
				"wrong-kind": (await cookie(purpose === "session" ? "transaction" : "session")).secret,
			};
			// Act
			const pending = issueBrowserCsrfToken(
				key,
				handles[variant] as BrowserCookieSecret,
				purpose,
				binding,
			);
			const valid = await verifyBrowserCsrfToken(
				key,
				handles[variant] as BrowserCookieSecret,
				purpose,
				binding,
				token,
			);
			// Assert
			await expect(pending).rejects.toThrow(new Error(INVALID));
			expect(valid).toBe(false);
		},
	);
}

const BAD_ORIGINS = [
	"",
	"https://coordinator.example/",
	"https://coordinator.example/callback",
	"https://coordinator.example?x=1",
	"https://coordinator.example#x",
	"https://user@coordinator.example",
	"http://coordinator.example",
	" https://coordinator.example",
	"https://COORDINATOR.example",
	"https://coordinator.example:443",
	"https:\\coordinator.example",
];
function registerScopeTests(purpose: Purpose): void {
	it.each(BAD_ORIGINS)("rejects noncanonical origin %j", async (origin) => {
		// Arrange
		const { key, credential, binding, token } = await fixture(purpose);
		binding.publicOrigin = origin;
		// Act
		const pending = issueBrowserCsrfToken(key, credential.secret, purpose, binding);
		const valid = await verifyBrowserCsrfToken(key, credential.secret, purpose, binding, token);
		// Assert
		await expect(pending).rejects.toThrow(new Error(INVALID));
		expect(valid).toBe(false);
	});
	it.each(["", " a", "x\n", "x\u200b", "x".repeat(257)])("rejects coordinator %j", async (id) => {
		// Arrange
		const { key, credential, binding, token } = await fixture(purpose);
		binding.store.coordinatorId = id;
		// Act
		const valid = await verifyBrowserCsrfToken(key, credential.secret, purpose, binding, token);
		// Assert
		await expect(issueBrowserCsrfToken(key, credential.secret, purpose, binding)).rejects.toThrow(
			INVALID,
		);
		expect(valid).toBe(false);
	});
	it.each([
		"a".repeat(63),
		"a".repeat(65),
		"A".repeat(64),
		Symbol("private"),
		4,
		...["\n", "\r", "\r\n", "\u2028", "\u2029"].map((ending) => `${"a".repeat(64)}${ending}`),
	])("rejects revision %j without coercion", async (revision) => {
		// Arrange
		const { key, credential, binding, token } = await fixture(purpose);
		const bad = { ...binding, store: { ...binding.store, revision } } as Scope;
		// Act
		const valid = await verifyBrowserCsrfToken(key, credential.secret, purpose, bad, token);
		// Assert
		await expect(issueBrowserCsrfToken(key, credential.secret, purpose, bad)).rejects.toThrow(
			new Error(INVALID),
		);
		expect(valid).toBe(false);
	});
}

function registerReflectionTests(purpose: Purpose): void {
	it.each(["origin-getter", "store-getter", "revision-getter", "inherited", "array", "proxy"])(
		"rejects %s scope without evaluating accessors",
		async (variant) => {
			// Arrange
			const { key, credential, binding, token } = await fixture(purpose);
			const getter = vi.fn(() => {
				throw new Error(PRIVATE_ERROR);
			});
			const cases = {
				"origin-getter": Object.defineProperty(scope(), "publicOrigin", { get: getter }),
				"store-getter": Object.defineProperty(scope(), "store", { get: getter }),
				"revision-getter": {
					...binding,
					store: Object.defineProperty({ ...binding.store }, "revision", { get: getter }),
				},
				inherited: Object.create(binding),
				array: Object.assign([], binding),
				proxy: new Proxy(binding, {
					getOwnPropertyDescriptor() {
						throw new Error(PRIVATE_ERROR);
					},
				}),
			};
			const bad = cases[variant as keyof typeof cases] as Scope;
			// Act
			const pending = issueBrowserCsrfToken(key, credential.secret, purpose, bad);
			const valid = await verifyBrowserCsrfToken(key, credential.secret, purpose, bad, token);
			// Assert
			await expect(pending).rejects.toThrow(new Error(INVALID));
			expect(valid).toBe(false);
			expect(getter).not.toHaveBeenCalled();
		},
	);
	it("snapshots scope before await and never reads OIDC or client secrets", async () => {
		// Arrange
		const { key, credential } = await fixture(purpose);
		const binding = scope();
		const original = scope();
		const getter = vi.fn(() => {
			throw new Error(PRIVATE_ERROR);
		});
		Object.defineProperties(binding, { oidc: { get: getter }, clientSecret: { get: getter } });
		const nativeSign = crypto.subtle.sign.bind(crypto.subtle);
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
			await gate;
			return nativeSign(...args);
		});
		// Act
		const pending = issueBrowserCsrfToken(key, credential.secret, purpose, binding);
		binding.publicOrigin = "https://changed.example";
		binding.store.revision = "b".repeat(64);
		binding.store.coordinatorId = "changed";
		release?.();
		const token = await pending;
		// Assert
		oracle(token, purpose, original, browserCookieValue(credential.secret, purpose));
		expect(getter).not.toHaveBeenCalled();
	});
}

function registerFailureTests(purpose: Purpose): void {
	it.each(["entropy", "sign"])("redacts %s failures", async (operation) => {
		// Arrange
		const { key, credential, binding } = await fixture(purpose);
		if (operation === "entropy")
			vi.mocked(crypto.getRandomValues).mockImplementation(() => {
				throw new Error(PRIVATE_ERROR);
			});
		else vi.spyOn(crypto.subtle, "sign").mockRejectedValue(new Error(PRIVATE_ERROR));
		// Act
		const pending = issueBrowserCsrfToken(key, credential.secret, purpose, binding);
		// Assert
		const code = operation === "entropy" ? "entropy_failed" : "crypto_failed";
		await expect(pending).rejects.toThrow(new Error(`auth_browser_csrf_${code}`));
	});
	it("returns false rather than exposing native verify errors", async () => {
		// Arrange
		const { key, credential, binding, token } = await fixture(purpose);
		vi.spyOn(crypto.subtle, "verify").mockRejectedValue(new Error(PRIVATE_ERROR));
		// Act
		const result = await verifyBrowserCsrfToken(key, credential.secret, purpose, binding, token);
		// Assert
		expect(result).toBe(false);
	});
}

for (const purpose of PURPOSES) {
	describe(`browser CSRF ${purpose}`, () => {
		registerTokenTests(purpose);
		registerHandleTests(purpose);
		registerScopeTests(purpose);
		registerReflectionTests(purpose);
		registerFailureTests(purpose);
	});
}

describe("canonical CSRF token predicate", () => {
	it("does not decode oversized values or coerce hostile objects", () => {
		// Arrange
		const decode = vi.spyOn(globalThis, "atob");
		const coercion = vi.fn(() => {
			throw new Error(PRIVATE_ERROR);
		});
		const inputs = ["A".repeat(1_000_000), { toString: coercion, [Symbol.toPrimitive]: coercion }];
		// Act
		const results = inputs.map(isBrowserCsrfToken);
		// Assert
		expect(results).toEqual([false, false]);
		expect(decode).not.toHaveBeenCalled();
		expect(coercion).not.toHaveBeenCalled();
	});
	it.each(["A", "Q", "g", "w"])("accepts canonical final bits %s", (last) => {
		// Arrange
		const value = `${"A".repeat(85)}${last}`;
		// Act
		const valid = isBrowserCsrfToken(value);
		// Assert
		expect(valid).toBe(true);
		expect(Buffer.from(value, "base64url").toString("base64url")).toBe(value);
	});
	it.each([
		undefined,
		null,
		86,
		{},
		"A".repeat(85),
		"A".repeat(87),
		"A".repeat(1_000_000),
		`${"A".repeat(85)}B`,
		`${"A".repeat(85)}=`,
		`${"A".repeat(85)}.`,
		`${"A".repeat(85)}\n`,
		`${"A".repeat(85)}é`,
		`${"A".repeat(84)}+A`,
		`${"A".repeat(84)}/A`,
	])("rejects malformed token case %# before native verification", async (value) => {
		// Arrange
		const { key, credential, binding } = await fixture("session");
		const verify = vi.spyOn(crypto.subtle, "verify");
		// Act
		const shape = isBrowserCsrfToken(value);
		const valid = await verifyBrowserCsrfToken(key, credential.secret, "session", binding, value);
		// Assert
		expect(shape).toBe(false);
		expect(valid).toBe(false);
		expect(verify).not.toHaveBeenCalled();
	});
});
