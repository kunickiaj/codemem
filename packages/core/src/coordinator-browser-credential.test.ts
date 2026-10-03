import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BROWSER_COOKIE_HEADER_MAX_BYTES,
	BROWSER_COOKIE_NAMES,
	browserCookieValue,
	clearBrowserCookie,
	issueBrowserCookie,
	readBrowserCookie,
} from "./coordinator-browser-credential.js";

const KINDS = ["transaction", "session"] as const;
type CookieKind = (typeof KINDS)[number];
const ZERO_VALUE = "A".repeat(43);
const ZERO_HASH = "66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925";
const PRIVATE_ERROR = "synthetic-private-crypto-detail";

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

function cookie(kind: CookieKind, value = ZERO_VALUE): string {
	return `${BROWSER_COOKIE_NAMES[kind]}=${value}`;
}
function otherKind(kind: CookieKind): CookieKind {
	if (kind === "transaction") return "session";
	return "transaction";
}
function zeroEntropy() {
	return vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
		if (!(array instanceof Uint8Array)) throw new Error("expected byte array");
		array.fill(0);
		return array;
	});
}
function assertOpaque(secret: unknown): void {
	expect(Object.isFrozen(secret)).toBe(true);
	expect(Reflect.ownKeys(secret as object)).toEqual([]);
	expect(JSON.stringify(secret)).toBe("{}");
}

function registerIssuanceTests(kind: CookieKind): void {
	it("issues a canonical secret and commits to raw bytes, not the encoded string", async () => {
		// Arrange: deterministic entropy; independent Node hash oracle.
		const entropy = zeroEntropy();
		const expectedHash = createHash("sha256").update(new Uint8Array(32)).digest("hex");
		// Act
		const result = await issueBrowserCookie(kind);
		const value = browserCookieValue(result.secret, kind);
		// Assert: cookie parsing is not authentication or persistence.
		expect(entropy).toHaveBeenCalledTimes(1);
		expect(entropy.mock.calls[0]?.[0]).toBeInstanceOf(Uint8Array);
		expect(entropy.mock.calls[0]?.[0]?.byteLength).toBe(32);
		expect(value).toBe(ZERO_VALUE);
		expect(value).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
		expect(result.cookieHash).toBe(expectedHash);
		expect(result.cookieHash).toBe(ZERO_HASH);
		expect(result.cookieHash).not.toBe(createHash("sha256").update(value).digest("hex"));
		assertOpaque(result.secret);
	});
	it("sets only the fixed host-only attributes and lifetime", async () => {
		// Arrange: these are header fixtures, not live browser prefix/expiry checks.
		zeroEntropy();
		const maxAge = { transaction: 600, session: 28800 }[kind];
		// Act
		const result = await issueBrowserCookie(kind);
		const attributes = result.setCookie.split("; ");
		// Assert
		expect(attributes[0]).toBe(cookie(kind));
		expect(attributes.slice(1).sort()).toEqual(
			["Secure", "HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${maxAge}`].sort(),
		);
		expect(result.setCookie).not.toMatch(/Domain=|Expires=/i);
	});
	it("draws a fresh 32-byte frame per call without adopting request credentials", async () => {
		// Arrange: distinct counter frames avoid probabilistic uniqueness assertions.
		let frame = 0;
		const entropy = vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
			if (!(array instanceof Uint8Array)) throw new Error("expected byte array");
			array.fill(++frame);
			return array;
		});
		const requestSecret = await readBrowserCookie(cookie(kind), kind);
		// Act
		const first = await issueBrowserCookie(kind);
		const second = await issueBrowserCookie(kind);
		// Assert
		expect(requestSecret.kind).toBe("present");
		expect(entropy).toHaveBeenCalledTimes(2);
		expect(entropy.mock.calls.map(([array]) => array?.byteLength)).toEqual([32, 32]);
		expect(entropy.mock.calls[0]?.[0]).not.toBe(entropy.mock.calls[1]?.[0]);
		expect(browserCookieValue(first.secret, kind)).not.toBe(ZERO_VALUE);
		expect(browserCookieValue(second.secret, kind)).not.toBe(
			browserCookieValue(first.secret, kind),
		);
		expect(second.cookieHash).not.toBe(first.cookieHash);
	});
	it("clears an empty value with zero age and the same host-only attributes", () => {
		// Arrange
		const expected = [
			`${BROWSER_COOKIE_NAMES[kind]}=`,
			"Secure",
			"HttpOnly",
			"SameSite=Lax",
			"Path=/",
			"Max-Age=0",
		];
		// Act
		const header = clearBrowserCookie(kind);
		// Assert
		expect(header.split("; ").sort()).toEqual(expected.sort());
		expect(clearBrowserCookie(kind)).toBe(header);
	});
}

