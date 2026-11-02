export type TraversalSignalPhase = "prepare" | "offer" | "offer-check" | "answer" | "answer-check";

export interface TraversalSignalCommon {
	authorityId: string;
	groupId: string;
	sourceDeviceId: string;
	sourceKeyId: string;
	targetDeviceId: string;
	targetKeyId: string;
	sessionId: string;
	messageADigest: string;
	createdAt: number;
	admitBefore: number;
	attemptNotAfter: number;
}

export type TraversalSignalBody = TraversalSignalCommon &
	(
		| { phase: "prepare" }
		| { phase: "offer"; prepareDigest: string; descriptionBytes: Uint8Array }
		| { phase: "offer-check"; prepareDigest: string; offerDigest: string }
		| { phase: "answer"; prepareDigest: string; offerDigest: string; descriptionBytes: Uint8Array }
		| { phase: "answer-check"; prepareDigest: string; offerDigest: string; answerDigest: string }
	);

export interface TraversalSignalPacket {
	body: string;
	timestamp: string;
	nonce: string;
	signature: string;
}

export interface DecodedTraversalSignalPacket {
	value: TraversalSignalBody;
	bodyBytes: Uint8Array;
	timestamp: string;
	nonce: string;
	signatureBytes: Uint8Array;
}

export const TRAVERSAL_SIGNAL_SMALL_BODY_BYTES = 1024;
export const TRAVERSAL_SIGNAL_DESCRIPTION_BODY_BYTES = 24576;
export const TRAVERSAL_SIGNAL_MAX_DESCRIPTION_BYTES = 16384;
export const TRAVERSAL_SIGNAL_PATH_SUFFIX = "/v1/traversal/signal";

export class TraversalSignalFormatError extends Error {
	constructor() {
		super("Invalid traversal signal format");
		this.name = "TraversalSignalFormatError";
	}
}

const HEX = /^[0-9a-f]{64}$/;
const SHORT_HEX = /^[0-9a-f]{32}$/;
const DEVICE = /^[\x21-\x7e]{1,64}$/;
const PURPOSE_PREFIX = "codemem-traversal-webrtc-";
const COMMON_FIELDS = [
	"authorityId",
	"groupId",
	"sourceDeviceId",
	"sourceKeyId",
	"targetDeviceId",
	"targetKeyId",
	"sessionId",
	"messageADigest",
	"createdAt",
	"admitBefore",
	"attemptNotAfter",
] as const;
const SUFFIX_FIELDS = {
	prepare: [],
	offer: ["prepareDigest", "descriptionBytes"],
	"offer-check": ["prepareDigest", "offerDigest"],
	answer: ["prepareDigest", "offerDigest", "descriptionBytes"],
	"answer-check": ["prepareDigest", "offerDigest", "answerDigest"],
} as const;
const encoder = new TextEncoder();
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const nativeByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const nativeTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get;
const nativeSet = Uint8Array.prototype.set;

function requireFormat(condition: unknown): asserts condition {
	if (!condition) throw new TraversalSignalFormatError();
}

function formatOperation<T>(operation: () => T): T {
	try {
		return operation();
	} catch {
		throw new TraversalSignalFormatError();
	}
}

function exactFields(
	value: unknown,
	fields: readonly string[],
): asserts value is Record<string, unknown> {
	requireFormat(typeof value === "object" && value !== null && !Array.isArray(value));
	const keys = Reflect.ownKeys(value);
	requireFormat(keys.length === fields.length && fields.every((field) => keys.includes(field)));
}

function stringField(value: unknown, pattern: RegExp, maxLength: number): string {
	requireFormat(
		typeof value === "string" && value.length <= maxLength && pattern.exec(value)?.[0] === value,
	);
	return value;
}

function groupField(value: unknown): string {
	requireFormat(
		typeof value === "string" && value.length >= 1 && value.length <= 128 && value === value.trim(),
	);
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		requireFormat(code >= 32 && code !== 127 && (code < 0xd800 || code > 0xdfff));
	}
	requireFormat(encoder.encode(value).length <= 128);
	return value;
}

function secondsField(value: unknown): number {
	requireFormat(
		typeof value === "number" &&
			Number.isSafeInteger(value) &&
			value >= 0 &&
			Number.isSafeInteger(value * 1000),
	);
	return value;
}

