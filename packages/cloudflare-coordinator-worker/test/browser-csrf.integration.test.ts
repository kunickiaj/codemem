import { expect, it, vi } from "vitest";
import {
	BROWSER_COOKIE_NAMES,
	type BrowserCookieSecret,
	browserCookieValue,
	issueBrowserCookie,
	readBrowserCookie,
	reissueStartCookieAsTransaction,
} from "../../core/src/coordinator-browser-credential.js";
import {
	type BrowserCsrfKey,
	importBrowserCsrfKey as importKey,
	issueBrowserCsrfToken as issueToken,
	isBrowserCsrfToken as isToken,
	verifyBrowserCsrfToken as verifyToken,
} from "../../core/src/coordinator-browser-csrf.js";

const scope = {
	publicOrigin: "https://app.example.test",
	store: { coordinatorId: "coord-a", revision: "a".repeat(64) },
};
// Public, independent server-key fixture: cookie bytes are message data, never the key.
const rawKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const hmac = { name: "HMAC", hash: "SHA-256" };
function encode(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}
function decode(token: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(atob(`${token.replaceAll("-", "+").replaceAll("_", "/")}==`), (char) =>
		char.charCodeAt(0),
	);
}
it("uses native HMAC for both purposes and round-trips the same Cookie header", async () => {
	// Arrange: no store lookup or browser attribute enforcement is implied by a valid MAC.
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
	const nativeImport = vi.spyOn(crypto.subtle, "importKey");
	const nativeVerify = vi.spyOn(crypto.subtle, "verify");
	const entropy = vi.spyOn(crypto, "getRandomValues");
	try {
		const key = await importKey(rawKey);
		const readerKey = await crypto.subtle.importKey("raw", rawKey, hmac, false, ["sign"]);
		// Act
		for (const purpose of ["transaction", "session"] as const) {
			const cookie = await issueBrowserCookie(purpose);
			const value = browserCookieValue(cookie.secret, purpose);
			const read = await readBrowserCookie(`${BROWSER_COOKIE_NAMES[purpose]}=${value}`, purpose);
			if (read.kind !== "present") throw new Error("Expected present cookie");
			const token = await issueToken(key, cookie.secret, purpose, scope);
			const payload = decode(token);
			const fields = ["codemem-browser-csrf-v1", purpose, "coord-a", scope.publicOrigin];
			const message = new TextEncoder().encode(
				JSON.stringify([...fields, scope.store.revision, value, encode(payload.slice(32))]),
			);
			const expected = new Uint8Array(await crypto.subtle.sign("HMAC", readerKey, message));
			const verified = await verifyToken(key, read.secret, purpose, scope, token);
			const second = await issueToken(key, read.secret, purpose, scope);
			// Assert: independently computed full tag, not a truncated or cookie-derived MAC.
			expect(payload).toHaveLength(64);
			expect(payload.slice(0, 32)).toEqual(expected);
			expect(token).toHaveLength(86);
			expect(isToken(token)).toBe(true);
			expect(isToken(`${token}=`)).toBe(false);
			expect(verified).toBe(true);
			expect(await verifyToken(key, read.secret, purpose, scope, second)).toBe(true);
			expect(token).not.toContain(value);
			expect(token).not.toContain(cookie.cookieHash);
		}
		expect(entropy).toHaveBeenCalledTimes(6);
		expect(nativeVerify).toHaveBeenCalledTimes(4);
		expect(nativeVerify.mock.calls.every(([algorithm]) => algorithm === "HMAC")).toBe(true);
		const imported = await nativeImport.mock.results[0].value;
		expect(imported.extractable).toBe(false);
		expect(imported.algorithm).toEqual({ name: "HMAC", hash: { name: "SHA-256" }, length: 256 });
		expect(imported.usages).toEqual(["sign", "verify"]);
		expect(Object.isFrozen(key)).toBe(true);
		expect(Reflect.ownKeys(key)).toEqual([]);
		expect(JSON.stringify(key)).toBe("{}");
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		entropy.mockRestore();
		nativeVerify.mockRestore();
		nativeImport.mockRestore();
		fetch.mockRestore();
	}
});

