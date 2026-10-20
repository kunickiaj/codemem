import { parseCoordinatorAccountReference } from "./coordinator-auth-contract.js";
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

/** Server-resolved account/link only. This structural type confers no authorization. */
export interface OwnerEnrollmentResolvedOwner {
	readonly coordinatorId: string;
	readonly issuer: string;
	readonly subject: string;
	readonly identityId: string;
	readonly linkId: string;
}

export interface OwnerEnrollmentAdmissionV2Options {
	readonly resolvedOwner: OwnerEnrollmentResolvedOwner;
	readonly nowMs: number;
	readonly ttlMs: number;
}

export interface OwnerEnrollmentAdmissionV2VerificationOptions {
	readonly resolvedOwner: OwnerEnrollmentResolvedOwner;
	readonly nowMs: number;
}

function ownerTuple(owner: OwnerEnrollmentResolvedOwner): string {
	const { coordinatorId, issuer, subject, identityId, linkId } = owner;
	if (
		!isAuthControllerId(coordinatorId) ||
		!text(issuer, 4096) ||
		!parseCoordinatorAccountReference({ issuer, subject }, { issuer }).ok ||
		!isAuthControllerId(identityId) ||
		!isAuthControllerId(linkId)
	)
		throw new Error("owner_admission_invalid_owner");
	return JSON.stringify([
		"codemem-owner-enrollment-owner-commitment-v1",
		coordinatorId,
		issuer,
		subject,
		identityId,
		linkId,
	]);
}

async function hashOwnerTuple(tuple: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(tuple));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Unmounted primitive: hashes canonical JSON [domain, coordinator, issuer, subject, Identity, link].
 * Returns lowercase SHA-256 hex, not authority or anonymization of guessable account data.
 */
export async function ownerEnrollmentOwnerCommitment(
	owner: OwnerEnrollmentResolvedOwner,
): Promise<string> {
	return hashOwnerTuple(ownerTuple(owner));
}

function admissionV2Input(
	pin: OwnerEnrollmentAdmissionPin,
	start: OwnerEnrollmentStart,
	owner: OwnerEnrollmentResolvedOwner,
) {
	// Copy every caller-owned field before crypto can yield. No later reads from inputs.
	const pinned = {
		coordinatorId: pin.coordinatorId,
		origin: pin.origin,
		issuer: pin.issuer,
		revision: pin.revision,
	};
	const pending = {
		attemptId: start.attemptId,
		deviceId: start.deviceId,
		publicKey: start.publicKey,
		loopbackRedirect: start.loopbackRedirect,
		browserStartCode: start.browserStartCode,
		signature: start.signature,
	};
	const resolved = {
		coordinatorId: owner.coordinatorId,
		issuer: owner.issuer,
		subject: owner.subject,
		identityId: owner.identityId,
		linkId: owner.linkId,
	};
	const ownerMessage = ownerTuple(resolved);
	if (
		resolved.coordinatorId !== pinned.coordinatorId ||
		resolved.issuer !== pinned.issuer ||
		!text(pinned.origin, 4096) ||
		!text(pending.browserStartCode, 43)
	)
		throw new Error("owner_admission_invalid_start");
	return {
		tuple: startTuple(pinned, pending),
		publicKey: pending.publicKey,
		signature: pending.signature,
		ownerMessage,
	};
}

function messageV2(
	tuple: string,
	signature: string,
	issued: number,
	expires: number,
	ownerCommitment: string,
): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(
		JSON.stringify([
			"codemem-owner-enrollment-admission-v2",
			issued,
			expires,
			tuple,
			signature,
			ownerCommitment,
		]),
	);
}

/**
 * Unmounted server-only issuer, NOT a self-service endpoint. Before calling, authenticate the
 * session and resolve its active account link, Identity and grants server-side. Never accept
 * resolvedOwner from request JSON. A type or commitment alone does not authorize issuance.
 * Uses the existing private admission key; v1 operator issuance/verification stays unchanged.
 */
export async function issueOwnerEnrollmentAdmissionV2(
	key: OwnerEnrollmentAdmissionKey,
	pin: OwnerEnrollmentAdmissionPin,
	start: OwnerEnrollmentStart,
	options: OwnerEnrollmentAdmissionV2Options,
): Promise<string> {
	const cryptoKey = keys.get(key);
	const input = admissionV2Input(pin, start, options.resolvedOwner);
	const issued = options.nowMs;
	const ttl = options.ttlMs;
	const expires = issued + ttl;
	if (!cryptoKey || !Number.isSafeInteger(ttl) || !validTimes(issued, expires, issued))
		throw new Error("owner_admission_invalid_start");
	if (!(await verifyOwnerEnrollmentSignature(input.publicKey, input.tuple, input.signature)))
		throw new Error("owner_admission_invalid_start");
	const commitment = await hashOwnerTuple(input.ownerMessage);
	const mac = await globalThis.crypto.subtle.sign(
		"HMAC",
		cryptoKey,
		messageV2(input.tuple, input.signature, issued, expires, commitment),
	);
	return `v2.${issued}.${expires}.${commitment}.${encodeCoordinatorAuthProof32(new Uint8Array(mac))}`;
}

/**
 * Unmounted v2-only verifier; no v1 fallback. The hash companion is authenticated, not raw owner data.
 * Callers must separately retain an immutable attempt owner pin, compare it at callback/finalize,
 * and recheck live session/link/grant authority. This primitive creates no attempt or replay state.
 */
export async function verifyOwnerEnrollmentAdmissionV2(
	key: OwnerEnrollmentAdmissionKey,
	token: unknown,
	pin: OwnerEnrollmentAdmissionPin,
	start: OwnerEnrollmentStart,
	options: OwnerEnrollmentAdmissionV2VerificationOptions,
): Promise<boolean> {
	try {
		const cryptoKey = keys.get(key);
		if (!cryptoKey || typeof token !== "string" || token.length > 146) return false;
		const parts =
			/^v2\.(0|[1-9][0-9]{0,15})\.(0|[1-9][0-9]{0,15})\.([a-f0-9]{64})\.([A-Za-z0-9_-]{43})$/.exec(
				token,
			);
		if (!parts) return false;
		const issued = Number(parts[1]);
		const expires = Number(parts[2]);
		const commitment = parts[3];
		const mac = decodeCoordinatorAuthProof32(parts[4]);
		const now = options.nowMs;
		if (!mac || !commitment || !validTimes(issued, expires, now)) return false;
		const input = admissionV2Input(pin, start, options.resolvedOwner);
		if ((await hashOwnerTuple(input.ownerMessage)) !== commitment) return false;
		return await globalThis.crypto.subtle.verify(
			"HMAC",
			cryptoKey,
			mac,
			messageV2(input.tuple, input.signature, issued, expires, commitment),
		);
	} catch {
		return false;
	}
}
