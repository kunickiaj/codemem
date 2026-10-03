import { expect, it, vi } from "vitest";
import {
	BROWSER_COOKIE_NAMES,
	browserCookieValue,
	clearBrowserCookie,
	issueBrowserCookie,
	readBrowserCookie,
} from "../../core/src/coordinator-browser-credential.js";

it("round-trips both opaque cookies with workerd SHA-256 and separate Set-Cookie headers", async () => {
	// Arrange: test header strings and runtime crypto, not browser attribute enforcement.
	const kinds = ["transaction", "session"] as const;
	const ages = { transaction: 600, session: 28800 };
	const headers = new Headers();
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
	try {
		// Act
		const issued = await Promise.all(kinds.map(issueBrowserCookie));
		for (const cookie of issued) headers.append("Set-Cookie", cookie.setCookie);
		const results = await Promise.all(
			issued.map(async (cookie, index) => {
				const kind = kinds[index];
				const value = browserCookieValue(cookie.secret, kind);
				const raw = Uint8Array.from(
					atob(`${value.replaceAll("-", "+").replaceAll("_", "/")}=`),
					(character) => character.charCodeAt(0),
				);
				const digest = await crypto.subtle.digest("SHA-256", raw);
				return {
					kind,
					cookie,
					value,
					raw,
					hash: Array.from(new Uint8Array(digest), (byte) =>
						byte.toString(16).padStart(2, "0"),
					).join(""),
					read: await readBrowserCookie(`${BROWSER_COOKIE_NAMES[kind]}=${value}`, kind),
				};
			}),
		);
		// Assert: hashes cover decoded raw bytes, and handles expose no credential metadata.
		expect(BROWSER_COOKIE_NAMES).toEqual({
			transaction: "__Host-codemem-auth-transaction",
			session: "__Host-codemem-session",
		});
		expect(Object.isFrozen(BROWSER_COOKIE_NAMES)).toBe(true);
		expect(headers.getSetCookie()).toEqual(issued.map((cookie) => cookie.setCookie));
		for (const { kind, cookie, value, raw, hash, read } of results) {
			expect(raw).toHaveLength(32);
			expect(value).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
			expect(cookie.cookieHash).toMatch(/^[a-f0-9]{64}$/);
			expect(cookie.cookieHash).toBe(hash);
			expect(cookie.setCookie).toBe(
				`${BROWSER_COOKIE_NAMES[kind]}=${value}; Max-Age=${ages[kind]}; Path=/; Secure; HttpOnly; SameSite=Lax`,
			);
			expect(clearBrowserCookie(kind)).toBe(
				`${BROWSER_COOKIE_NAMES[kind]}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`,
			);
			expect(read.kind).toBe("present");
			if (read.kind !== "present") throw new Error("Expected present cookie");
			expect(read.cookieHash).toBe(hash);
			expect(browserCookieValue(read.secret, kind)).toBe(value);
			for (const secret of [cookie.secret, read.secret]) {
				expect(Object.isFrozen(secret)).toBe(true);
				expect(Reflect.ownKeys(secret)).toEqual([]);
				expect(JSON.stringify(secret)).toBe("{}");
				expect(Reflect.set(secret, "value", value)).toBe(false);
			}
			expect(cookie.setCookie).not.toContain("Domain=");
		}
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		fetch.mockRestore();
	}
});

it("rejects known-cookie ambiguity and malformed encodings after actual Headers merging", async () => {
	// Arrange: canonical fixture bytes are public test data, never provider credentials.
	const value = "A".repeat(43);
	const transaction = `${BROWSER_COOKIE_NAMES.transaction}=${value}`;
	const session = `${BROWSER_COOKIE_NAMES.session}=${value}`;
	const headers = new Headers();
	headers.append("Cookie", transaction);
	headers.append("Cookie", transaction);
	const coerce = vi.fn(() => transaction);
	const malformed = [
		`${BROWSER_COOKIE_NAMES.transaction.toLowerCase()}=${value}`,
		`${transaction}=`,
		`${BROWSER_COOKIE_NAMES.transaction}=%41${value.slice(1)}`,
		`${BROWSER_COOKIE_NAMES.transaction}=${value.slice(0, -1)}B`,
		`${transaction}; ${BROWSER_COOKIE_NAMES.session}=bad`,
		`unknown=${"x".repeat(8193)}`,
		{ toString: coerce },
	];
	const duplicate = [
		`${transaction}; ${transaction}`,
		`${transaction}; ${BROWSER_COOKIE_NAMES.transaction.toLowerCase()}=${value}`,
		`${transaction}; ${session}; ${session}`,
	];
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
	try {
		// Act
		const valid = await readBrowserCookie(`other=ok; ${transaction}; ${session}`, "transaction");
		const absent = await Promise.all(
			[undefined, null, "", " \t", session].map((header) =>
				readBrowserCookie(header, "transaction"),
			),
		);
		const invalid = await Promise.all(
			malformed.map((header) => readBrowserCookie(header, "transaction")),
		);
		const duplicates = await Promise.all(
			duplicate.map((header) => readBrowserCookie(header, "transaction")),
		);
		const merged = await readBrowserCookie(headers.get("Cookie"), "transaction");
		// Assert: both known kinds are checked even when only one kind is requested.
		expect(valid.kind).toBe("present");
		expect(absent).toEqual(Array(5).fill({ kind: "absent" }));
		expect(invalid).toEqual(malformed.map(() => ({ kind: "invalid", error: "cookie_malformed" })));
		expect(duplicates).toEqual(
			duplicate.map(() => ({ kind: "invalid", error: "cookie_duplicate" })),
		);
		expect(merged.kind).toBe("invalid");
		expect(coerce).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		fetch.mockRestore();
	}
});

it("requires kind-bound issued handles and redacts a workerd entropy failure", async () => {
	// Arrange: real crypto succeeds first; only the explicit failure boundary is mocked.
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
	let entropy: ReturnType<typeof vi.spyOn> | undefined;
	try {
		const issued = await issueBrowserCookie("session");
		const forged = [{}, { ...issued.secret }, JSON.parse(JSON.stringify(issued.secret))];
		// Act
		const value = browserCookieValue(issued.secret, "session");
		const accessors = forged.map((secret) => () => browserCookieValue(secret, "session"));
		const crossKind = () => browserCookieValue(issued.secret, "transaction");
		entropy = vi.spyOn(crypto, "getRandomValues").mockImplementation(() => {
			throw new Error("private entropy diagnostic");
		});
		const failed = await issueBrowserCookie("transaction").catch((error: unknown) => error);
		// Assert: copied or deserialized metadata cannot recover the credential.
		expect(value).toHaveLength(43);
		for (const accessor of [...accessors, crossKind]) {
			expect(accessor).toThrow("auth_browser_credential_invalid_input");
		}
		expect(failed).toBeInstanceOf(Error);
		expect((failed as Error).message).toBe("auth_browser_credential_entropy_failed");
		expect(failed).not.toHaveProperty("cause");
		expect(String(failed)).not.toContain("private entropy diagnostic");
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		entropy?.mockRestore();
		fetch.mockRestore();
	}
});