function registerParsingTests(kind: CookieKind): void {
	it.each([undefined, null, "", " ", "\t", " \t "])(
		"treats absent/OWS input %j as absent",
		async (header) => {
			// Arrange
			const digest = vi.spyOn(crypto.subtle, "digest");
			// Act
			const result = await readBrowserCookie(header, kind);
			// Assert
			expect(result).toEqual({ kind: "absent" });
			expect(digest).not.toHaveBeenCalled();
		},
	);
	it.each(["theme=dark", "other=a=b", "!#$%&'*+-.^_`|~=value", " \tother=value\t ", 'other="x"'])(
		"ignores valid unknown cookies: %s",
		async (header) => {
			// Arrange
			const digest = vi.spyOn(crypto.subtle, "digest");
			// Act
			const result = await readBrowserCookie(header, kind);
			// Assert
			expect(result).toEqual({ kind: "absent" });
			expect(digest).not.toHaveBeenCalled();
		},
	);
	it("reads both known names with OWS into kind-bound opaque handles", async () => {
		// Arrange
		const header = ` \t${cookie("transaction")} \t;\t ${cookie("session")}\t; theme=dark `;
		const entropy = vi.spyOn(crypto, "getRandomValues");
		// Act
		const result = await readBrowserCookie(header, kind);
		// Assert
		expect(result.kind).toBe("present");
		if (result.kind !== "present") throw new Error("expected present cookie");
		expect(result.cookieHash).toBe(ZERO_HASH);
		expect(browserCookieValue(result.secret, kind)).toBe(ZERO_VALUE);
		expect(() => browserCookieValue(result.secret, otherKind(kind))).toThrow("invalid_input");
		assertOpaque(result.secret);
		expect(entropy).not.toHaveBeenCalled();
	});
	it("returns the same raw-byte commitment when issuance is read back", async () => {
		// Arrange
		zeroEntropy();
		const issued = await issueBrowserCookie(kind);
		// Act
		const result = await readBrowserCookie(issued.setCookie.split(";")[0], kind);
		// Assert
		expect(result.kind).toBe("present");
		if (result.kind !== "present") throw new Error("expected present cookie");
		expect(result.cookieHash).toBe(issued.cookieHash);
		expect(result.secret).not.toBe(issued.secret);
		expect(browserCookieValue(result.secret, kind)).toBe(browserCookieValue(issued.secret, kind));
	});
	it.each(KINDS)(
		"rejects duplicates of %s even when reading another name",
		async (duplicateKind) => {
			// Arrange
			const header = `${cookie(duplicateKind)}; ${cookie(duplicateKind)}`;
			const digest = vi.spyOn(crypto.subtle, "digest");
			// Act
			const result = await readBrowserCookie(header, kind);
			// Assert
			expect(result).toEqual({ kind: "invalid", error: "cookie_duplicate" });
			expect(digest).not.toHaveBeenCalled();
		},
	);
	it.each(KINDS)("rejects case variants of the known %s name", async (variantKind) => {
		// Arrange
		const header = `${BROWSER_COOKIE_NAMES[variantKind].toUpperCase()}=${ZERO_VALUE}`;
		// Act
		const result = await readBrowserCookie(header, kind);
		// Assert
		expect(result).toEqual({ kind: "invalid", error: "cookie_malformed" });
	});
	it("rejects duplicate known names appended as multiple Cookie headers", async () => {
		// Arrange: Node combines Cookie specially with semicolons, not commas.
		const headers = new Headers();
		headers.append("Cookie", cookie(kind));
		headers.append("Cookie", cookie(kind));
		// Act
		const result = await readBrowserCookie(headers.get("Cookie"), kind);
		// Assert
		expect(result).toEqual({ kind: "invalid", error: "cookie_duplicate" });
	});
	it("rejects comma-merged known cookies from generic header intermediaries", async () => {
		// Arrange: literal fixture preserves the comma form Node Headers normalizes away.
		const header = `${cookie(kind)}, ${cookie(otherKind(kind))}`;
		// Act
		const result = await readBrowserCookie(header, kind);
		// Assert
		expect(result).toEqual({ kind: "invalid", error: "cookie_malformed" });
	});
	it.each([..."AEIMQUYcgkosw048"])("accepts canonical last-bit character %s", async (last) => {
		// Arrange
		const value = `${ZERO_VALUE.slice(0, 42)}${last}`;
		const expectedHash = createHash("sha256").update(Buffer.from(value, "base64url")).digest("hex");
		// Act
		const result = await readBrowserCookie(cookie(kind, value), kind);
		// Assert
		expect(result.kind).toBe("present");
		if (result.kind !== "present") throw new Error("expected present cookie");
		expect(browserCookieValue(result.secret, kind)).toBe(value);
		expect(result.cookieHash).toBe(expectedHash);
	});
}

