export type RelayAdmissionRole = "source" | "relay" | "responder";

export interface RelayAdmissionBody {
	readonly role: RelayAdmissionRole;
	readonly authorityId: string;
	readonly groupId: string;
	readonly sourceDeviceId: string;
	readonly sourceKeyId: string;
	readonly targetDeviceId: string;
	readonly targetKeyId: string;
	readonly relayAudienceId: string;
	readonly routeSessionId: string;
	readonly messageADigest: string;
	readonly createdAt: number;
	readonly admitBefore: number;
	readonly routeNotAfter: number;
}

export interface RelayRegistrationBody {
	readonly authorityId: string;
	readonly groupId: string;
	readonly deviceId: string;
	readonly keyId: string;
	readonly relayAudienceId: string;
	readonly socketChallengeId: string;
	readonly createdAt: number;
	readonly admitBefore: number;
}

export interface RelayCheckPacket {
	readonly body: string;
	readonly timestamp: string;
	readonly nonce: string;
	readonly signature: string;
}

export class RelayAdmissionFormatError extends Error {}

const ADMISSION_PURPOSE = "codemem-relay-admission-check-v1";
const REGISTRATION_PURPOSE = "codemem-relay-register-v1";
const MAX_BODY_BYTES = 1024;
const HEX_ID = /^[0-9a-f]{64}$/;
const SHORT_ID = /^[0-9a-f]{32}$/;
const DEVICE_ID = /^[\x21-\x7e]{1,64}$/;
const encoder = new TextEncoder();

function requireFormat(condition: unknown): asserts condition {
	if (!condition) throw new RelayAdmissionFormatError("Invalid relay admission format");
}

function requireExactFields(value: unknown, expected: readonly string[]): void {
	requireFormat(typeof value === "object" && value !== null && !Array.isArray(value));
	const fields = Reflect.ownKeys(value);
	requireFormat(
		fields.length === expected.length && expected.every((field) => fields.includes(field)),
	);
}

function stringField(value: unknown, pattern: RegExp): string {
	requireFormat(typeof value === "string" && value.match(pattern)?.[0] === value);
	return value;
}

function groupField(value: unknown): string {
	requireFormat(typeof value === "string" && value === value.trim());
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		requireFormat(code >= 32 && code !== 127 && (code < 0xd800 || code > 0xdfff));
	}
	const length = encoder.encode(value).length;
	requireFormat(length >= 1 && length <= 128);
	return value;
}

function createdField(createdAt: unknown, admitBefore: unknown): number {
	requireFormat(typeof createdAt === "number" && Number.isSafeInteger(createdAt));
	requireFormat(createdAt >= 0 && createdAt <= 9_999_999_999);
	requireFormat(Number.isSafeInteger(admitBefore) && admitBefore === createdAt + 30);
	return createdAt;
}

function parseCanonicalArray(bytes: Uint8Array): unknown[] {
	requireFormat(bytes instanceof Uint8Array && bytes.length <= MAX_BODY_BYTES);
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
	} catch {
		throw new RelayAdmissionFormatError("Invalid relay admission JSON");
	}
	requireFormat(Array.isArray(value));
	const canonical = encoder.encode(JSON.stringify(value));
	requireFormat(
		canonical.length === bytes.length && canonical.every((byte, i) => byte === bytes[i]),
	);
	return value;
}

function admissionFromArray(fields: unknown[]): RelayAdmissionBody {
	requireFormat(fields.length === 14 && fields[0] === ADMISSION_PURPOSE);
	const role = fields[1];
	requireFormat(role === "source" || role === "relay" || role === "responder");
	const createdAt = createdField(fields[11], fields[12]);
	requireFormat(Number.isSafeInteger(fields[13]) && fields[13] === createdAt + 55);
	const sourceDeviceId = stringField(fields[4], DEVICE_ID);
	const targetDeviceId = stringField(fields[6], DEVICE_ID);
	requireFormat(sourceDeviceId !== targetDeviceId);
	return {
		role,
		authorityId: stringField(fields[2], HEX_ID),
		groupId: groupField(fields[3]),
		sourceDeviceId,
		sourceKeyId: stringField(fields[5], HEX_ID),
		targetDeviceId,
		targetKeyId: stringField(fields[7], HEX_ID),
		relayAudienceId: stringField(fields[8], HEX_ID),
		routeSessionId: stringField(fields[9], SHORT_ID),
		messageADigest: stringField(fields[10], HEX_ID),
		createdAt,
		admitBefore: createdAt + 30,
		routeNotAfter: createdAt + 55,
	};
}