function copyBytes(value: unknown, cap: number): Uint8Array {
	// Native accessors check the internal slots, ignoring shadowed metadata and species.
	requireFormat(nativeTag?.call(value) === "Uint8Array");
	const length: number = nativeByteLength?.call(value);
	requireFormat(Number.isSafeInteger(length) && length >= 1 && length <= cap);
	const copy = new Uint8Array(length);
	nativeSet.call(copy, value as Uint8Array);
	return copy;
}

function ordinaryBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] ?? 0);
	return btoa(binary);
}

function base64Url(bytes: Uint8Array): string {
	return ordinaryBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64(value: string): Uint8Array {
	const binary = atob(value);
	requireFormat(btoa(binary) === value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function decodeBase64Url(value: unknown, cap: number): Uint8Array {
	const text = stringField(value, /^[A-Za-z0-9_-]+$/, Math.ceil((cap * 4) / 3));
	const ordinary = text.replaceAll("-", "+").replaceAll("_", "/");
	const bytes = decodeBase64(ordinary + "=".repeat((4 - (ordinary.length % 4)) % 4));
	requireFormat(bytes.length >= 1 && bytes.length <= cap && base64Url(bytes) === text);
	return bytes;
}

function validateDescription(bytes: Uint8Array): Uint8Array {
	requireFormat(bytes.length >= 1 && bytes.length <= TRAVERSAL_SIGNAL_MAX_DESCRIPTION_BYTES);
	new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	for (const byte of bytes) requireFormat(byte !== 0);
	return bytes;
}

function phaseField(value: unknown): TraversalSignalPhase {
	requireFormat(
		value === "prepare" ||
			value === "offer" ||
			value === "offer-check" ||
			value === "answer" ||
			value === "answer-check",
	);
	return value;
}

function purpose(phase: TraversalSignalPhase): string {
	return `${PURPOSE_PREFIX}${phase}-v1`;
}

function phaseFromPurpose(value: unknown): TraversalSignalPhase {
	requireFormat(typeof value === "string" && value.length <= 40);
	const phase = phaseField(value.slice(PURPOSE_PREFIX.length, -3));
	requireFormat(value === purpose(phase));
	return phase;
}

function bodyCap(phase: TraversalSignalPhase): number {
	if (phase === "offer" || phase === "answer") return TRAVERSAL_SIGNAL_DESCRIPTION_BODY_BYTES;
	return TRAVERSAL_SIGNAL_SMALL_BODY_BYTES;
}

function commonFromArray(fields: unknown[]): TraversalSignalCommon {
	const createdAt = secondsField(fields[9]);
	const admitBefore = secondsField(fields[10]);
	const attemptNotAfter = secondsField(fields[11]);
	requireFormat(admitBefore === createdAt + 30 && attemptNotAfter > 0);
	const sourceDeviceId = stringField(fields[3], DEVICE, 64);
	const targetDeviceId = stringField(fields[5], DEVICE, 64);
	requireFormat(sourceDeviceId !== targetDeviceId);
	return {
		authorityId: stringField(fields[1], HEX, 64),
		groupId: groupField(fields[2]),
		sourceDeviceId,
		sourceKeyId: stringField(fields[4], HEX, 64),
		targetDeviceId,
		targetKeyId: stringField(fields[6], HEX, 64),
		sessionId: stringField(fields[7], SHORT_HEX, 32),
		messageADigest: stringField(fields[8], HEX, 64),
		createdAt,
		admitBefore,
		attemptNotAfter,
	};
}

function bodyFromArray(fields: unknown[]): TraversalSignalBody {
	const phase = phaseFromPurpose(fields[0]);
	requireFormat(fields.length === 12 + SUFFIX_FIELDS[phase].length);
	const common = commonFromArray(fields);
	if (phase === "prepare") {
		requireFormat(common.attemptNotAfter === common.createdAt + 55);
		return { ...common, phase };
	}
	const prepareDigest = stringField(fields[12], HEX, 64);
	if (phase === "offer")
		return {
			...common,
			phase,
			prepareDigest,
			descriptionBytes: validateDescription(
				decodeBase64Url(fields[13], TRAVERSAL_SIGNAL_MAX_DESCRIPTION_BYTES),
			),
		};
	const offerDigest = stringField(fields[13], HEX, 64);
	if (phase === "offer-check") return { ...common, phase, prepareDigest, offerDigest };
	if (phase === "answer")
		return {
			...common,
			phase,
			prepareDigest,
			offerDigest,
			descriptionBytes: validateDescription(
				decodeBase64Url(fields[14], TRAVERSAL_SIGNAL_MAX_DESCRIPTION_BYTES),
			),
		};
	return {
		...common,
		phase,
		prepareDigest,
		offerDigest,
		answerDigest: stringField(fields[14], HEX, 64),
	};
}

function decodeOwnedBody(bytes: Uint8Array): TraversalSignalBody {
	const fields: unknown = JSON.parse(
		new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
	);
	requireFormat(Array.isArray(fields));
	requireFormat(bytes.length <= bodyCap(phaseFromPurpose(fields[0])));
	const value = bodyFromArray(fields);
	const canonical = encoder.encode(JSON.stringify(fields));
	requireFormat(
		canonical.length === bytes.length && canonical.every((byte, i) => byte === bytes[i]),
	);
	return value;
}

/** Format checks only. These claims do not prove signatures, authority, or freshness. */
export function decodeTraversalSignalBody(bytes: unknown): TraversalSignalBody {
	return formatOperation(() =>
		decodeOwnedBody(copyBytes(bytes, TRAVERSAL_SIGNAL_DESCRIPTION_BODY_BYTES)),
	);
}

export function encodeTraversalSignalBody(body: TraversalSignalBody): Uint8Array {
	return formatOperation(() => {
		requireFormat(typeof body === "object" && body !== null);
		const phase = phaseField(body.phase);
		exactFields(body, ["phase", ...COMMON_FIELDS, ...SUFFIX_FIELDS[phase]]);
		const fields: unknown[] = [purpose(phase), ...COMMON_FIELDS.map((key) => body[key])];
		// Validate common strings before JSON or UTF-8 allocation.
		commonFromArray(fields);
		for (const key of SUFFIX_FIELDS[phase]) {
			if (key === "descriptionBytes") {
				fields.push(
					base64Url(
						validateDescription(copyBytes(body[key], TRAVERSAL_SIGNAL_MAX_DESCRIPTION_BYTES)),
					),
				);
			} else {
				fields.push(stringField(body[key], HEX, 64));
			}
		}
		bodyFromArray(fields);
		const bytes = encoder.encode(JSON.stringify(fields));
		requireFormat(bytes.length <= bodyCap(phase));
		return bytes;
	});
}

function packetMetadata(
	timestamp: unknown,
	nonce: unknown,
	createdAt: number,
): { timestamp: string; nonce: string } {
	requireFormat(typeof timestamp === "string" && timestamp === String(createdAt));
	return { timestamp, nonce: stringField(nonce, SHORT_HEX, 32) };
}

/** Portable mailbox envelope only. HTTP POST uses the original raw array bytes. */
export function encodeTraversalSignalPacket(options: {
	bodyBytes: Uint8Array;
	timestamp: string;
	nonce: string;
	signatureBytes: Uint8Array;
}): TraversalSignalPacket {
	return formatOperation(() => {
		const bodyBytes = copyBytes(options.bodyBytes, TRAVERSAL_SIGNAL_DESCRIPTION_BODY_BYTES);
		const value = decodeOwnedBody(bodyBytes);
		const metadata = packetMetadata(options.timestamp, options.nonce, value.createdAt);
		const signatureBytes = copyBytes(options.signatureBytes, 64);
		requireFormat(signatureBytes.length === 64);
		return {
			body: base64Url(bodyBytes),
			...metadata,
			signature: `v2:${ordinaryBase64(signatureBytes)}`,
		};
	});
}

export function decodeTraversalSignalPacket(packet: unknown): DecodedTraversalSignalPacket {
	return formatOperation(() => {
		exactFields(packet, ["body", "timestamp", "nonce", "signature"]);
		const bodyBytes = decodeBase64Url(packet.body, TRAVERSAL_SIGNAL_DESCRIPTION_BODY_BYTES);
		const value = decodeOwnedBody(bodyBytes);
		const metadata = packetMetadata(packet.timestamp, packet.nonce, value.createdAt);
		const signature = stringField(packet.signature, /^v2:[A-Za-z0-9+/]{86}==$/, 91);
		const signatureBytes = decodeBase64(signature.slice(3));
		requireFormat(signatureBytes.length === 64);
		// Retain original bytes for later hashing and verification, never reconstructed JSON.
		return { value, bodyBytes, ...metadata, signatureBytes };
	});
}
