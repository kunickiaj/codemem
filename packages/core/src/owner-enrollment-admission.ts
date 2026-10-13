import { isAuthControllerId } from "./coordinator-auth-controller.js";
import { parseCoordinatorAuthLoopback } from "./coordinator-auth-loopback.js";
import {
	decodeCoordinatorAuthProof32,
	encodeCoordinatorAuthProof32,
} from "./coordinator-auth-proof.js";
import { parseSshEd25519PublicKey } from "./coordinator-ed25519-key-id.js";
import { verifyOwnerEnrollmentSignature } from "./coordinator-owner-enrollment-proof.js";
import type { OwnerEnrollmentStart } from "./owner-enrollment-start.js";

export interface OwnerEnrollmentAdmissionPin {
	coordinatorId: string;
	origin: string;
	issuer: string;
	revision: string;
}
declare const admissionKeyBrand: unique symbol;
export type OwnerEnrollmentAdmissionKey = Readonly<{ [admissionKeyBrand]: true }>;
type CryptoKey = Awaited<ReturnType<typeof globalThis.crypto.subtle.importKey>>;
const keys = new WeakMap<OwnerEnrollmentAdmissionKey, CryptoKey>();
const MAX_TTL_MS = 15 * 60 * 1000;

export function isOwnerEnrollmentAdmissionKey(
	value: unknown,
): value is OwnerEnrollmentAdmissionKey {
	return (
		typeof value === "object" && value !== null && keys.has(value as OwnerEnrollmentAdmissionKey)
	);
}

/** Server-only key import. Sharing raw CSRF bytes is safe because the MAC domain differs. */
export async function importOwnerEnrollmentAdmissionKey(
	raw: Uint8Array,
): Promise<OwnerEnrollmentAdmissionKey> {
	if (!(raw instanceof Uint8Array) || raw.byteLength !== 32)
		throw new Error("owner_admission_invalid_key");
	const cryptoKey = await globalThis.crypto.subtle.importKey(
		"raw",
		new Uint8Array(raw),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
	const key = Object.freeze({}) as OwnerEnrollmentAdmissionKey;
	keys.set(key, cryptoKey);
	return key;
}

function text(value: unknown, maximum: number): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= maximum &&
		!/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
	);
}

function startTuple(pin: OwnerEnrollmentAdmissionPin, start: OwnerEnrollmentStart): string {
	const parsed = parseSshEd25519PublicKey(start.publicKey);
	const origin = new URL(pin.origin);
	if (
		!isAuthControllerId(pin.coordinatorId) ||
		!text(pin.revision, 64) ||
		!/^[a-f0-9]{64}$/.test(pin.revision) ||
		origin.protocol !== "https:" ||
		origin.origin !== pin.origin ||
		!text(pin.issuer, 4096) ||
		!isAuthControllerId(start.attemptId) ||
		!isAuthControllerId(start.deviceId) ||
		!text(start.publicKey, 80) ||
		parsed.kind !== "ed25519" ||
		start.publicKey !== `ssh-ed25519 ${btoa(String.fromCharCode(...parsed.blob))}` ||
		!text(start.loopbackRedirect, 4096) ||
		!parseCoordinatorAuthLoopback(start.loopbackRedirect).ok ||
		!decodeCoordinatorAuthProof32(start.browserStartCode) ||
		!text(start.signature, 86)
	)
		throw new Error("owner_admission_invalid_start");
	return JSON.stringify([
		"codemem-owner-enrollment-start-v1",
		"owner_enroll",
		pin.coordinatorId,
		pin.origin,
		pin.issuer,
		pin.revision,
		start.attemptId,
		start.deviceId,
		start.publicKey,
		start.loopbackRedirect,
		start.browserStartCode,
	]);
}

function validTimes(issued: number, expires: number, now: number): boolean {
	return (
		[issued, expires, now].every((n) => Number.isSafeInteger(n) && n >= 0) &&
		issued <= now &&
		now < expires &&
		expires > issued &&
		expires - issued <= MAX_TTL_MS
	);
}

function message(
	tuple: string,
	signature: string,
	issued: number,
	expires: number,
): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(
		JSON.stringify(["codemem-owner-enrollment-admission-v1", issued, expires, tuple, signature]),
	);
}

/** Admin-only issuer: call only after reviewing this exact signed start. No durable state is created. */
export async function issueOwnerEnrollmentAdmission(
	key: OwnerEnrollmentAdmissionKey,
	pin: OwnerEnrollmentAdmissionPin,
	start: OwnerEnrollmentStart,
	options: { nowMs: number; ttlMs: number },
): Promise<string> {
	const cryptoKey = keys.get(key);
	const tuple = startTuple(pin, start);
	const issued = options.nowMs;
	const expires = issued + options.ttlMs;
	const signature = start.signature;
	if (
		!cryptoKey ||
		!validTimes(issued, expires, issued) ||
		!(await verifyOwnerEnrollmentSignature(start.publicKey, tuple, signature))
	) {
		throw new Error("owner_admission_invalid_start");
	}
	const mac = await globalThis.crypto.subtle.sign(
		"HMAC",
		cryptoKey,
		message(tuple, signature, issued, expires),
	);
	return `v1.${issued}.${expires}.${encodeCoordinatorAuthProof32(new Uint8Array(mac))}`;
}

/** Exact retries still reach the retained-attempt uniqueness and capacity checks; this is not a replay store. */
export async function verifyOwnerEnrollmentAdmission(
	key: OwnerEnrollmentAdmissionKey,
	token: unknown,
	pin: OwnerEnrollmentAdmissionPin,
	start: OwnerEnrollmentStart,
	nowMs: number,
): Promise<boolean> {
	try {
		const cryptoKey = keys.get(key);
		if (!cryptoKey || typeof token !== "string" || token.length > 81) return false;
		const parts = /^v1\.(0|[1-9][0-9]{0,15})\.(0|[1-9][0-9]{0,15})\.([A-Za-z0-9_-]{43})$/.exec(
			token,
		);
		if (!parts) return false;
		const issued = Number(parts[1]);
		const expires = Number(parts[2]);
		const mac = decodeCoordinatorAuthProof32(parts[3]);
		if (!mac || !validTimes(issued, expires, nowMs)) return false;
		return await globalThis.crypto.subtle.verify(
			"HMAC",
			cryptoKey,
			mac,
			message(startTuple(pin, start), start.signature, issued, expires),
		);
	} catch {
		return false;
	}
}
