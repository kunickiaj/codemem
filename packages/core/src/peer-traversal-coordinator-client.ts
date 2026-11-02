import type { TraversalSignalDecision } from "./peer-traversal-coordinator-decision.js";
import {
	decodeTraversalSignalPacket,
	encodeTraversalSignalPacket,
	TRAVERSAL_SIGNAL_PATH_SUFFIX,
	type TraversalSignalPhase,
} from "./peer-traversal-signal-codec.js";

export interface TraversalDecisionLease {
	readonly decision: TraversalSignalDecision;
	readonly deadlineMs: number;
}
export interface TraversalSignalClientOptions {
	readonly packet: unknown;
	readonly expectedPhase: TraversalSignalPhase;
	readonly localDeviceId: string;
	readonly namespace: { readonly authorityId: string; readonly groupId: string };
	readonly externalPathname: string;
	readonly deadlineMs: number;
	readonly previousLease?: TraversalDecisionLease;
	readonly signal?: AbortSignal;
}
export interface TraversalSignalClientRequest {
	readonly method: "POST";
	readonly bodyBytes: Uint8Array;
	readonly timestamp: string;
	readonly nonce: string;
	readonly signature: string;
	readonly deviceHeader: string;
	readonly expectedPhase: TraversalSignalPhase;
	readonly namespace: { readonly authorityId: string; readonly groupId: string };
	readonly externalPathname: string;
	readonly deadlineMs: number;
	readonly signal?: AbortSignal;
}
export interface TraversalSignalClientResponse {
	readonly status: number;
	readonly bodyBytes: Uint8Array;
}
export interface TraversalSignalClientDependencies {
	readonly send: (request: TraversalSignalClientRequest) => Promise<TraversalSignalClientResponse>;
	readonly now?: () => number;
}

function exactFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const keys = Reflect.ownKeys(value);
	return keys.length === fields.length && fields.every((field) => keys.includes(field));
}

function isExternalPath(value: unknown): value is string {
	if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return false;
	if (!value.endsWith(TRAVERSAL_SIGNAL_PATH_SUFFIX)) return false;
	return !Array.from(value).some((character) => {
		const code = character.codePointAt(0) ?? 0;
		return (
			code <= 32 ||
			(code >= 127 && code <= 159) ||
			(code >= 0xd800 && code <= 0xdfff) ||
			"?#\\".includes(character)
		);
	});
}

function liveClock(now: number, floor: number, deadline: number, signal?: AbortSignal): boolean {
	return Number.isFinite(now) && now >= floor && now < deadline && !signal?.aborted;
}

function capturePrevious(
	previous: TraversalDecisionLease | undefined,
	body: ReturnType<typeof decodeTraversalSignalPacket>["value"],
	start: number,
) {
	if (previous === undefined) return { deadlineMs: Infinity, policyRevision: null };
	const { decision, deadlineMs } = previous;
	const { sessionId, attemptNotAfter, policyRevision } = decision;
	if (
		sessionId !== body.sessionId ||
		attemptNotAfter !== body.attemptNotAfter ||
		typeof policyRevision !== "number" ||
		!Number.isSafeInteger(policyRevision) ||
		policyRevision <= 0 ||
		!Number.isFinite(deadlineMs) ||
		deadlineMs <= start
	)
		return null;
	return { deadlineMs, policyRevision };
}

function capturePorts(deps: TraversalSignalClientDependencies) {
	const { send, now: clock } = deps;
	if (typeof send !== "function" || (clock !== undefined && typeof clock !== "function"))
		return null;
	const now = clock === undefined ? performance.now.bind(performance) : clock.bind(deps);
	return { now, send: send.bind(deps) };
}

function captureNamespace(namespace: TraversalSignalClientOptions["namespace"]) {
	if (!exactFields(namespace, ["authorityId", "groupId"])) return null;
	return Object.freeze({ authorityId: namespace.authorityId, groupId: namespace.groupId });
}

function captureInputs(
	options: TraversalSignalClientOptions,
	deps: TraversalSignalClientDependencies,
) {
	const {
		packet,
		expectedPhase,
		localDeviceId,
		namespace,
		externalPathname,
		deadlineMs,
		previousLease,
		signal,
	} = options;
	const ports = capturePorts(deps);
	if (!ports) return null;
	const ownedNamespace = captureNamespace(namespace);
	if (!ownedNamespace || !isExternalPath(externalPathname)) return null;
	const decoded = decodeTraversalSignalPacket(packet);
	const body = decoded.value;
	const deviceId =
		body.phase === "offer-check" || body.phase === "answer"
			? body.targetDeviceId
			: body.sourceDeviceId;
	if (
		body.phase !== expectedPhase ||
		body.authorityId !== ownedNamespace.authorityId ||
		body.groupId !== ownedNamespace.groupId ||
		deviceId !== localDeviceId
	)
		return null;
	if (signal !== undefined && (!(signal instanceof AbortSignal) || signal.aborted)) return null;
	const start = ports.now();
	if (
		!Number.isFinite(deadlineMs) ||
		!liveClock(start, 0, deadlineMs, signal) ||
		deadlineMs - start > 60000
	)
		return null;
	const previous = capturePrevious(previousLease, body, start);
	if (!previous) return null;
	const headers = encodeTraversalSignalPacket(decoded);
	const request: TraversalSignalClientRequest = Object.freeze({
		method: "POST",
		bodyBytes: decoded.bodyBytes,
		timestamp: headers.timestamp,
		nonce: headers.nonce,
		signature: headers.signature,
		deviceHeader: localDeviceId,
		expectedPhase,
		namespace: ownedNamespace,
		externalPathname,
		deadlineMs: Math.min(deadlineMs, previous.deadlineMs),
		signal,
	});
	return { body, request, start, previous, ...ports };
}