function registerMalformedTests(kind: CookieKind): void {
	it("rejects an exact-limit hostile whitespace run without regex replacement", async () => {
		// Arrange: the former end-anchored OWS regex backtracked across this interior run.
		const header = `a${" ".repeat(8190)}b`;
		let result: Awaited<ReturnType<typeof readBrowserCookie>>;
		let replacementCalls = 0;
		const replace = vi.spyOn(String.prototype, "replace");
		// Act: pass through native replacement and isolate instrumentation from assertions.
		try {
			result = await readBrowserCookie(header, kind);
			replacementCalls = replace.mock.calls.length;
		} finally {
			replace.mockRestore();
		}
		// Assert: deterministic regression guard, not a wall-clock performance claim.
		expect(header.length).toBe(8192);
		expect(result).toEqual({ kind: "invalid", error: "cookie_malformed" });
		expect(replacementCalls).toBe(0);
	});
	const badValues = [
		"",
		"A".repeat(42),
		"A".repeat(44),
		`${ZERO_VALUE}=`,
		`%41${ZERO_VALUE.slice(1)}`,
		`"${ZERO_VALUE}"`,
		`+${ZERO_VALUE.slice(1)}`,
		`/${ZERO_VALUE.slice(1)}`,
		`-${ZERO_VALUE.slice(1, 42)}B`,
		`${ZERO_VALUE.slice(0, 42)}B`,
		`${ZERO_VALUE.slice(0, 42)}_`,
		`${ZERO_VALUE.slice(0, 20)}\t${ZERO_VALUE.slice(21)}`,
	];
	it.each(badValues)(
		"rejects noncanonical known credential %j without echoing it",
		async (value) => {
			// Arrange
			const header = cookie(kind, value);
			const digest = vi.spyOn(crypto.subtle, "digest");
			// Act
			const result = await readBrowserCookie(header, kind);
			// Assert
			expect(result).toEqual({ kind: "invalid", error: "cookie_malformed" });
			expect(digest).not.toHaveBeenCalled();
		},
	);
	it.each([
		"missing-equals",
		"=value",
		";",
		"other=x;",
		"other=x;; next=y",
		"bad name=x",
		"other=\u0000",
		"other=\r",
		"other=\n",
		"other=\u007f",
		"other=é",
		"other=x,y",
	])("rejects malformed cookie grammar %j", async (header) => {
		// Arrange
		const digest = vi.spyOn(crypto.subtle, "digest");
		// Act
		const result = await readBrowserCookie(header, kind);
		// Assert
		expect(result).toEqual({ kind: "invalid", error: "cookie_malformed" });
		expect(digest).not.toHaveBeenCalled();
	});
	it("accepts exactly 8192 characters and rejects 8193 before crypto", async () => {
		// Arrange: pad an unknown cookie, not the credential itself.
		const prefix = `${cookie(kind)}; padding=`;
		const header = prefix + "x".repeat(8192 - prefix.length);
		// Act
		const accepted = await readBrowserCookie(header, kind);
		const digest = vi.spyOn(crypto.subtle, "digest");
		const rejected = await readBrowserCookie(`${header}x`, kind);
		// Assert
		expect(BROWSER_COOKIE_HEADER_MAX_BYTES).toBe(8192);
		expect(accepted.kind).toBe("present");
		expect(rejected).toEqual({ kind: "invalid", error: "cookie_malformed" });
		expect(digest).not.toHaveBeenCalled();
	});
	it.each(KINDS)(
		"rejects malformed %s credentials even when the requested cookie is valid",
		async (badKind) => {
			// Arrange
			const header = `${cookie(badKind, "bad")}; ${cookie(otherKind(badKind))}`;
			// Act
			const result = await readBrowserCookie(header, kind);
			// Assert
			expect(result).toEqual({ kind: "invalid", error: "cookie_malformed" });
		},
	);
}

