/**
 * Device side of rebinding (ADR 0005 Section 8): start an attempt, send the
 * person to Google, receive the loopback, sign, and finalize. Storage-agnostic:
 * the caller durably records the attempt before finalize, and resolves any
 * unknown outcome with resumeDeviceRebind, never by repeating finalize blindly.
 */
import { randomBytes, randomUUID, sign } from "node:crypto";
import {
	type CoordinatorOwnerEnrollmentCompletion,
	createCoordinatorDeviceRebindReceiver,
	normalizeCoordinatorAccountLinkOrigin,
} from "./coordinator-account-link-receiver.js";
import {
	readAccountLinkDevice,
	signAccountLinkRequest,
} from "./coordinator-account-link-signer.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import {
	encodeCoordinatorAuthProof32,
	hashCoordinatorAuthProofBytes32,
} from "./coordinator-auth-proof.js";
import type { CoordinatorDeviceLocalEvidence } from "./coordinator-device-local.js";
import {
	type DeviceRebindAttempt,
	deviceRebindFinalMessage,
} from "./coordinator-device-rebind-proof.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import { verifyOwnerEnrollmentSignature } from "./coordinator-owner-enrollment-proof.js";
import { loadPrivateKey } from "./sync-identity.js";

const ROOT = "/v1/auth/rebind-attempts";
const ATTEMPT_TTL_MS = 600_000;
/**
 * Margin past the server's deadline before resume calls an attempt
 * uncommitted. The deadline is server time and the check uses the local
 * clock, so this absorbs clock skew as well as a commit in flight at expiry.
 */
const EXPIRY_MARGIN_MS = 15 * 60_000;
const MAX_REPLY_BYTES = 16_384;
const REFUSALS = [
	"unavailable",
	"current_identity_linked",
	"device_already_bound",
	"account_not_linked",
	"already_this_identity",
	"daily_limit",
	"retry",
] as const;
export type DeviceRebindClientRefusal = (typeof REFUSALS)[number];

export interface DeviceRebindReceiptV1 {
	attemptId: string;
	bindingId: string;
	deviceId: string;
	previousIdentityId: string;
	targetIdentityId: string;
	enrollmentCount: number;
	finalizedAtMs: number;
}

/** What the caller must store durably before finalize, to resume by status. */
export interface DeviceRebindPending {
	attemptId: string;
	coordinatorOrigin: string;
	groupId: string;
	deviceId: string;
	previousIdentityId: string;
	targetIdentityId: string;
	reviewDigest: string;
	expiresAtMs: number;
}

export type DeviceRebindOutcome =
	| { kind: "finalized"; receipt: DeviceRebindReceiptV1 }
	/** `beforeBrowser`: the coordinator refused the start, so no Google trip happened. */
	| { kind: "refused"; reason: DeviceRebindClientRefusal; beforeBrowser?: true }
	/** Nothing was committed; the person may start again. */
	| { kind: "failed"; error: "device_unavailable" | "request_failed" | "browser_stopped" }
	/** Finalize may have committed; resolve with resumeDeviceRebind. */
	| { kind: "unknown"; pending: DeviceRebindPending };

export interface DeviceRebindOptions {
	dbPath: string;
	keysDir?: string;
	coordinatorUrl: string;
	groupId: string;
	/** The device's current Identity, which the coordinator checks against its enrollments. */
	currentIdentityId: string;
	/** SHA-256 hex of the device's local review; it is pinned and signed. */
	reviewDigest: string;
	openBrowser(url: string): void | Promise<void>;
	/** Must persist durably; a throw stops the rebind before finalize. */
	recordPending(pending: DeviceRebindPending): void | Promise<void>;
	fetch?: typeof globalThis.fetch;
	signal?: AbortSignal;
}

interface Connection {
	origin: string;
	groupId: string;
	dbPath: string;
	keysDir?: string;
	device: CoordinatorDeviceLocalEvidence;
	fetch: typeof globalThis.fetch;
	signal: AbortSignal;
}
type Reply = { status: number; data: Record<string, unknown> | null };
type Pins = {
	coordinator_id: string;
	origin: string;
	issuer: string;
	auth_config_revision: string;
};
type Status = {
	state: string;
	expiresAtMs: number;
	targetIdentityId: string | null;
	receipt: DeviceRebindReceiptV1 | null;
};

const isHash = (value: unknown): value is string =>
	typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