it("separates start and promoted transaction MACs even when Request cookies contain identical bytes", async () => {
	// Arrange: independent server key, native workerd HMAC; no route or store authorization.
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
	try {
		const key = await importKey(rawKey);
		const issued = await issueBrowserCookie("start");
		const promoted = reissueStartCookieAsTransaction(issued.secret).split(";")[0];
		const value = browserCookieValue(issued.secret, "start");
		const request = new Request("https://app.example.test", {
			headers: {
				Cookie: `${BROWSER_COOKIE_NAMES.start}=${value}; ${promoted}; ${BROWSER_COOKIE_NAMES.session}=${value}`,
			},
		});
		const purposes = ["start", "transaction", "session"] as const;
		const credentials = await Promise.all(
			purposes.map((purpose) => readBrowserCookie(request.headers.get("Cookie"), purpose)),
		);
		const secrets = credentials.map((credential) => {
			if (credential.kind !== "present") throw new Error("Expected cookie");
			return credential.secret;
		});
		// Act
		const tokens = await Promise.all(
			purposes.map((purpose, index) => issueToken(key, secrets[index], purpose, scope)),
		);
		const valid = await Promise.all(
			purposes.flatMap((purpose, index) =>
				tokens.map((token) => verifyToken(key, secrets[index], purpose, scope, token)),
			),
		);
		// Assert: purpose separation, not different cookie bytes, prevents token interchange.
		expect(valid).toEqual([true, false, false, false, true, false, false, false, true]);
		expect(tokens.every((token) => token.length === 86 && isToken(token))).toBe(true);
		expect(browserCookieValue(issued.secret, "start")).toBe(value);
		expect(
			credentials.every(
				(credential) =>
					credential.kind === "present" && credential.cookieHash === issued.cookieHash,
			),
		).toBe(true);
		expect(() => browserCookieValue(issued.secret, "transaction")).toThrow(
			"auth_browser_credential_invalid_input",
		);
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		fetch.mockRestore();
	}
});
it("denies changed keys, cookies, purposes, scopes, tags, nonces and encodings", async () => {
	// Arrange
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
	try {
		const key = await importKey(rawKey);
		const otherKey = await importKey(new Uint8Array(32).fill(99));
		const cookie = await issueBrowserCookie("transaction");
		const secret = cookie.secret;
		const otherCookie = await issueBrowserCookie("transaction");
		const session = await issueBrowserCookie("session");
		const t = await issueToken(key, secret, "transaction", scope);
		const changes = [0, 32].map((index) => {
			const bytes = decode(t);
			bytes[index] ^= 1;
			return encode(bytes);
		});
		const malformed = [`${t.slice(0, 85)}B`, `${t}=`, `${t}.`, t.slice(1), `${t}A`, null];
		const scopes = [
			{ ...scope, publicOrigin: "https://other.example.test" },
			{ ...scope, store: { ...scope.store, revision: "b".repeat(64) } },
			{ ...scope, store: { ...scope.store, coordinatorId: "coord-b" } },
		];
		// Act
		const valid = await verifyToken(key, secret, "transaction", scope, t);
		const denied = await Promise.all([
			verifyToken(otherKey, secret, "transaction", scope, t),
			verifyToken(key, otherCookie.secret, "transaction", scope, t),
			verifyToken(key, session.secret, "session", scope, t),
			verifyToken(key, secret, "session", scope, t),
			...scopes.map((changed) => verifyToken(key, secret, "transaction", changed, t)),
			...[...changes, ...malformed].map((changed) =>
				verifyToken(key, secret, "transaction", scope, changed),
			),
			...[{}, { ...key }].map((forged) =>
				verifyToken(forged as BrowserCsrfKey, secret, "transaction", scope, t),
			),
			...[{}, { ...secret }].map((forged) =>
				verifyToken(key, forged as BrowserCookieSecret, "transaction", scope, t),
			),
		]);
		// Assert: canonical shape alone does not authenticate a token.
		expect(valid).toBe(true);
		expect(changes.map(isToken)).toEqual([true, true]);
		expect(malformed.map(isToken)).toEqual(malformed.map(() => false));
		expect(denied).toEqual(denied.map(() => false));
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		fetch.mockRestore();
	}
});

it("rejects invalid imports and accessors without evaluation and redacts native failures", async () => {
	// Arrange: replace only explicit native failure boundaries, preserving cookie digest methods.
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
	let entropy: ReturnType<typeof vi.spyOn> | undefined;
	let nativeVerify: ReturnType<typeof vi.spyOn> | undefined;
	try {
		const key = await importKey(rawKey);
		const cookie = await issueBrowserCookie("session");
		const token = await issueToken(key, cookie.secret, "session", scope);
		const getter = vi.fn(() => {
			throw new Error("private getter diagnostic");
		});
		const accessors = { publicOrigin: { get: getter }, oidc: { get: getter } };
		const badScope = Object.defineProperties({ ...scope }, accessors);
		// Act
		const valid = await verifyToken(key, cookie.secret, "session", scope, token);
		const invalidImports = await Promise.all(
			[31, 33].map((size) => importKey(new Uint8Array(size)).catch((error: unknown) => error)),
		);
		const invalidScope = await issueToken(key, cookie.secret, "session", badScope).catch(
			(e: unknown) => e,
		);
		const deniedScope = await verifyToken(key, cookie.secret, "session", badScope, token);
		entropy = vi.spyOn(crypto, "getRandomValues").mockImplementation(() => {
			throw new Error("private entropy diagnostic");
		});
		const failed = await issueToken(key, cookie.secret, "session", scope).catch((e: unknown) => e);
		nativeVerify = vi
			.spyOn(crypto.subtle, "verify")
			.mockRejectedValue(new Error("private verify diagnostic"));
		const deniedNative = await verifyToken(key, cookie.secret, "session", scope, token);
		// Assert
		expect(valid).toBe(true);
		for (const error of [...invalidImports, invalidScope]) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe("auth_browser_csrf_invalid_input");
			expect(error).not.toHaveProperty("cause");
			expect(JSON.stringify(error)).toBe("{}");
		}
		expect(failed).toBeInstanceOf(Error);
		expect((failed as Error).message).toBe("auth_browser_csrf_entropy_failed");
		expect(failed).not.toHaveProperty("cause");
		expect(String(failed)).not.toContain("private entropy diagnostic");
		expect(JSON.stringify(failed)).toBe("{}");
		expect([deniedScope, deniedNative]).toEqual([false, false]);
		expect(getter).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		nativeVerify?.mockRestore();
		entropy?.mockRestore();
		fetch.mockRestore();
	}
});