type CapturedInputs = NonNullable<ReturnType<typeof captureInputs>>;
const DECISION_FIELDS = [
	"v",
	"ok",
	"phase",
	"sessionId",
	"packetDigest",
	"requestNonce",
	"decidedAtMs",
	"attemptNotAfter",
	"remainingMs",
	"policyRevision",
	"readyObservedAtMs",
] as const;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const nativeByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const nativeTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get;
const nativeSet = Uint8Array.prototype.set;

function parseResponse(response: TraversalSignalClientResponse): unknown {
	const { status, bodyBytes } = response;
	if (status !== 200 || nativeTag?.call(bodyBytes) !== "Uint8Array") return null;
	const length: number = nativeByteLength?.call(bodyBytes);
	if (!Number.isSafeInteger(length) || length < 1 || length > 1024) return null;
	const copy = new Uint8Array(length);
	nativeSet.call(copy, bodyBytes);
	return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(copy));
}

function validateTimes(value: Record<string, unknown>, body: CapturedInputs["body"]) {
	const { decidedAtMs, remainingMs, readyObservedAtMs } = value;
	if (
		typeof decidedAtMs !== "number" ||
		!Number.isSafeInteger(decidedAtMs) ||
		decidedAtMs < 0 ||
		body.createdAt * 1000 - decidedAtMs > 5000 ||
		decidedAtMs >= body.admitBefore * 1000
	)
		return null;
	if (
		typeof remainingMs !== "number" ||
		!Number.isSafeInteger(remainingMs) ||
		remainingMs <= 0 ||
		remainingMs > 60000 ||
		remainingMs !== body.attemptNotAfter * 1000 - decidedAtMs
	)
		return null;
	if (
		typeof readyObservedAtMs !== "number" ||
		!Number.isSafeInteger(readyObservedAtMs) ||
		readyObservedAtMs < 0 ||
		readyObservedAtMs > Number.MAX_SAFE_INTEGER - 50000 ||
		readyObservedAtMs - decidedAtMs > 10000 ||
		readyObservedAtMs + 50000 <= decidedAtMs
	)
		return null;
	return { decidedAtMs, remainingMs, readyObservedAtMs };
}

function validateDecision(
	value: unknown,
	input: CapturedInputs,
	digest: string,
): TraversalSignalDecision | null {
	if (!exactFields(value, DECISION_FIELDS)) return null;
	const { v, ok, phase, sessionId, packetDigest, requestNonce, attemptNotAfter, policyRevision } =
		value;
	const { body, request, previous } = input;
	if (
		v !== 1 ||
		ok !== true ||
		phase !== body.phase ||
		sessionId !== body.sessionId ||
		packetDigest !== digest ||
		requestNonce !== request.nonce ||
		attemptNotAfter !== body.attemptNotAfter
	)
		return null;
	if (
		typeof policyRevision !== "number" ||
		!Number.isSafeInteger(policyRevision) ||
		policyRevision <= 0 ||
		(previous.policyRevision !== null && policyRevision !== previous.policyRevision)
	)
		return null;
	const times = validateTimes(value, body);
	if (!times) return null;
	return Object.freeze({
		v,
		ok,
		phase: body.phase,
		sessionId: body.sessionId,
		packetDigest: digest,
		requestNonce: request.nonce,
		attemptNotAfter: body.attemptNotAfter,
		policyRevision,
		...times,
	});
}

/** The trusted send port owns authenticated HTTPS origin, response caps and settlement
 * by the supplied deadline/abort signal. This helper performs one send without retries.
 * Callers must enforce the returned deadline when using descriptions or releasing Noise. */
export async function requestTraversalSignalDecision(
	options: TraversalSignalClientOptions,
	deps: TraversalSignalClientDependencies,
): Promise<TraversalDecisionLease | null> {
	try {
		const input = captureInputs(options, deps);
		if (!input) return null;
		const hashed = await globalThis.crypto.subtle.digest(
			"SHA-256",
			new Uint8Array(input.request.bodyBytes),
		);
		const digest = Array.from(new Uint8Array(hashed), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		const beforeSend = input.now();
		if (!liveClock(beforeSend, input.start, input.request.deadlineMs, input.request.signal))
			return null;
		const response = await input.send(input.request);
		const receivedAt = input.now();
		if (!liveClock(receivedAt, beforeSend, input.request.deadlineMs, input.request.signal))
			return null;
		const decision = validateDecision(parseResponse(response), input, digest);
		if (!decision) return null;
		const deadlineMs = Math.min(input.start + decision.remainingMs, input.request.deadlineMs);
		if (!liveClock(input.now(), receivedAt, deadlineMs, input.request.signal)) return null;
		return Object.freeze({ decision, deadlineMs });
	} catch {
		return null;
	}
}