function registrationFromArray(fields: unknown[]): RelayRegistrationBody {
	requireFormat(fields.length === 9 && fields[0] === REGISTRATION_PURPOSE);
	const createdAt = createdField(fields[7], fields[8]);
	return {
		authorityId: stringField(fields[1], HEX_ID),
		groupId: groupField(fields[2]),
		deviceId: stringField(fields[3], DEVICE_ID),
		keyId: stringField(fields[4], HEX_ID),
		relayAudienceId: stringField(fields[5], HEX_ID),
		socketChallengeId: stringField(fields[6], SHORT_ID),
		createdAt,
		admitBefore: createdAt + 30,
	};
}

export function encodeRelayAdmissionBody(value: RelayAdmissionBody): Uint8Array {
	requireExactFields(value, [
		"role",
		"authorityId",
		"groupId",
		"sourceDeviceId",
		"sourceKeyId",
		"targetDeviceId",
		"targetKeyId",
		"relayAudienceId",
		"routeSessionId",
		"messageADigest",
		"createdAt",
		"admitBefore",
		"routeNotAfter",
	]);
	const fields = [
		ADMISSION_PURPOSE,
		value.role,
		value.authorityId,
		value.groupId,
		value.sourceDeviceId,
		value.sourceKeyId,
		value.targetDeviceId,
		value.targetKeyId,
		value.relayAudienceId,
		value.routeSessionId,
		value.messageADigest,
		value.createdAt,
		value.admitBefore,
		value.routeNotAfter,
	];
	admissionFromArray(fields);
	return encodeBody(fields);
}

export function decodeRelayAdmissionBody(bytes: Uint8Array): RelayAdmissionBody {
	return admissionFromArray(parseCanonicalArray(bytes));
}

export function encodeRelayRegistrationBody(value: RelayRegistrationBody): Uint8Array {
	requireExactFields(value, [
		"authorityId",
		"groupId",
		"deviceId",
		"keyId",
		"relayAudienceId",
		"socketChallengeId",
		"createdAt",
		"admitBefore",
	]);
	const fields = [
		REGISTRATION_PURPOSE,
		value.authorityId,
		value.groupId,
		value.deviceId,
		value.keyId,
		value.relayAudienceId,
		value.socketChallengeId,
		value.createdAt,
		value.admitBefore,
	];
	registrationFromArray(fields);
	return encodeBody(fields);
}

export function decodeRelayRegistrationBody(bytes: Uint8Array): RelayRegistrationBody {
	return registrationFromArray(parseCanonicalArray(bytes));
}

function encodeBody(fields: unknown[]): Uint8Array {
	const bytes = encoder.encode(JSON.stringify(fields));
	requireFormat(bytes.length <= MAX_BODY_BYTES);
	return bytes;
}

function ordinaryBase64(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}

function decodeOrdinaryBase64(value: string): Uint8Array {
	try {
		const binary = atob(value);
		requireFormat(btoa(binary) === value);
		return Uint8Array.from(binary, (character) => character.charCodeAt(0));
	} catch {
		throw new RelayAdmissionFormatError("Invalid relay admission encoding");
	}
}

