import { sign } from "node:crypto";
import { normalizeCoordinatorAccountLinkOrigin } from "./coordinator-account-link-receiver.js";
import { readAccountLinkDevice } from "./coordinator-account-link-signer.js";
import { abortable, boundedJson, discard } from "./coordinator-account-link-status-client.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import { parseCoordinatorAuthLoopback } from "./coordinator-auth-loopback.js";
import { decodeCoordinatorAuthProof32 } from "./coordinator-auth-proof.js";
import {
	type DeviceRejoinProof,
	deviceRejoinProofMessage,
	verifyDeviceRejoinProof,
} from "./coordinator-device-rejoin-proof.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import { loadPrivateKey } from "./sync-identity.js";

const ROOT = "/v1/auth/rejoin-attempts";
const TTL_MS = 600_000;
const CLOCK_SKEW_MS = 300_000;
const STATES = [
	"pending",
	"browser_claimed",
	"oidc_verified",
	"confirmed",
	"finalized",
	"expired",
	"failed",
] as const;
const REFUSALS = [
	"unavailable",
	"blocked",
	"removal_conflict",
	"removal_changed",
	"account_not_linked",
	"wrong_account",
	"no_destination",
	"daily_limit",
	"retry",
] as const;
const HASH = /^[a-f0-9]{64}$/u;

export type DeviceRejoinClientRefusal = (typeof REFUSALS)[number];
export type DeviceRejoinRequestFailure =
	| { kind: "refused"; reason: DeviceRejoinClientRefusal }
	| { kind: "unknown" };

export interface DeviceRejoinClientPins {
	readonly attemptId: string;
	readonly coordinatorId: string;
	readonly issuer: string;
	readonly authConfigRevision: string;
	readonly identityId: string;
	readonly bindingId: string;
	readonly removalDigest: string;
	readonly expiresAtMs: number;
}

export interface DeviceRejoinClientReceipt {
	attemptId: string;
	deviceId: string;
	identityId: string;
	bindingId: string;
	groupIds: string[];
	liftedRemovalSeqs: number[];
	finalizedAtMs: number;
}

interface Options {
	dbPath: string;
	keysDir?: string;
	coordinatorUrl: string;
	fetch?: typeof globalThis.fetch;
	signal?: AbortSignal;
	now?: () => number;
	assertCurrentContext?: () => boolean;
}

type Start = { attemptId: string; browserStartHash: string; loopbackRedirect: string };
type Completion = { completionSecret: string; confirmationHash: string };
type Status =
	| { kind: "status"; state: Exclude<(typeof STATES)[number], "finalized"> }
	| { kind: "status"; state: "finalized"; receipt: DeviceRejoinClientReceipt };
type Reply = { status: number; body: Record<string, unknown> | null };
type Signer = Pick<DeviceRejoinProof, "origin" | "deviceId" | "keyId">;
interface RequestContext {
	signer: Signer;
	device: ReturnType<typeof readAccountLinkDevice>;
	now(): number;
	request(
		proof: DeviceRejoinProof,
		path: string,
		body: Record<string, string | number>,
	): Promise<Reply>;
}

function object(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function failure(reply: Reply): DeviceRejoinRequestFailure {
	if (reply.status === 403 && reply.body?.error === "device_rejoin_unavailable")
		return { kind: "refused", reason: "unavailable" };
	const reason = reply.body?.reason;
	if (
		typeof reason === "string" &&
		REFUSALS.includes(reason as DeviceRejoinClientRefusal) &&
		reply.body?.error === "device_rejoin_refused" &&
		reply.status === (reason === "retry" ? 409 : 403)
	)
		return { kind: "refused", reason: reason as DeviceRejoinClientRefusal };
	return { kind: "unknown" };
}

function isTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readStartPins(
	reply: Reply,
	origin: string,
	attemptId: string,
	now: number,
): DeviceRejoinClientPins | null {
	const p = reply.body;
	if (
		reply.status !== 200 ||
		p?.attempt_id !== attemptId ||
		p.origin !== origin ||
		!isAuthControllerId(p.coordinator_id) ||
		!isAuthControllerId(p.issuer) ||
		!isAuthControllerId(p.identity_id) ||
		!isAuthControllerId(p.binding_id) ||
		typeof p.auth_config_revision !== "string" ||
		!HASH.test(p.auth_config_revision) ||
		typeof p.removal_digest !== "string" ||
		!HASH.test(p.removal_digest) ||
		!isTimestamp(p.expires_at_ms) ||
		p.expires_at_ms <= now ||
		p.expires_at_ms > now + TTL_MS + CLOCK_SKEW_MS
	)
		return null;
	return Object.freeze({
		attemptId,
		coordinatorId: p.coordinator_id,
		issuer: p.issuer,
		authConfigRevision: p.auth_config_revision,
		identityId: p.identity_id,
		bindingId: p.binding_id,
		removalDigest: p.removal_digest,
		expiresAtMs: p.expires_at_ms,
	});
}

function isSequenceList(value: unknown): value is number[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((seq, index) => isTimestamp(seq) && seq > (index === 0 ? 0 : value[index - 1]))
	);
}

