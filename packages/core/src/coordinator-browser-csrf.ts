import type { CoordinatorAuthBrowserConfig } from "./coordinator-auth-browser-transaction-contract.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import {
	type BrowserCookieSecret,
	browserCookieValue,
	type CookieKind,
} from "./coordinator-browser-credential.js";

declare const browserCsrfKeyBrand: unique symbol;
export type BrowserCsrfKey = Readonly<{ [browserCsrfKeyBrand]: true }>;
export interface BrowserCsrfScope {
	publicOrigin: string;
	store: Pick<CoordinatorAuthBrowserConfig, "coordinatorId" | "revision">;
}

type CryptoKey = Awaited<ReturnType<typeof globalThis.crypto.subtle.importKey>>;
const keys = new WeakMap<BrowserCsrfKey, CryptoKey>();
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{85}[AQgw]$/;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
	typedArrayPrototype,
	"byteLength",
)?.get;

function invalidInput(): Error {
	return new Error("auth_browser_csrf_invalid_input");
}

function copyKeyBytes(raw: Uint8Array): Uint8Array<ArrayBuffer> {
	if (typedArrayTag?.call(raw) !== "Uint8Array" || typedArrayByteLength?.call(raw) !== 32) {
		throw invalidInput();
	}
	const copy = new Uint8Array(32);
	Uint8Array.prototype.set.call(copy, raw);
	return copy;
}

async function importCopiedKey(bytes: Uint8Array<ArrayBuffer>): Promise<BrowserCsrfKey> {
	try {
		const cryptoKey = await globalThis.crypto.subtle.importKey(
			"raw",
			bytes,
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign", "verify"],
		);
		const key = Object.freeze({}) as BrowserCsrfKey;
		keys.set(key, cryptoKey);
		return key;
	} catch {
		throw new Error("auth_browser_csrf_crypto_failed");
	}
}

export function importBrowserCsrfKey(raw: Uint8Array): Promise<BrowserCsrfKey> {
	let bytes: Uint8Array<ArrayBuffer>;
	try {
		bytes = copyKeyBytes(raw);
	} catch {
		return Promise.reject(invalidInput());
	}
	// Only the owned copy crosses the asynchronous boundary.
	return importCopiedKey(bytes);
}

function ownData(value: unknown, name: string): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidInput();
	const descriptor = Object.getOwnPropertyDescriptor(value, name);
	if (!descriptor || !Object.hasOwn(descriptor, "value")) throw invalidInput();
	return descriptor.value;
}

function validOrigin(value: unknown): value is string {
	if (typeof value !== "string" || /[\\\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) return false;
	const url = new URL(value);
	return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
}

function captureMessageFields(
	key: BrowserCsrfKey,
	secret: BrowserCookieSecret,
	purpose: CookieKind,
	scope: BrowserCsrfScope,
): { cryptoKey: CryptoKey; fields: string[] } {
	try {
		const cryptoKey = keys.get(key);
		if (!cryptoKey || (purpose !== "transaction" && purpose !== "session" && purpose !== "start")) {
			throw invalidInput();
		}
		const publicOrigin = ownData(scope, "publicOrigin");
		const store = ownData(scope, "store");
		const coordinatorId = ownData(store, "coordinatorId");
		const revision = ownData(store, "revision");
		if (
			!validOrigin(publicOrigin) ||
			!isAuthControllerId(coordinatorId) ||
			typeof revision !== "string" ||
			revision.length !== 64 ||
			!/^[a-f0-9]{64}$/.test(revision)
		) {
			throw invalidInput();
		}
		const encodedCookie = browserCookieValue(secret, purpose);
		return {
			cryptoKey,
			fields: [
				"codemem-browser-csrf-v1",
				purpose,
				coordinatorId,
				publicOrigin,
				revision,
				encodedCookie,
			],
		};
	} catch {
		throw invalidInput();
	}
}

function encodeBytes(bytes: Uint8Array<ArrayBuffer>): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

function decodeToken(value: unknown): Uint8Array<ArrayBuffer> | null {
	if (typeof value !== "string" || value.length !== 86 || !TOKEN_PATTERN.test(value)) return null;
	try {
		const binary = atob(`${value.replaceAll("-", "+").replaceAll("_", "/")}==`);
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		if (bytes.length !== 64 || encodeBytes(bytes) !== value) return null;
		return bytes;
	} catch {
		return null;
	}
}

/** Shape only: this does not authenticate the token or its browser session. */
export function isBrowserCsrfToken(value: unknown): value is string {
	return decodeToken(value) !== null;
}

function messageBytes(fields: string[], nonce: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(JSON.stringify([...fields, encodeBytes(nonce)]));
}

export async function issueBrowserCsrfToken(
	key: BrowserCsrfKey,
	secret: BrowserCookieSecret,
	purpose: CookieKind,
	scope: BrowserCsrfScope,
): Promise<string> {
	const { cryptoKey, fields } = captureMessageFields(key, secret, purpose, scope);
	const nonce = new Uint8Array(32);
	try {
		globalThis.crypto.getRandomValues(nonce);
	} catch {
		throw new Error("auth_browser_csrf_entropy_failed");
	}
	try {
		const signature = await globalThis.crypto.subtle.sign(
			"HMAC",
			cryptoKey,
			messageBytes(fields, nonce),
		);
		const signatureLength = Object.getOwnPropertyDescriptor(
			ArrayBuffer.prototype,
			"byteLength",
		)?.get;
		if (signatureLength?.call(signature) !== 32) throw new Error("auth_browser_csrf_crypto_failed");
		const mac = new Uint8Array(signature);
		if (mac.length !== 32) throw new Error("auth_browser_csrf_crypto_failed");
		const token = new Uint8Array(64);
		token.set(mac);
		token.set(nonce, 32);
		return encodeBytes(token);
	} catch {
		throw new Error("auth_browser_csrf_crypto_failed");
	}
}

/** Callers must also require a live store lookup before protecting an authenticated action. */
export async function verifyBrowserCsrfToken(
	key: BrowserCsrfKey,
	secret: BrowserCookieSecret,
	purpose: CookieKind,
	scope: BrowserCsrfScope,
	token: unknown,
): Promise<boolean> {
	try {
		const payload = decodeToken(token);
		if (!payload) return false;
		const { cryptoKey, fields } = captureMessageFields(key, secret, purpose, scope);
		return await globalThis.crypto.subtle.verify(
			"HMAC",
			cryptoKey,
			payload.slice(0, 32),
			messageBytes(fields, payload.slice(32)),
		);
	} catch {
		return false;
	}
}
