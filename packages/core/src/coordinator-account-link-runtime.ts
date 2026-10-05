import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import {
	type CoordinatorAccountLinkReceiver,
	createCoordinatorAccountLinkReceiver,
} from "./coordinator-account-link-receiver.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import {
	AUTH_LINK_ATTEMPT_TTL_MS,
	AUTH_LINK_PURPOSE,
	type CoordinatorAuthLinkStatus,
} from "./coordinator-auth-link-contract.js";
import {
	encodeCoordinatorAuthProof32,
	hashCoordinatorAuthProofBytes32,
} from "./coordinator-auth-proof.js";
import { buildAuthHeaders, verifySignature } from "./sync-auth.js";
import { DEFAULT_TIME_WINDOW_S } from "./sync-auth-constants.js";
import { fingerprintPublicKey, loadPrivateKey } from "./sync-identity.js";

export interface LinkCoordinatorAccountOptions {
	dbPath: string;
	keysDir?: string;
	groupId: string;
	coordinatorUrl: string;
	loopbackHost?: "127.0.0.1" | "::1";
	signal?: AbortSignal;
	onBrowserStart: (privateUrl: string) => void;
	fetch?: typeof globalThis.fetch;
}
export interface LinkCoordinatorAccountResult {
	coordinatorId: string;
	identityId: string;
	attemptId: string;
	state: "finalized" | "session_redeemed";
}
type Failure =
	| "invalid_options"
	| "device_unavailable"
	| "request_failed"
	| "invalid_response"
	| "link_stopped"
	| "cancellation_unconfirmed"
	| "receiver_close_failed";