function readReceipt(
	value: unknown,
	pins: DeviceRejoinClientPins,
	deviceId: string,
): DeviceRejoinClientReceipt | null {
	const r = object(value);
	if (
		!r ||
		r.attempt_id !== pins.attemptId ||
		r.device_id !== deviceId ||
		r.identity_id !== pins.identityId ||
		r.binding_id !== pins.bindingId ||
		!Array.isArray(r.group_ids) ||
		r.group_ids.length === 0 ||
		!r.group_ids.every(isAuthControllerId) ||
		new Set(r.group_ids).size !== r.group_ids.length ||
		!isSequenceList(r.lifted_removal_seqs) ||
		!isTimestamp(r.finalized_at_ms) ||
		r.finalized_at_ms < pins.expiresAtMs - TTL_MS ||
		r.finalized_at_ms >= pins.expiresAtMs
	)
		return null;
	return {
		attemptId: pins.attemptId,
		deviceId,
		identityId: pins.identityId,
		bindingId: pins.bindingId,
		groupIds: [...r.group_ids],
		liftedRemovalSeqs: [...r.lifted_removal_seqs],
		finalizedAtMs: r.finalized_at_ms,
	};
}

async function send(
	t: { origin: string; fetch: typeof globalThis.fetch; signal: AbortSignal },
	path: string,
	body: Record<string, string | number>,
): Promise<Reply> {
	const signal = AbortSignal.any([t.signal, AbortSignal.timeout(10_000)]);
	signal.throwIfAborted();
	const response = await abortable(
		t.fetch(`${t.origin}${path}`, {
			method: "POST",
			body: JSON.stringify(body),
			headers: { "Content-Type": "application/json" },
			redirect: "manual",
			credentials: "omit",
			signal,
		}),
		signal,
	);
	if (![200, 403, 409].includes(response.status)) {
		discard(response);
		return { status: response.status, body: null };
	}
	return { status: response.status, body: object(await boundedJson(response, signal)) };
}

async function connect(options: Options): Promise<RequestContext | null> {
	const { dbPath, keysDir, assertCurrentContext = () => true } = options;
	const origin = normalizeCoordinatorAccountLinkOrigin(options.coordinatorUrl);
	if (!origin) return null;
	const transport = {
		origin,
		fetch: options.fetch ?? globalThis.fetch,
		signal: options.signal ?? new AbortController().signal,
	};
	const now = options.now ?? (() => Date.now());
	const device = Object.freeze(readAccountLinkDevice(dbPath));
	const keyId = await ed25519KeyId(device.publicKey);
	if (!keyId) return null;
	const signer = { origin, deviceId: device.deviceId, keyId };
	function checkDevice() {
		if (!assertCurrentContext()) throw new Error("Device rejoin setup changed");
		const current = readAccountLinkDevice(dbPath);
		if (
			current.deviceId !== device.deviceId ||
			current.publicKey !== device.publicKey ||
			current.fingerprint !== device.fingerprint
		)
			throw new Error("Device rejoin key changed");
	}
	async function request(
		proof: DeviceRejoinProof,
		path: string,
		body: Record<string, string | number>,
	): Promise<Reply> {
		checkDevice();
		const privateKey = loadPrivateKey(keysDir, undefined, device.deviceId);
		if (!privateKey) throw new Error("Device rejoin key unavailable");
		const signature = sign(null, Buffer.from(deviceRejoinProofMessage(proof)), privateKey).toString(
			"base64url",
		);
		if (
			!(await verifyDeviceRejoinProof(proof, { signature, tombstonePublicKey: device.publicKey }))
		)
			throw new Error("Device rejoin key does not match");
		checkDevice();
		return send(transport, path, { device_id: device.deviceId, ...body, signature });
	}
	return { device, now, signer, request };
}

