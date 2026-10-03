import { AUTH_BROWSER_TXN_TTL_MS } from "./coordinator-auth-browser-transaction-contract.js";
import { AUTH_SESSION_TTL_MS } from "./coordinator-auth-session-contract.js";

export type CookieKind = "transaction" | "session";
declare const browserCookieSecretBrand: unique symbol;
export type BrowserCookieSecret = Readonly<{ [browserCookieSecretBrand]: true }>;

export const BROWSER_COOKIE_NAMES = Object.freeze({
	transaction: "__Host-codemem-auth-transaction",
	session: "__Host-codemem-session",
});
export const BROWSER_COOKIE_HEADER_MAX_BYTES = 8192;
const MAX_AGE_SECONDS = {
	transaction: AUTH_BROWSER_TXN_TTL_MS / 1000,
	session: AUTH_SESSION_TTL_MS / 1000,
};
const CANONICAL_VALUE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_VALUE =
	/^(?:[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*|"[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*")$/;
type CookieMaterial = Readonly<{
	kind: CookieKind;
	bytes: Uint8Array<ArrayBuffer>;
	encoded: string;
}>;
const secrets = new WeakMap<BrowserCookieSecret, CookieMaterial>();
type InvalidCookie = { kind: "invalid"; error: "cookie_duplicate" | "cookie_malformed" };
export type BrowserCookieReadResult =
	| { kind: "absent" }
	| InvalidCookie
	| { kind: "present"; secret: BrowserCookieSecret; cookieHash: string };

function validateKind(kind: CookieKind): void {
	if (kind !== "transaction" && kind !== "session") {
		throw new Error("auth_browser_credential_invalid_input");
	}
}

function encodeBytes(bytes: Uint8Array<ArrayBuffer>): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

function decodeValue(encoded: string): Uint8Array<ArrayBuffer> | null {
	if (!CANONICAL_VALUE.test(encoded)) return null;
	try {
		const binary = atob(`${encoded.replaceAll("-", "+").replaceAll("_", "/")}=`);
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		if (bytes.length !== 32 || encodeBytes(bytes) !== encoded) return null;
		return bytes;
	} catch {
		return null;
	}
}

async function hashBytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	try {
		const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
		return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
			"",
		);
	} catch {
		throw new Error("auth_browser_credential_crypto_failed");
	}
}

function createSecret(material: CookieMaterial): BrowserCookieSecret {
	const secret = Object.freeze({}) as BrowserCookieSecret;
	secrets.set(secret, Object.freeze(material));
	return secret;
}

function cookieHeader(kind: CookieKind, value: string, maxAge: number): string {
	return `${BROWSER_COOKIE_NAMES[kind]}=${value}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export async function issueBrowserCookie(
	kind: CookieKind,
): Promise<{ secret: BrowserCookieSecret; cookieHash: string; setCookie: string }> {
	validateKind(kind);
	let bytes: Uint8Array<ArrayBuffer>;
	try {
		bytes = new Uint8Array(32);
		globalThis.crypto.getRandomValues(bytes);
	} catch {
		throw new Error("auth_browser_credential_entropy_failed");
	}
	const cookieHash = await hashBytes(bytes);
	const encoded = encodeBytes(bytes);
	return {
		secret: createSecret({ kind, bytes, encoded }),
		cookieHash,
		setCookie: cookieHeader(kind, encoded, MAX_AGE_SECONDS[kind]),
	};
}

export function clearBrowserCookie(kind: CookieKind): string {
	validateKind(kind);
	return cookieHeader(kind, "", 0);
}

/** Internal credential access only: never send this value through JSON or logs. */
export function browserCookieValue(secret: BrowserCookieSecret, expectedKind: CookieKind): string {
	validateKind(expectedKind);
	const material = secrets.get(secret);
	if (!material || material.kind !== expectedKind) {
		throw new Error("auth_browser_credential_invalid_input");
	}
	return material.encoded;
}

function trimOws(value: string): string {
	let start = 0;
	let end = value.length;
	while (start < end && (value[start] === " " || value[start] === "\t")) start++;
	while (end > start && (value[end - 1] === " " || value[end - 1] === "\t")) end--;
	return value.slice(start, end);
}

function isValidHeader(header: string): boolean {
	if (header.length > BROWSER_COOKIE_HEADER_MAX_BYTES) return false;
	for (const character of header) {
		const code = character.charCodeAt(0);
		if (code === 9) continue;
		if (code < 32 || code > 126 || code === 44) return false;
	}
	return true;
}

function knownCookieKind(name: string): CookieKind | undefined {
	const lowerName = name.toLowerCase();
	if (lowerName === BROWSER_COOKIE_NAMES.transaction.toLowerCase()) return "transaction";
	if (lowerName === BROWSER_COOKIE_NAMES.session.toLowerCase()) return "session";
	return undefined;
}

function parseCookies(header: string): Map<CookieKind, CookieMaterial> | InvalidCookie {
	const cookies = new Map<CookieKind, CookieMaterial>();
	for (const segment of header.split(";")) {
		const pair = trimOws(segment);
		const separator = pair.indexOf("=");
		if (separator < 1) return { kind: "invalid", error: "cookie_malformed" };
		const name = pair.slice(0, separator);
		const encoded = pair.slice(separator + 1);
		if (!COOKIE_NAME.test(name) || !COOKIE_VALUE.test(encoded)) {
			return { kind: "invalid", error: "cookie_malformed" };
		}
		const kind = knownCookieKind(name);
		if (!kind) continue;
		if (cookies.has(kind)) return { kind: "invalid", error: "cookie_duplicate" };
		if (name !== BROWSER_COOKIE_NAMES[kind]) {
			return { kind: "invalid", error: "cookie_malformed" };
		}
		const bytes = decodeValue(encoded);
		if (!bytes) return { kind: "invalid", error: "cookie_malformed" };
		cookies.set(kind, { kind, bytes, encoded });
	}
	return cookies;
}

/** A present cookie is not authentication; callers must look up its hash in the store. */
export async function readBrowserCookie(
	cookieHeader: unknown,
	kind: CookieKind,
): Promise<BrowserCookieReadResult> {
	validateKind(kind);
	if (cookieHeader === null || cookieHeader === undefined) return { kind: "absent" };
	if (typeof cookieHeader !== "string") return { kind: "invalid", error: "cookie_malformed" };
	// For this ASCII-only header, string length is also its byte count.
	if (!isValidHeader(cookieHeader)) {
		return { kind: "invalid", error: "cookie_malformed" };
	}
	if (!trimOws(cookieHeader)) return { kind: "absent" };
	const cookies = parseCookies(cookieHeader);
	if (!(cookies instanceof Map)) return cookies;
	const material = cookies.get(kind);
	if (!material) return { kind: "absent" };
	const cookieHash = await hashBytes(material.bytes);
	return { kind: "present", secret: createSecret(material), cookieHash };
}