/** Races work the caller or transport supplied, which may ignore the signal. */
async function abortable<T>(operation: T | Promise<T>, signal: AbortSignal): Promise<T> {
	let onAbort = () => {};
	try {
		const aborted = new Promise<never>((_, reject) => {
			onAbort = () => reject(new Error("Device rebind stopped."));
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
		});
		return await Promise.race([Promise.resolve(operation), aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

/** Streams with a byte cap; an oversized or malformed reply is null. */
async function boundedJson(response: Response): Promise<Record<string, unknown> | null> {
	if (!response.body) return null;
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (let read = await reader.read(); !read.done; read = await reader.read()) {
			size += read.value.byteLength;
			if (size > MAX_REPLY_BYTES) return null;
			chunks.push(read.value);
		}
		const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	} finally {
		await reader.cancel().catch(() => {});
	}
}

async function send(
	c: Connection,
	method: "GET" | "POST",
	path: string,
	body?: Record<string, string>,
): Promise<Reply> {
	const url = `${c.origin}${path}`;
	const bodyBytes = Buffer.from(body ? JSON.stringify(body) : "");
	const headers = signAccountLinkRequest({
		dbPath: c.dbPath,
		keysDir: c.keysDir,
		device: c.device,
		method,
		url,
		bodyBytes,
	});
	const signal = AbortSignal.any([AbortSignal.timeout(10_000), c.signal]);
	const response = await abortable(
		c.fetch(url, {
			method,
			headers: { ...headers, "Content-Type": "application/json" },
			body: method === "POST" ? bodyBytes : undefined,
			signal,
			redirect: "manual",
		}),
		signal,
	);
	return { status: response.status, data: await abortable(boundedJson(response), signal) };
}

function refusal(reply: Reply): DeviceRebindClientRefusal | null {
	const reason = reply.data?.reason;
	if (
		(reply.status !== 403 && reply.status !== 409) ||
		reply.data?.error !== "device_rebind_refused" ||
		!REFUSALS.includes(reason as DeviceRebindClientRefusal)
	)
		return null;
	return reason as DeviceRebindClientRefusal;
}

function parseReceipt(value: unknown): DeviceRebindReceiptV1 | null {
	if (!value || typeof value !== "object") return null;
	const r = value as Record<string, unknown>;
	const ids = [
		r.attempt_id,
		r.binding_id,
		r.device_id,
		r.previous_identity_id,
		r.target_identity_id,
	];
	if (
		!ids.every(isAuthControllerId) ||
		!Number.isSafeInteger(r.enrollment_count) ||
		!Number.isSafeInteger(r.finalized_at_ms)
	)
		return null;
	return {
		attemptId: r.attempt_id as string,
		bindingId: r.binding_id as string,
		deviceId: r.device_id as string,
		previousIdentityId: r.previous_identity_id as string,
		targetIdentityId: r.target_identity_id as string,
		enrollmentCount: r.enrollment_count as number,
		finalizedAtMs: r.finalized_at_ms as number,
	};
}

/** The receipt must describe exactly the switch this device recorded. */
function matchesPending(receipt: DeviceRebindReceiptV1 | null, p: DeviceRebindPending) {
	return (
		!!receipt &&
		receipt.attemptId === p.attemptId &&
		receipt.deviceId === p.deviceId &&
		receipt.previousIdentityId === p.previousIdentityId &&
		receipt.targetIdentityId === p.targetIdentityId
	);
}

async function readStatus(c: Connection, attemptId: string): Promise<Status | null> {
	const query = new URLSearchParams({ group_id: c.groupId });
	const reply = await send(c, "GET", `${ROOT}/${encodeURIComponent(attemptId)}?${query}`);
	const d = reply.data;
	if (reply.status !== 200 || !d || typeof d.state !== "string") return null;
	if (!Number.isSafeInteger(d.expires_at_ms)) return null;
	const target = d.target_identity_id;
	if (target !== null && !isAuthControllerId(target)) return null;
	return {
		state: d.state,
		expiresAtMs: d.expires_at_ms as number,
		targetIdentityId: target as string | null,
		receipt: d.receipt === null ? null : parseReceipt(d.receipt),
	};
}

function connect(options: DeviceRebindOptions | ResumeOptions, signal: AbortSignal) {
	const origin = normalizeCoordinatorAccountLinkOrigin(options.coordinatorUrl);
	if (!origin || !isAuthControllerId(options.groupId)) return null;
	try {
		const device = readAccountLinkDevice(options.dbPath);
		return {
			origin,
			groupId: options.groupId,
			dbPath: options.dbPath,
			keysDir: options.keysDir,
			device,
			fetch: options.fetch ?? globalThis.fetch,
			signal,
		} satisfies Connection;
	} catch {
		return null;
	}
}

async function start(
	c: Connection,
	input: { attemptId: string; startHash: string; loopback: string; options: DeviceRebindOptions },
): Promise<Pins | DeviceRebindOutcome> {
	const reply = await send(c, "POST", ROOT, {
		group_id: c.groupId,
		identity_id: input.options.currentIdentityId,
		attempt_id: input.attemptId,
		browser_start_hash: input.startHash,
		loopback_redirect: input.loopback,
		review_digest: input.options.reviewDigest,
	});
	const d = reply.data;
	if (
		reply.status === 200 &&
		d?.attempt_id === input.attemptId &&
		d.origin === c.origin &&
		typeof d.coordinator_id === "string" &&
		typeof d.issuer === "string" &&
		isHash(d.auth_config_revision)
	)
		return d as unknown as Pins;
	const reason = refusal(reply);
	return reason
		? { kind: "refused", reason, beforeBrowser: true }
		: { kind: "failed", error: "request_failed" };
}

async function signFinal(
	c: Connection,
	input: {
		pins: Pins;
		pending: DeviceRebindPending;
		completion: CoordinatorOwnerEnrollmentCompletion;
	},
): Promise<string | null> {
	const { pins, pending, completion } = input;
	const privateKey = loadPrivateKey(c.keysDir, undefined, c.device.deviceId);
	const keyId = await ed25519KeyId(c.device.publicKey);
	if (!privateKey || !keyId) return null;
	const signed = {
		...pins,
		attempt_id: pending.attemptId,
		device_id: c.device.deviceId,
		public_key: c.device.publicKey,
		key_id: keyId,
		fingerprint: c.device.fingerprint,
		current_identity_id: pending.previousIdentityId,
		target_identity_id: pending.targetIdentityId,
		review_digest: pending.reviewDigest,
		confirmation_hash: completion.confirmationHash,
	} as DeviceRebindAttempt;
	const message = deviceRebindFinalMessage(signed, completion.completionSecret);
	const signature = sign(null, Buffer.from(message), privateKey).toString("base64url");
	// A key that no longer matches the enrolled one would only be refused remotely.
	return (await verifyOwnerEnrollmentSignature(c.device.publicKey, message, signature))
		? signature
		: null;
}

/**
 * Finalize once, and once more after a `retry` refusal. Anything not clearly
 * committed or refused is resolved by reading status.
 */
async function finalize(
	c: Connection,
	pending: DeviceRebindPending,
	body: { completion: string; signature: string },
): Promise<DeviceRebindOutcome> {
	const path = `${ROOT}/${encodeURIComponent(pending.attemptId)}/finalize`;
	for (let tries = 0; tries < 2; tries += 1) {
		let reply: Reply;
		try {
			reply = await send(c, "POST", path, { group_id: c.groupId, ...body });
		} catch {
			break;
		}
		const receipt = parseReceipt(reply.data?.receipt);
		if (reply.status === 200 && matchesPending(receipt, pending) && receipt)
			return { kind: "finalized", receipt };
		const reason = refusal(reply);
		if (reason && reason !== "retry") return { kind: "refused", reason };
		if (reason !== "retry") break;
	}
	return resolve(c, pending);
}

async function resolve(c: Connection, pending: DeviceRebindPending): Promise<DeviceRebindOutcome> {
	try {
		const status = await readStatus(c, pending.attemptId);
		if (status?.state === "finalized" && matchesPending(status.receipt, pending) && status.receipt)
			return { kind: "finalized", receipt: status.receipt };
	} catch {}
	return { kind: "unknown", pending };
}

async function runCeremony(
	c: Connection,
	options: DeviceRebindOptions,
	receiver: Awaited<ReturnType<typeof createCoordinatorDeviceRebindReceiver>>,
	run: { attemptId: string; recorded?: DeviceRebindPending },
): Promise<DeviceRebindOutcome> {
	const { attemptId } = run;
	const code = randomBytes(32);
	const startHash = await hashCoordinatorAuthProofBytes32(code);
	const started = await start(c, { attemptId, startHash, loopback: receiver.destination, options });
	if ("kind" in started) return started;
	const query = new URLSearchParams({
		attempt_id: attemptId,
		start_code: encodeCoordinatorAuthProof32(code),
	});
	code.fill(0);
	await abortable(options.openBrowser(`${c.origin}/auth/rebind/start?${query}`), c.signal);
	const delivery = await receiver.completion;
	// The browser ended the attempt before confirmation; nothing was recorded or signed.
	if (delivery.kind === "refused") return { kind: "refused", reason: delivery.reason };
	const completion = delivery;
	const status = await readStatus(c, attemptId);
	if (status?.state !== "confirmed" || !status.targetIdentityId)
		return { kind: "failed", error: "request_failed" };
	const pending: DeviceRebindPending = {
		attemptId,
		coordinatorOrigin: c.origin,
		groupId: c.groupId,
		deviceId: c.device.deviceId,
		previousIdentityId: options.currentIdentityId,
		targetIdentityId: status.targetIdentityId,
		reviewDigest: options.reviewDigest,
		expiresAtMs: status.expiresAtMs,
	};
	const signature = await signFinal(c, { pins: started, pending, completion });
	if (!signature) return { kind: "failed", error: "device_unavailable" };
	await abortable(options.recordPending(pending), c.signal);
	run.recorded = pending;
	return finalize(c, pending, { completion: completion.completionSecret, signature });
}

export async function runDeviceRebind(options: DeviceRebindOptions): Promise<DeviceRebindOutcome> {
	if (!isAuthControllerId(options.currentIdentityId) || !isHash(options.reviewDigest))
		return { kind: "failed", error: "device_unavailable" };
	const signal = AbortSignal.any([
		AbortSignal.timeout(ATTEMPT_TTL_MS),
		...(options.signal ? [options.signal] : []),
	]);
	const c = connect(options, signal);
	if (!c) return { kind: "failed", error: "device_unavailable" };
	const attemptId = randomUUID();
	let receiver: Awaited<ReturnType<typeof createCoordinatorDeviceRebindReceiver>>;
	try {
		receiver = await createCoordinatorDeviceRebindReceiver({ attemptId, signal });
	} catch {
		return { kind: "failed", error: "browser_stopped" };
	}
	const run: { attemptId: string; recorded?: DeviceRebindPending } = { attemptId };
	try {
		return await runCeremony(c, options, receiver, run);
	} catch {
		// Finalize may only be sent after recording, so a recorded attempt is never "failed".
		if (run.recorded) return { kind: "unknown", pending: run.recorded };
		return { kind: "failed", error: signal.aborted ? "browser_stopped" : "request_failed" };
	} finally {
		await receiver.close().catch(() => {});
	}
}

export interface ResumeOptions {
	dbPath: string;
	keysDir?: string;
	coordinatorUrl: string;
	groupId: string;
	pending: DeviceRebindPending;
	fetch?: typeof globalThis.fetch;
	signal?: AbortSignal;
	now?: () => number;
}

/**
 * Reads the recorded attempt. `not_committed` only once the attempt can no
 * longer finalize; otherwise an unclear answer stays `unknown`.
 */
export async function resumeDeviceRebind(
	options: ResumeOptions,
): Promise<
	| { kind: "finalized"; receipt: DeviceRebindReceiptV1 }
	| { kind: "not_committed" }
	| { kind: "unknown" }
> {
	const c = connect(options, options.signal ?? AbortSignal.timeout(30_000));
	const { pending } = options;
	if (
		!c ||
		pending.coordinatorOrigin !== c.origin ||
		pending.groupId !== c.groupId ||
		pending.deviceId !== c.device.deviceId
	)
		return { kind: "unknown" };
	try {
		const status = await readStatus(c, options.pending.attemptId);
		if (!status) return { kind: "unknown" };
		if (status.state === "finalized")
			return matchesPending(status.receipt, options.pending) && status.receipt
				? { kind: "finalized", receipt: status.receipt }
				: { kind: "unknown" };
		const now = (options.now ?? Date.now)();
		return status.expiresAtMs + EXPIRY_MARGIN_MS <= now
			? { kind: "not_committed" }
			: { kind: "unknown" };
	} catch {
		return { kind: "unknown" };
	}
}