function registerOpaqueAndFailureTests(kind: CookieKind): void {
	it("rejects forged, copied, and deserialized handles without inspecting them", async () => {
		// Arrange
		zeroEntropy();
		const issued = await issueBrowserCookie(kind);
		const trap = vi.fn(() => {
			throw new Error(PRIVATE_ERROR);
		});
		const proxy = new Proxy({}, { get: trap, ownKeys: trap });
		const forged = [
			{},
			{ ...issued.secret },
			JSON.parse(JSON.stringify(issued.secret)),
			proxy,
			null,
			ZERO_VALUE,
		];
		// Act / Assert: no object fields confer authority.
		for (const secret of forged) {
			expect(() => browserCookieValue(secret as typeof issued.secret, kind)).toThrow(
				/^auth_browser_credential_invalid_input$/,
			);
		}
		expect(trap).not.toHaveBeenCalled();
		assertOpaque(issued.secret);
		expect(browserCookieValue(issued.secret, kind)).toBe(ZERO_VALUE);
	});
	it("does not coerce objects, arrays, getters, or proxies into headers", async () => {
		// Arrange
		const trap = vi.fn(() => {
			throw new Error(PRIVATE_ERROR);
		});
		const getter = Object.defineProperty({}, "toString", { get: trap });
		const proxy = new Proxy({}, { get: trap, ownKeys: trap });
		const headers = [getter, proxy, [cookie(kind)], 42, true, Symbol("cookie")];
		// Act
		const results = await Promise.all(headers.map((header) => readBrowserCookie(header, kind)));
		// Assert
		expect(results).toEqual(headers.map(() => ({ kind: "invalid", error: "cookie_malformed" })));
		expect(trap).not.toHaveBeenCalled();
	});
	it("fails closed when entropy fails and hides the original error", async () => {
		// Arrange
		vi.spyOn(crypto, "getRandomValues").mockImplementation(() => {
			throw new Error(PRIVATE_ERROR);
		});
		const digest = vi.spyOn(crypto.subtle, "digest");
		// Act
		const error = await issueBrowserCookie(kind).catch((failure: unknown) => failure);
		// Assert
		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({ message: "auth_browser_credential_entropy_failed" });
		expect(error).not.toHaveProperty("cause");
		expect(String(error)).not.toContain(PRIVATE_ERROR);
		expect(digest).not.toHaveBeenCalled();
	});
	it("does not return a cookie or commitment before digest succeeds", async () => {
		// Arrange
		zeroEntropy();
		vi.spyOn(crypto.subtle, "digest").mockRejectedValue(new Error(PRIVATE_ERROR));
		// Act
		const issued = await issueBrowserCookie(kind).catch((failure: unknown) => failure);
		const read = await readBrowserCookie(cookie(kind), kind).catch((failure: unknown) => failure);
		// Assert
		for (const error of [issued, read]) {
			expect(error).toBeInstanceOf(Error);
			expect(error).toMatchObject({ message: "auth_browser_credential_crypto_failed" });
			expect(error).not.toHaveProperty("cause");
			expect(error).not.toHaveProperty("setCookie");
			expect(error).not.toHaveProperty("cookieHash");
			expect(String(error)).not.toContain(PRIVATE_ERROR);
		}
	});
}

describe("browser credential fixed contract", () => {
	it("freezes the exact host-only cookie name map", () => {
		// Arrange
		const expected = {
			transaction: "__Host-codemem-auth-transaction",
			session: "__Host-codemem-session",
		};
		// Act
		const names = BROWSER_COOKIE_NAMES;
		// Assert
		expect(names).toEqual(expected);
		expect(Object.isFrozen(names)).toBe(true);
	});
	it.each([undefined, null, "txn", "SESSION", "", {}, 0])(
		"rejects invalid kind %j before cryptography",
		async (input) => {
			// Arrange: exercise runtime callers that bypass TypeScript.
			const kind = input as CookieKind;
			const entropy = vi.spyOn(crypto, "getRandomValues");
			const digest = vi.spyOn(crypto.subtle, "digest");
			// Act / Assert
			await expect(issueBrowserCookie(kind)).rejects.toThrow(
				/^auth_browser_credential_invalid_input$/,
			);
			await expect(readBrowserCookie(cookie("transaction"), kind)).rejects.toThrow(
				/^auth_browser_credential_invalid_input$/,
			);
			expect(() => clearBrowserCookie(kind)).toThrow(/^auth_browser_credential_invalid_input$/);
			expect(() =>
				browserCookieValue({} as Parameters<typeof browserCookieValue>[0], kind),
			).toThrow(/^auth_browser_credential_invalid_input$/);
			expect(entropy).not.toHaveBeenCalled();
			expect(digest).not.toHaveBeenCalled();
		},
	);
});

for (const kind of KINDS) {
	describe(`browser credential ${kind}`, () => {
		registerIssuanceTests(kind);
		registerParsingTests(kind);
		registerMalformedTests(kind);
		registerOpaqueAndFailureTests(kind);
	});
}