const MESSAGES: Record<Failure, string> = {
	invalid_options: "Use a coordinator HTTPS origin and a literal loopback host.",
	device_unavailable:
		"An existing device and matching private key are required. Complete device setup first.",
	request_failed: "Account linking could not finish. Try again.",
	invalid_response: "The coordinator returned an invalid account-link response.",
	link_stopped: "Account linking stopped or expired. Try again.",
	cancellation_unconfirmed:
		"Could not confirm cancellation; request will expire. Linking may already have finished if the final reply was lost.",
	receiver_close_failed:
		"Account-link receiver could not close. Linking may already have finished.",
};
/** Only fixed public errors cross the runtime boundary; transport causes may contain proofs. */
export class CoordinatorAccountLinkError extends Error {
	constructor(readonly code: Failure) {
		super(MESSAGES[code]);
	}
}
function failure(code: Failure): CoordinatorAccountLinkError {
	return new CoordinatorAccountLinkError(code);
}
function coordinatorOrigin(value: string): string {
	try {
		const url = new URL(value);
		const local =
			url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]");
		if (
			(!local && url.protocol !== "https:") ||
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash ||
			value.includes("\\") ||
			/[\s\p{Cc}]/u.test(value) ||
			value.includes("?") ||
			value.includes("#")
		)
			throw failure("invalid_options");
		// Reject normalized aliases (including nonliteral IPv4 spellings and path dot segments).
		if (value !== url.origin && value !== `${url.origin}/`) throw failure("invalid_options");
		return url.origin;
	} catch {
		throw failure("invalid_options");
	}
}
interface Device {
	deviceId: string;
	publicKey: string;
	fingerprint: string;
}
function readDevice(dbPath: string): Device {
	if (!dbPath || dbPath === ":memory:") throw failure("device_unavailable");
	const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 1000 });
	try {
		const rows = db
			.prepare("SELECT device_id, public_key, fingerprint FROM sync_device LIMIT 2")
			.all() as Record<string, unknown>[];
		const row = rows[0];
		if (
			rows.length !== 1 ||
			!row ||
			!isAuthControllerId(row.device_id) ||
			typeof row.public_key !== "string" ||
			!row.public_key.startsWith("ssh-ed25519 ") ||
			typeof row.fingerprint !== "string" ||
			!/^[a-f0-9]{64}$/.test(row.fingerprint) ||
			fingerprintPublicKey(row.public_key) !== row.fingerprint
		)
			throw failure("device_unavailable");
		return { deviceId: row.device_id, publicKey: row.public_key, fingerprint: row.fingerprint };
	} finally {
		db.close();
	}
}
interface Runtime {
	options: LinkCoordinatorAccountOptions;
	origin: string;
	device: Device;
	attemptId: string;
	deadline: number;
	expiresAtMs?: number;
	signal: AbortSignal;
	receiver: CoordinatorAccountLinkReceiver;
	created: boolean;
	succeeded: boolean;
}
function signedHeaders(runtime: Runtime, method: string, url: string, bodyBytes: Buffer) {
	const { options, device } = runtime;
	try {
		const current = readDevice(options.dbPath);
		if (
			current.deviceId !== device.deviceId ||
			current.publicKey !== device.publicKey ||
			current.fingerprint !== device.fingerprint
		)
			throw failure("device_unavailable");
		// Passing dbPath to the existing key loader invokes connect() maintenance. Instead select
		// the explicit device key without a DB lookup, then verify its signature against our readonly snapshot.
		const headers = buildAuthHeaders({
			method,
			url,
			bodyBytes,
			deviceId: device.deviceId,
			keysDir: options.keysDir,
		});
		const parsed = new URL(url);
		if (
			!verifySignature({
				method,
				pathWithQuery: `${parsed.pathname}${parsed.search}`,
				bodyBytes,
				deviceId: device.deviceId,
				publicKey: device.publicKey,
				timestamp: headers["X-Opencode-Timestamp"],
				nonce: headers["X-Opencode-Nonce"],
				signature: headers["X-Opencode-Signature"],
			})
		)
			throw failure("device_unavailable");
		return headers;
	} catch {
		throw failure("device_unavailable");
	}
}
async function boundedJson(response: Response): Promise<Record<string, unknown>> {
	if (!response.body) throw failure("invalid_response");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 16384) throw failure("invalid_response");
			chunks.push(value);
		}
		const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			throw failure("invalid_response");
		return parsed as Record<string, unknown>;
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
async function request(
	runtime: Runtime,
	options: {
		method: "GET" | "POST";
		path: string;
		body?: Record<string, string>;
		cancellation?: boolean;
	},
): Promise<Record<string, unknown>> {
	const url = `${runtime.origin}${options.path}`;
	const bodyBytes = Buffer.from(options.body ? JSON.stringify(options.body) : "");
	const headers = signedHeaders(runtime, options.method, url, bodyBytes);
	const timeout = AbortSignal.timeout(options.cancellation ? 3000 : 10000);
	const signal = options.cancellation ? timeout : AbortSignal.any([timeout, runtime.signal]);
	try {
		// Once dispatched, a lost create reply may leave an attempt requiring cancellation.
		if (options.method === "POST" && options.path === "/v1/auth/link-attempts")
			runtime.created = true;
		const response = await (runtime.options.fetch ?? globalThis.fetch)(url, {
			method: options.method,
			headers: { ...headers, "Content-Type": "application/json" },
			body: options.method === "POST" ? bodyBytes : undefined,
			signal,
			redirect: "manual",
		});
		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			throw failure("request_failed");
		}
		return await boundedJson(response);
	} catch (error) {
		if (error instanceof CoordinatorAccountLinkError) throw error;
		throw failure("request_failed");
	}
}
const STATES = new Set([
	"pending",
	"browser_claimed",
	"oidc_verified",
	"confirmed",
	"finalized",
	"session_redeemed",
	"expired",
	"failed",
]);
const CLOCK_SKEW_MS = DEFAULT_TIME_WINDOW_S * 1000;
function readStatus(data: Record<string, unknown>, runtime: Runtime): CoordinatorAuthLinkStatus {
	const value = data.status;
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw failure("invalid_response");
	const status = value as Record<string, unknown>;
	const now = Date.now();
	if (
		status.attemptId !== runtime.attemptId ||
		typeof status.state !== "string" ||
		!STATES.has(status.state) ||
		!Number.isSafeInteger(status.expiresAtMs) ||
		typeof status.expiresAtMs !== "number" ||
		status.expiresAtMs <= now - CLOCK_SKEW_MS ||
		status.expiresAtMs > now + AUTH_LINK_ATTEMPT_TTL_MS + CLOCK_SKEW_MS ||
		(runtime.expiresAtMs !== undefined && runtime.expiresAtMs !== status.expiresAtMs)
	)
		throw failure("invalid_response");
	return status as unknown as CoordinatorAuthLinkStatus;
}
function attemptPath(runtime: Runtime): string {
	return `/v1/auth/link-attempts/${encodeURIComponent(runtime.attemptId)}`;
}
interface Pin {
	coordinatorId: string;
	identityId: string;
}
async function createAttempt(
	runtime: Runtime,
	verifier: Uint8Array,
	startCode: Uint8Array,
): Promise<Pin> {
	const body = {
		group_id: runtime.options.groupId,
		attempt_id: runtime.attemptId,
		runtime_verifier_hash: await hashCoordinatorAuthProofBytes32(verifier),
		browser_start_hash: await hashCoordinatorAuthProofBytes32(startCode),
		loopback_redirect: runtime.receiver.destination,
	};
	const reply = await request(runtime, { method: "POST", path: "/v1/auth/link-attempts", body });
	const status = readStatus(reply, runtime);
	if (
		status.state !== "pending" ||
		!isAuthControllerId(reply.coordinator_id) ||
		!isAuthControllerId(reply.identity_id)
	)
		throw failure("invalid_response");
	runtime.expiresAtMs = status.expiresAtMs;
	runtime.deadline = Math.min(runtime.deadline, status.expiresAtMs + CLOCK_SKEW_MS);
	return { coordinatorId: reply.coordinator_id, identityId: reply.identity_id };
}
async function finalize(
	runtime: Runtime,
	pin: Pin,
	verifier: Uint8Array,
	completion: string,
): Promise<LinkCoordinatorAccountResult> {
	const reply = await request(runtime, {
		method: "POST",
		path: `${attemptPath(runtime)}/finalize`,
		body: {
			purpose: AUTH_LINK_PURPOSE,
			coordinator_id: pin.coordinatorId,
			identity_id: pin.identityId,
			attempt_id: runtime.attemptId,
			group_id: runtime.options.groupId,
			device_id: runtime.device.deviceId,
			fingerprint: runtime.device.fingerprint,
			runtime_verifier: encodeCoordinatorAuthProof32(verifier),
			completion,
		},
	});
	const status = readStatus(reply, runtime);
	if (status.state !== "finalized" && status.state !== "session_redeemed")
		throw failure("invalid_response");
	runtime.succeeded = true;
	return { ...pin, attemptId: runtime.attemptId, state: status.state };
}
function readyToFinalize(status: CoordinatorAuthLinkStatus, finalRequests: number): boolean {
	if (status.state === "confirmed") return true;
	return finalRequests > 0 && (status.state === "finalized" || status.state === "session_redeemed");
}
function retryFinalization(error: unknown, finalRequests: number): boolean {
	return (
		error instanceof CoordinatorAccountLinkError &&
		error.code === "request_failed" &&
		finalRequests < 2
	);
}
async function waitForFinalization(
	runtime: Runtime,
	pin: Pin,
	verifier: Uint8Array,
): Promise<LinkCoordinatorAccountResult> {
	let completion: string | undefined;
	let receiverFailed = false;
	let finalRequests = 0;
	void runtime.receiver.completion.then(
		(proof) => {
			completion = proof;
		},
		() => {
			receiverFailed = true;
		},
	);
	while (!runtime.signal.aborted && Date.now() < runtime.deadline && !receiverFailed) {
		const reply = await request(runtime, {
			method: "GET",
			path: `${attemptPath(runtime)}?group_id=${encodeURIComponent(runtime.options.groupId)}`,
		});
		const status = readStatus(reply, runtime);
		if (status.state === "failed" || status.state === "expired") throw failure("link_stopped");
		if (completion && readyToFinalize(status, finalRequests)) {
			finalRequests++;
			try {
				return await finalize(runtime, pin, verifier, completion);
			} catch (error) {
				if (!retryFinalization(error, finalRequests)) throw error;
				// Only an own proof-bearing POST reply can report success; retry with fresh signed nonce.
			}
		}
		await delay(Math.min(1000, Math.max(1, runtime.deadline - Date.now())), undefined, {
			signal: runtime.signal,
		});
	}
	throw failure("link_stopped");
}
async function cancelAttempt(runtime: Runtime): Promise<void> {
	try {
		const reply = await request(runtime, {
			method: "POST",
			path: `${attemptPath(runtime)}/cancel`,
			body: { group_id: runtime.options.groupId },
			cancellation: true,
		});
		// Cancellation may return an expired attempt, but only a failed response confirms cancellation.
		const status = reply.status as Record<string, unknown> | undefined;
		if (!status || status.attemptId !== runtime.attemptId || status.state !== "failed")
			throw failure("cancellation_unconfirmed");
	} catch {
		throw failure("cancellation_unconfirmed");
	}
}
async function runBrowserLink(
	runtime: Runtime,
	verifier: Uint8Array,
	startCode: Uint8Array,
): Promise<LinkCoordinatorAccountResult> {
	try {
		const pin = await createAttempt(runtime, verifier, startCode);
		const url = new URL("/auth/link/start", runtime.origin);
		url.searchParams.set("attempt_id", runtime.attemptId);
		url.searchParams.set("start_code", encodeCoordinatorAuthProof32(startCode));
		runtime.options.onBrowserStart(url.href);
		return await waitForFinalization(runtime, pin, verifier);
	} catch (error) {
		if (runtime.created && !runtime.succeeded) await cancelAttempt(runtime);
		if (error instanceof CoordinatorAccountLinkError) throw error;
		throw failure("link_stopped");
	}
}
async function runLink(runtime: Runtime): Promise<LinkCoordinatorAccountResult> {
	const verifier = new Uint8Array(32);
	const startCode = new Uint8Array(32);
	let result: LinkCoordinatorAccountResult | undefined;
	let error: unknown;
	try {
		verifier.set(randomBytes(32));
		startCode.set(randomBytes(32));
		result = await runBrowserLink(runtime, verifier, startCode);
	} catch (caught) {
		error = caught;
	}
	verifier.fill(0);
	startCode.fill(0);
	try {
		await runtime.receiver.close();
	} catch {
		throw failure("receiver_close_failed");
	}
	if (error) throw error;
	if (!result) throw failure("link_stopped");
	return result;
}
/** Link only the existing device/Identity. No enrollment, local Identity adoption, or key creation. */
export async function linkCoordinatorAccount(
	options: LinkCoordinatorAccountOptions,
): Promise<LinkCoordinatorAccountResult> {
	const origin = coordinatorOrigin(options.coordinatorUrl);
	if (
		!isAuthControllerId(options.groupId) ||
		typeof options.onBrowserStart !== "function" ||
		(options.loopbackHost !== undefined &&
			options.loopbackHost !== "127.0.0.1" &&
			options.loopbackHost !== "::1")
	)
		throw failure("invalid_options");
	let device: Device;
	try {
		device = readDevice(options.dbPath);
		if (!loadPrivateKey(options.keysDir, undefined, device.deviceId))
			throw failure("device_unavailable");
	} catch {
		throw failure("device_unavailable");
	}
	const deadline = Date.now() + AUTH_LINK_ATTEMPT_TTL_MS;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), AUTH_LINK_ATTEMPT_TTL_MS);
	const signal = options.signal
		? AbortSignal.any([controller.signal, options.signal])
		: controller.signal;
	try {
		const attemptId = randomUUID();
		const receiver = await createCoordinatorAccountLinkReceiver({
			attemptId,
			host: options.loopbackHost,
			signal,
		});
		return await runLink({
			options,
			origin,
			device,
			attemptId,
			deadline,
			signal,
			receiver,
			created: false,
			succeeded: false,
		});
	} catch (error) {
		if (error instanceof CoordinatorAccountLinkError) throw error;
		throw failure("link_stopped");
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}
