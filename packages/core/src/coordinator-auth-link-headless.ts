import type {
	CoordinatorAuthBrowserTransactionRejected,
	CoordinatorAuthBrowserTransactionStartResult,
} from "./coordinator-auth-browser-transaction-contract.js";
import type {
	CoordinatorAuthLinkCreateInput,
	CoordinatorAuthLinkFinalizeInput,
	CoordinatorAuthLinkSigner,
} from "./coordinator-auth-link-contract.js";
import { hashCoordinatorAuthProofBytes32 } from "./coordinator-auth-proof.js";

/** Same authority and pins as desktop create; the user code hash replaces the start hash. */
export type CoordinatorAuthLinkHeadlessCreateInput = Omit<
	CoordinatorAuthLinkCreateInput,
	"loopbackRedirect" | "browserStartHash"
> & { userCodeHash: string };
/** The device-approved account must equal the attempt's verified account when the link is written. */
export interface CoordinatorAuthLinkHeadlessFinalizeInput extends CoordinatorAuthLinkFinalizeInput {
	approvedAccount: { issuer: string; subject: string };
}
export interface CoordinatorAuthLinkHeadlessApprovalInput {
	attemptId: string;
	signer: CoordinatorAuthLinkSigner;
}
/** Verified account shown on the device before it approves; profile fields are display claims. */
export interface CoordinatorAuthLinkHeadlessApproval {
	issuer: string;
	subject: string;
	displayName: string | null;
	email: string | null;
	emailVerified: boolean | null;
}
export interface CoordinatorAuthHeadlessBrowserStartInput {
	userCodeHash: string;
	stateHash: string;
	binderHash: string;
	nonce: string;
	pkceVerifier: string;
}
export type CoordinatorAuthHeadlessBrowserStartResult =
	| { kind: "started"; expiresAtMs: number; attemptId: string }
	| Exclude<CoordinatorAuthBrowserTransactionStartResult, { kind: "started" }>
	| CoordinatorAuthBrowserTransactionRejected;

/**
 * Headless attempts share the desktop attempt table. This exact loopback value
 * marks the mode; it can never parse as a loopback URL, so desktop completion
 * delivery stays unreachable for headless rows.
 */
export const AUTH_LINK_HEADLESS_MARKER = "codemem-headless:v1";
/** SQL literal form of the marker. The constant contains no quote characters. */
export const AUTH_LINK_HEADLESS_MARKER_SQL = `'${AUTH_LINK_HEADLESS_MARKER}'`;

/** Consonants only: no vowels (no accidental words) and no 0/O or 1/I confusion. */
export const HEADLESS_USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const HEADLESS_USER_CODE_LENGTH = 8;
const HEADLESS_USER_CODE_PREFIX = "codemem-headless-link-code-v1:";
// 240 is the largest multiple of 20 not above 256; larger bytes would bias the alphabet.
const UNBIASED_BYTE_LIMIT = 240;
const MAX_RAW_USER_CODE_LENGTH = 64;
const GENERATION_BATCH = 16;

export type HeadlessRandomBytes = (length: number) => Uint8Array;

function defaultRandomBytes(length: number): Uint8Array {
	return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

/** Returns the normalized 8-character code. Display it with formatHeadlessUserCode. */
export function generateHeadlessUserCode(
	options: { randomBytes?: HeadlessRandomBytes } = {},
): string {
	const randomBytes = options.randomBytes ?? defaultRandomBytes;
	let code = "";
	// Each batch accepts a byte with probability 240/256; 64 batches failing is not a real outcome.
	for (let round = 0; round < 64 && code.length < HEADLESS_USER_CODE_LENGTH; round += 1) {
		for (const byte of randomBytes(GENERATION_BATCH)) {
			if (byte >= UNBIASED_BYTE_LIMIT) continue;
			code += HEADLESS_USER_CODE_ALPHABET[byte % HEADLESS_USER_CODE_ALPHABET.length];
			if (code.length === HEADLESS_USER_CODE_LENGTH) return code;
		}
	}
	throw new Error("headless_user_code_entropy_failed");
}

/** Formats a normalized code as XXXX-XXXX for display. */
export function formatHeadlessUserCode(code: string): string {
	const normalized = normalizeHeadlessUserCode(code);
	if (normalized === null) throw new Error("headless_user_code_invalid");
	return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

/**
 * Accepts typed input: case-insensitive, with '-' and whitespace ignored.
 * Returns null for any other character or a wrong length.
 */
export function normalizeHeadlessUserCode(value: unknown): string | null {
	if (typeof value !== "string" || value.length > MAX_RAW_USER_CODE_LENGTH) return null;
	const stripped = value.replace(/[\s-]/g, "");
	// Check ASCII letters before uppercasing: Unicode case mapping can expand characters.
	if (!/^[A-Za-z]+$/.test(stripped) || stripped.length !== HEADLESS_USER_CODE_LENGTH) return null;
	const upper = stripped.toUpperCase();
	for (const character of upper) {
		if (!HEADLESS_USER_CODE_ALPHABET.includes(character)) return null;
	}
	return upper;
}

/** The 32 bytes that play the role of a desktop browser start code. */
export async function deriveHeadlessUserCodeStartBytes(
	normalizedCode: string,
): Promise<Uint8Array> {
	if (normalizeHeadlessUserCode(normalizedCode) !== normalizedCode)
		throw new Error("headless_user_code_invalid");
	const input = new TextEncoder().encode(`${HEADLESS_USER_CODE_PREFIX}${normalizedCode}`);
	const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
	return new Uint8Array(digest);
}

/** Stored as browser_start_hash, using the same hash desktop applies to its start code bytes. */
export async function hashHeadlessUserCode(normalizedCode: string): Promise<string> {
	return hashCoordinatorAuthProofBytes32(await deriveHeadlessUserCodeStartBytes(normalizedCode));
}