function base64Url(bytes: Uint8Array): string {
	return ordinaryBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBodyBase64Url(value: unknown): Uint8Array {
	requireFormat(
		typeof value === "string" && value.length <= 1366 && /^[A-Za-z0-9_-]+$/.test(value),
	);
	const ordinary = value.replaceAll("-", "+").replaceAll("_", "/");
	const bytes = decodeOrdinaryBase64(ordinary + "=".repeat((4 - (ordinary.length % 4)) % 4));
	requireFormat(bytes.length <= MAX_BODY_BYTES && base64Url(bytes) === value);
	return bytes;
}

type DecodedBody =
	| { readonly kind: "admission"; readonly value: RelayAdmissionBody }
	| { readonly kind: "registration"; readonly value: RelayRegistrationBody };

export type DecodedRelayCheck = DecodedBody & {
	readonly bodyBytes: Uint8Array;
	readonly timestamp: string;
	readonly nonce: string;
	readonly signatureBytes: Uint8Array;
};

function decodeKnownBody(bytes: Uint8Array): DecodedBody {
	const fields = parseCanonicalArray(bytes);
	if (fields[0] === ADMISSION_PURPOSE) {
		return { kind: "admission", value: admissionFromArray(fields) };
	}
	return { kind: "registration", value: registrationFromArray(fields) };
}

function validatePacketMetadata(
	timestamp: unknown,
	nonce: unknown,
	createdAt: number,
): { timestamp: string; nonce: string } {
	requireFormat(typeof timestamp === "string" && timestamp === String(createdAt));
	return { timestamp, nonce: stringField(nonce, SHORT_ID) };
}

export function encodeRelayCheckPacket(options: {
	readonly bodyBytes: Uint8Array;
	readonly timestamp: string;
	readonly nonce: string;
	readonly signatureBytes: Uint8Array;
}): RelayCheckPacket {
	const { bodyBytes, timestamp, nonce, signatureBytes } = options;
	const decoded = decodeKnownBody(bodyBytes);
	const metadata = validatePacketMetadata(timestamp, nonce, decoded.value.createdAt);
	requireFormat(signatureBytes instanceof Uint8Array && signatureBytes.length === 64);
	return {
		body: base64Url(bodyBytes),
		...metadata,
		signature: `v2:${ordinaryBase64(signatureBytes)}`,
	};
}

/** Format checks produce untrusted claims. Authority and normal v2 signature verification remain required. */
export function decodeRelayCheckPacket(packet: unknown): DecodedRelayCheck {
	requireFormat(typeof packet === "object" && packet !== null && !Array.isArray(packet));
	const keys = Reflect.ownKeys(packet);
	requireFormat(
		keys.length === 4 &&
			["body", "timestamp", "nonce", "signature"].every((key) => keys.includes(key)),
	);
	const fields = packet as Record<string, unknown>;
	const { body, timestamp, nonce, signature } = fields;
	const bodyBytes = decodeBodyBase64Url(body);
	const decoded = decodeKnownBody(bodyBytes);
	const metadata = validatePacketMetadata(timestamp, nonce, decoded.value.createdAt);
	requireFormat(
		typeof signature === "string" && signature.length === 91 && signature.startsWith("v2:"),
	);
	const signatureBytes = decodeOrdinaryBase64(signature.slice(3));
	requireFormat(signatureBytes.length === 64);
	// Preserve the decoded original bytes for verification, never reconstructed JSON.
	return { ...decoded, bodyBytes, ...metadata, signatureBytes };
}

export interface RelayAdmissionTimeBudget {
	readonly decidedAtMs: number;
	readonly remainingMs: number;
}

/** Uses one validated snapshot and one rounded clock for both coordinator reply fields. */
export function getRelayAdmissionTimeBudget(
	value: RelayAdmissionBody,
	decisionNowMs: number,
): RelayAdmissionTimeBudget {
	const body = decodeRelayAdmissionBody(encodeRelayAdmissionBody(value));
	requireFormat(typeof decisionNowMs === "number" && Number.isFinite(decisionNowMs));
	const nowMs = Math.ceil(decisionNowMs);
	requireFormat(Number.isSafeInteger(nowMs) && nowMs >= 0);
	requireFormat(body.createdAt * 1000 <= nowMs + 5000 && nowMs < body.admitBefore * 1000);
	const remainingMs = body.routeNotAfter * 1000 - nowMs;
	requireFormat(Number.isSafeInteger(remainingMs) && remainingMs > 0 && remainingMs <= 60_000);
	return { decidedAtMs: nowMs, remainingMs };
}

/** Seconds belong to the signed body. The injected decision clock and returned lease use milliseconds. */
export function getRelayAdmissionRemainingMs(
	value: RelayAdmissionBody,
	decisionNowMs: number,
): number {
	return getRelayAdmissionTimeBudget(value, decisionNowMs).remainingMs;
}