async function start(
	c: RequestContext,
	input: Start,
): Promise<{ kind: "started"; pins: DeviceRejoinClientPins } | DeviceRejoinRequestFailure> {
	const { attemptId, browserStartHash, loopbackRedirect } = input;
	const timestampMs = c.now();
	if (
		!isTimestamp(timestampMs) ||
		!isAuthControllerId(attemptId) ||
		!HASH.test(browserStartHash) ||
		!parseCoordinatorAuthLoopback(loopbackRedirect).ok
	)
		return { kind: "unknown" };
	try {
		const reply = await c.request(
			{
				...c.signer,
				operation: "start",
				attemptId,
				publicKey: c.device.publicKey,
				browserStartHash,
				loopbackRedirect,
				timestampMs,
			},
			ROOT,
			{
				attempt_id: attemptId,
				public_key: c.device.publicKey,
				browser_start_hash: browserStartHash,
				loopback_redirect: loopbackRedirect,
				timestamp_ms: timestampMs,
			},
		);
		const pins = readStartPins(reply, c.signer.origin, attemptId, timestampMs);
		return pins ? { kind: "started", pins } : failure(reply);
	} catch {
		return { kind: "unknown" };
	}
}

async function status(
	c: RequestContext,
	input: DeviceRejoinClientPins,
): Promise<Status | DeviceRejoinRequestFailure> {
	const pins = { ...input };
	const timestampMs = c.now();
	if (
		!isTimestamp(timestampMs) ||
		!isAuthControllerId(pins.attemptId) ||
		timestampMs >= pins.expiresAtMs
	)
		return { kind: "unknown" };
	try {
		const reply = await c.request(
			{ ...c.signer, operation: "status", attemptId: pins.attemptId, timestampMs },
			`${ROOT}/${encodeURIComponent(pins.attemptId)}/status`,
			{ timestamp_ms: timestampMs },
		);
		const state = reply.body?.state as (typeof STATES)[number];
		if (
			reply.status !== 200 ||
			!STATES.includes(state) ||
			reply.body?.expires_at_ms !== pins.expiresAtMs
		)
			return failure(reply);
		if (state !== "finalized") return { kind: "status", state };
		const receipt = readReceipt(reply.body.receipt, pins, c.device.deviceId);
		return receipt ? { kind: "status", state, receipt } : { kind: "unknown" };
	} catch {
		return { kind: "unknown" };
	}
}

async function finalize(
	c: RequestContext,
	input: DeviceRejoinClientPins,
	delivery: Completion,
): Promise<{ kind: "finalized"; receipt: DeviceRejoinClientReceipt } | DeviceRejoinRequestFailure> {
	const pins = { ...input };
	const {
		attemptId,
		coordinatorId,
		issuer,
		authConfigRevision,
		identityId,
		bindingId,
		removalDigest,
	} = pins;
	const { completionSecret, confirmationHash } = delivery;
	if (
		!isAuthControllerId(attemptId) ||
		!decodeCoordinatorAuthProof32(completionSecret) ||
		!HASH.test(confirmationHash)
	)
		return { kind: "unknown" };
	try {
		const reply = await c.request(
			{
				...c.signer,
				operation: "finalize",
				attemptId,
				coordinatorId,
				issuer,
				authConfigRevision,
				identityId,
				bindingId,
				removalDigest,
				publicKey: c.device.publicKey,
				fingerprint: c.device.fingerprint,
				confirmation: confirmationHash,
				completion: completionSecret,
			},
			`${ROOT}/${encodeURIComponent(attemptId)}/finalize`,
			{ completion: completionSecret },
		);
		if (
			reply.status !== 200 ||
			(reply.body?.state !== "finalized" && reply.body?.state !== "prior_commit")
		)
			return failure(reply);
		const receipt = readReceipt(reply.body.receipt, pins, c.device.deviceId);
		return receipt ? { kind: "finalized", receipt } : { kind: "unknown" };
	} catch {
		return { kind: "unknown" };
	}
}

/** Requests only. The caller owns the loopback, durable recovery, and local sync changes. */
export async function createDeviceRejoinRequests(options: Options) {
	try {
		const c = await connect(options);
		if (!c) return null;
		return {
			origin: c.signer.origin,
			device: c.device,
			start: (input: Start) => start(c, input),
			status: (pins: DeviceRejoinClientPins) => status(c, pins),
			finalize: (pins: DeviceRejoinClientPins, delivery: Completion) => finalize(c, pins, delivery),
		};
	} catch {
		return null;
	}
}
