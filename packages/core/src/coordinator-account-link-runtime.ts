import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { AUTH_ACCOUNT_CHANGE_PURPOSE } from "./coordinator-account-change-contract.js";
import {
	type CoordinatorAccountLinkReceiver,
	createCoordinatorAccountLinkReceiver,
	normalizeCoordinatorAccountLinkOrigin,
} from "./coordinator-account-link-receiver.js";
import {
	readAccountLinkDevice,
	signAccountLinkRequest,
} from "./coordinator-account-link-signer.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { CoordinatorAuthLinkAuthorityKind } from "./coordinator-auth-link-authority.js";
import {
	AUTH_LINK_ATTEMPT_TTL_MS,
	AUTH_LINK_PURPOSE,
	type CoordinatorAuthLinkStatus,
} from "./coordinator-auth-link-contract.js";
import {
	encodeCoordinatorAuthProof32,
	hashCoordinatorAuthProofBytes32,
} from "./coordinator-auth-proof.js";
import type { CoordinatorDeviceLocalEvidence } from "./coordinator-device-local.js";
import { DEFAULT_TIME_WINDOW_S } from "./sync-auth-constants.js";
import { loadPrivateKey } from "./sync-identity.js";

export interface LinkCoordinatorAccountOptions {
	dbPath: string;
	keysDir?: string;
	groupId: string;
	coordinatorUrl: string;
	expectedIdentityId: string;
	expectedAuthority: CoordinatorAuthLinkAuthorityKind;
	expectedCoordinatorId?: string;
	assertCurrentContext?: () => boolean | Promise<boolean>;
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
export interface ChangeCoordinatorAccountOptions
	extends Omit<LinkCoordinatorAccountOptions, "expectedAuthority"> {
	intent: "refresh" | "disconnect";
	/** Exact signed target captured before local confirmation. */
	expectedLinkId?: string;
}
export interface ChangeCoordinatorAccountResult {
	intent: "refresh" | "disconnect";
	state: "completed";
	coordinatorId: string;
	identityId: string;
	attemptId: string;
}
type AccountOptions = Omit<LinkCoordinatorAccountOptions, "expectedAuthority">;
type AccountResult = LinkCoordinatorAccountResult | ChangeCoordinatorAccountResult;
type Failure =
	| "invalid_options"
	| "device_unavailable"
	| "request_failed"
	| "schema_upgrade_required"
	| "review_required"
	| "link_conflict"
	| "invalid_response"
	| "context_changed"
	| "identity_mismatch"
	| "link_stopped"
	| "cancellation_unconfirmed"
	| "receiver_close_failed";
const MESSAGES: Record<Failure, string> = {
	invalid_options: "Use a coordinator HTTPS origin and a literal loopback host.",
	device_unavailable:
		"An existing device and matching private key are required. Complete device setup first.",
	request_failed: "Account linking could not finish. Try again.",
	schema_upgrade_required:
		"Ask the coordinator operator to pause auth writers, back up the coordinator database and run the explicit auth-schema upgrade before linking. Ordinary device-signed sync remains available.",
	review_required:
		"This device cannot link the current Identity, or coordinator information changed. Check account-link status before trying again.",
	link_conflict:
		"Account linking conflicts with an existing or revoked coordinator link. This request did not replace it.",
	invalid_response: "The coordinator returned an invalid account-link response.",
	context_changed:
		"The current account-link context changed. Check the current Identity and coordinator before trying again.",
	identity_mismatch:
		"The coordinator returned a different Identity or coordinator. Check the current Identity and coordinator before trying again.",
	link_stopped: "Account linking stopped or expired. Try again.",
	cancellation_unconfirmed:
		"Could not confirm cancellation; request will expire. Linking may already have finished if the final reply was lost.",
	receiver_close_failed:
		"Account-link receiver could not close. Linking may already have finished.",
};
const CHANGE_MESSAGES: Record<Failure, string> = {
	...MESSAGES,
	request_failed: "The account change could not finish. Try again.",
	schema_upgrade_required:
		"Ask the coordinator operator to check the required database upgrade before retrying the account change. Ordinary device-signed sync remains available.",
	review_required:
		"This device cannot change the account connection, or coordinator information changed. Check account status before trying again.",
	link_conflict:
		"The account change conflicts with an existing or revoked coordinator connection. This request did not replace it.",
	invalid_response: "The coordinator returned an invalid account-change response.",
	context_changed:
		"The current account context changed. Check the current Identity and coordinator before trying again.",
	link_stopped: "The account change stopped or expired. Try again.",
	cancellation_unconfirmed:
		"Could not confirm cancellation; the request will expire. The account change may already have finished if the final reply was lost.",
	receiver_close_failed:
		"The account-change receiver could not close. The account change may already have finished.",
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
async function assertCurrentContext(options: AccountOptions, signal: AbortSignal): Promise<void> {
	if (signal.aborted) throw failure("link_stopped");
	const checkContext = options.assertCurrentContext;
	if (!checkContext) return;
	let onAbort = () => {};
	try {
		const aborted = new Promise<never>((_, reject) => {
			onAbort = () => reject(failure("link_stopped"));
			signal.addEventListener("abort", onAbort, { once: true });
		});
		// Keep a late callback resolution or rejection handled after cancellation.
		const check = Promise.resolve().then(() => {
			if (signal.aborted) throw failure("link_stopped");
			return checkContext();
		});
		const current = await Promise.race([check, aborted]);
		if (signal.aborted) throw failure("link_stopped");
		if (current === true) return;
	} catch {
		// Context callbacks may contain private details; expose only the fixed public error.
		if (signal.aborted) throw failure("link_stopped");
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
	throw failure("context_changed");
}
function readDeviceWithKey(options: AccountOptions): CoordinatorDeviceLocalEvidence {
	try {
		const device = readAccountLinkDevice(options.dbPath);
		if (!loadPrivateKey(options.keysDir, undefined, device.deviceId))
			throw failure("device_unavailable");
		return device;
	} catch {
		throw failure("device_unavailable");
	}
}
interface Runtime {
	options: AccountOptions;
	intent: "link" | "refresh" | "disconnect";
	authority?: CoordinatorAuthLinkAuthorityKind;
	verifierHash?: string;
	origin: string;
	device: CoordinatorDeviceLocalEvidence;
	attemptId: string;
	deadline: number;
	expiresAtMs?: number;
	signal: AbortSignal;
	receiver: CoordinatorAccountLinkReceiver;
	created: boolean;
	succeeded: boolean;
	stoppedState?: "failed" | "expired" | "cancelled";
	finalizeRejected?: boolean;
}
type Transport = Pick<
	Runtime,
	"origin" | "options" | "device" | "signal" | "intent" | "created" | "finalizeRejected"
>;
function signedHeaders(runtime: Transport, method: string, url: string, bodyBytes: Buffer) {
	const { options, device } = runtime;
	try {
		return signAccountLinkRequest({
			dbPath: options.dbPath,
			keysDir: options.keysDir,
			device,
			method,
			url,
			bodyBytes,
		});
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
type FailureCodes = Readonly<Record<number, Readonly<Record<string, Failure>>>>;
const CREATE_FAILURE_CODES: FailureCodes = {
	403: { auth_link_review_required: "review_required" },
};
// Exact management-route rejections, before any browser URL has been released.
// Replay conflicts and server/transport failures remain ambiguous.
const CHANGE_CREATE_FAILURE_CODES: FailureCodes = {
	400: { account_change_invalid_input: "request_failed" },
	401: { account_change_unavailable: "request_failed" },
	403: { account_change_unavailable: "request_failed" },
	404: { not_found: "request_failed" },
};
const UNLINK_FAILURE_CODES: FailureCodes = {
	400: { account_change_invalid_input: "review_required" },
	401: { account_change_unavailable: "review_required" },
	403: { account_change_unavailable: "review_required" },
	404: { not_found: "review_required" },
};
const FINALIZE_FAILURE_CODES: FailureCodes = {
	403: { auth_link_review_required: "review_required" },
	409: { auth_link_conflict: "link_conflict" },
};
const CHANGE_FINALIZE_FAILURE_CODES: FailureCodes = {
	403: { account_change_unavailable: "link_stopped" },
};
async function readFailureCode(
	response: Response,
	failureCodes?: FailureCodes,
): Promise<Failure | undefined> {
	if (response.status === 503) {
		if (response.headers.get("X-Codemem-Auth-Error") === "coordinator_auth_schema_upgrade_required")
			return "schema_upgrade_required";
		return undefined;
	}
	if (!failureCodes || !Object.hasOwn(failureCodes, response.status)) return undefined;
	const labels = failureCodes[response.status];
	try {
		const data = await boundedJson(response);
		if (
			Object.keys(data).length !== 1 ||
			!Object.hasOwn(data, "error") ||
			typeof data.error !== "string" ||
			!labels ||
			!Object.hasOwn(labels, data.error)
		)
			return undefined;
		return labels[data.error];
	} catch {
		return undefined;
	}
}
async function rejectResponse(
	runtime: Transport,
	response: Response,
	failureCodes?: FailureCodes,
): Promise<never> {
	const code = await readFailureCode(response, failureCodes);
	if (failureCodes === CHANGE_CREATE_FAILURE_CODES && code === "request_failed")
		runtime.created = false;
	if (failureCodes === CHANGE_FINALIZE_FAILURE_CODES && code === "link_stopped")
		runtime.finalizeRejected = true;
	if (code) throw failure(code);
	await response.body?.cancel().catch(() => {});
	throw failure("request_failed");
}
async function request(
	runtime: Transport,
	options: {
		method: "GET" | "POST";
		path: string;
		body?: Record<string, string>;
		cancellation?: boolean;
		failureCodes?: FailureCodes;
	},
): Promise<Record<string, unknown>> {
	const url = `${runtime.origin}${options.path}`;
	const bodyBytes = Buffer.from(options.body ? JSON.stringify(options.body) : "");
	const headers = signedHeaders(runtime, options.method, url, bodyBytes);
	const timeout = AbortSignal.timeout(options.cancellation ? 3000 : 10000);
	const signal = options.cancellation ? timeout : AbortSignal.any([timeout, runtime.signal]);
	try {
		// Once dispatched, a lost create reply may leave an attempt requiring cancellation.
		if (options.method === "POST" && options.path === collectionPath(runtime))
			runtime.created = true;
		const response = await (runtime.options.fetch ?? globalThis.fetch)(url, {
			method: options.method,
			headers: { ...headers, "Content-Type": "application/json" },
			body: options.method === "POST" ? bodyBytes : undefined,
			signal,
			redirect: "manual",
		});
		if (!response.ok) {
			return await rejectResponse(runtime, response, options.failureCodes);
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
type RuntimeStatus = CoordinatorAuthLinkStatus | { state: string; expiresAtMs: number };
const CHANGE_STATES = new Set([
	"pending",
	"browser_pending",
	"consumed",
	"verified",
	"confirmed",
	"committing",
	"completed",
	"cancelled",
	"failed",
	"expired",
]);
function readStatus(data: Record<string, unknown>, runtime: Runtime): RuntimeStatus {
	const value = data.status;
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw failure("invalid_response");
	const status = value as Record<string, unknown>;
	const now = Date.now();
	if (
		Object.keys(status).length !== (runtime.intent === "link" ? 3 : 5) ||
		(runtime.intent !== "link" &&
			(status.intent !== runtime.intent ||
				status.identityId !== runtime.options.expectedIdentityId)) ||
		status.attemptId !== runtime.attemptId ||
		typeof status.state !== "string" ||
		!(runtime.intent === "link" ? STATES : CHANGE_STATES).has(status.state) ||
		!Number.isSafeInteger(status.expiresAtMs) ||
		typeof status.expiresAtMs !== "number" ||
		status.expiresAtMs <= now - CLOCK_SKEW_MS ||
		status.expiresAtMs > now + AUTH_LINK_ATTEMPT_TTL_MS + CLOCK_SKEW_MS ||
		(runtime.expiresAtMs !== undefined && runtime.expiresAtMs !== status.expiresAtMs)
	)
		throw failure("invalid_response");
	return { state: status.state, expiresAtMs: status.expiresAtMs };
}
function collectionPath(runtime: Pick<Runtime, "intent">): string {
	return runtime.intent === "link" ? "/v1/auth/link-attempts" : "/v1/auth/account-changes";
}
function attemptPath(runtime: Runtime): string {
	return `${collectionPath(runtime)}/${encodeURIComponent(runtime.attemptId)}`;
}
function attemptScope(runtime: Runtime): Record<string, string> {
	const scope: Record<string, string> = { group_id: runtime.options.groupId };
	if (runtime.intent !== "link") {
		if (!runtime.verifierHash) throw failure("invalid_response");
		scope.identity_id = runtime.options.expectedIdentityId;
		scope.runtime_verifier_hash = runtime.verifierHash;
	}
	return scope;
}
function statusPath(runtime: Runtime): string {
	if (runtime.intent === "link")
		return `${attemptPath(runtime)}?group_id=${encodeURIComponent(runtime.options.groupId)}`;
	return `${attemptPath(runtime)}?${new URLSearchParams(attemptScope(runtime))}`;
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
	runtime.verifierHash = await hashCoordinatorAuthProofBytes32(verifier);
	const body: Record<string, string> = {
		group_id: runtime.options.groupId,
		identity_id: runtime.options.expectedIdentityId,
	};
	if (runtime.intent === "link") {
		if (!runtime.authority) throw failure("invalid_options");
		body.authority = runtime.authority;
	} else body.intent = runtime.intent;
	Object.assign(body, {
		attempt_id: runtime.attemptId,
		runtime_verifier_hash: runtime.verifierHash,
		browser_start_hash: await hashCoordinatorAuthProofBytes32(startCode),
		loopback_redirect: runtime.receiver.destination,
	});
	await assertCurrentContext(runtime.options, runtime.signal);
	const reply = await request(runtime, {
		method: "POST",
		path: collectionPath(runtime),
		body,
		failureCodes: runtime.intent === "link" ? CREATE_FAILURE_CODES : CHANGE_CREATE_FAILURE_CODES,
	});
	const status = readStatus(reply, runtime);
	if (
		Object.keys(reply).length !== (runtime.intent === "link" ? 4 : 3) ||
		status.state !== "pending" ||
		!isAuthControllerId(reply.coordinator_id) ||
		!isAuthControllerId(reply.identity_id) ||
		(runtime.intent === "link" && reply.authority !== runtime.authority)
	)
		throw failure("invalid_response");
	if (
		runtime.options.expectedIdentityId !== reply.identity_id ||
		(runtime.options.expectedCoordinatorId !== undefined &&
			runtime.options.expectedCoordinatorId !== reply.coordinator_id)
	)
		throw failure("identity_mismatch");
	runtime.expiresAtMs = status.expiresAtMs;
	runtime.deadline = Math.min(runtime.deadline, status.expiresAtMs + CLOCK_SKEW_MS);
	return { coordinatorId: reply.coordinator_id, identityId: reply.identity_id };
}
async function finalize(
	runtime: Runtime,
	pin: Pin,
	verifier: Uint8Array,
	completion: string,
	options: { requestNumber: number },
): Promise<AccountResult> {
	await assertCurrentContext(runtime.options, runtime.signal);
	let failureCodes: FailureCodes | undefined = FINALIZE_FAILURE_CODES;
	if (runtime.intent !== "link") {
		// A later rejection cannot disprove an earlier possibly committed POST.
		failureCodes = options.requestNumber === 1 ? CHANGE_FINALIZE_FAILURE_CODES : undefined;
	}
	const reply = await request(runtime, {
		method: "POST",
		path: `${attemptPath(runtime)}/finalize`,
		failureCodes,
		body: {
			purpose: runtime.intent === "link" ? AUTH_LINK_PURPOSE : AUTH_ACCOUNT_CHANGE_PURPOSE,
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
	if (runtime.intent !== "link") {
		if (Object.keys(reply).length !== 1 || status.state !== "completed")
			throw failure("invalid_response");
		runtime.succeeded = true;
		return { ...pin, attemptId: runtime.attemptId, intent: runtime.intent, state: "completed" };
	}
	if (status.state !== "finalized" && status.state !== "session_redeemed")
		throw failure("invalid_response");
	runtime.succeeded = true;
	return { ...pin, attemptId: runtime.attemptId, state: status.state };
}
function readyToFinalize(status: RuntimeStatus, finalRequests: number): boolean {
	if (status.state === "confirmed") return true;
	return (
		finalRequests > 0 &&
		["finalized", "session_redeemed", "completed", "committing"].includes(status.state)
	);
}
function retryFinalization(
	error: unknown,
	finalRequests: number,
	options: { intent: Runtime["intent"] },
): boolean {
	if (!(error instanceof CoordinatorAccountLinkError) || finalRequests >= 2) return false;
	return (
		error.code === "request_failed" ||
		(options.intent !== "link" && error.code === "invalid_response")
	);
}
async function waitForFinalization(
	runtime: Runtime,
	pin: Pin,
	verifier: Uint8Array,
): Promise<AccountResult> {
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
			path: statusPath(runtime),
		});
		const status = readStatus(reply, runtime);
		assertStatusEnvelope(reply, runtime);
		if (observeStoppedStatus(runtime, status)) throw failure("link_stopped");
		if (completion && readyToFinalize(status, finalRequests)) {
			finalRequests++;
			try {
				return await finalize(runtime, pin, verifier, completion, { requestNumber: finalRequests });
			} catch (error) {
				if (!retryFinalization(error, finalRequests, { intent: runtime.intent })) throw error;
				// Only an own proof-bearing POST reply can report success; retry with fresh signed nonce.
			}
		}
		await delay(Math.min(1000, Math.max(1, runtime.deadline - Date.now())), undefined, {
			signal: runtime.signal,
		});
	}
	throw failure("link_stopped");
}
function observeStoppedStatus(runtime: Runtime, status: RuntimeStatus): boolean {
	const state = status.state;
	if (state !== "failed" && state !== "expired" && state !== "cancelled") return false;
	// Only a validated own status can make cleanup unnecessary; transport/deadline failures cannot.
	if (runtime.intent !== "link") runtime.stoppedState = state;
	return true;
}
function assertStatusEnvelope(reply: Record<string, unknown>, runtime: Runtime): void {
	if (runtime.intent !== "link" && Object.keys(reply).length !== 1)
		throw failure("invalid_response");
}
async function cancelAttempt(runtime: Runtime): Promise<void> {
	try {
		const reply = await request(runtime, {
			method: "POST",
			path: `${attemptPath(runtime)}/cancel`,
			body: attemptScope(runtime),
			cancellation: true,
		});
		if (runtime.intent !== "link") {
			const status = readStatus(reply, runtime);
			if (Object.keys(reply).length !== 1 || status.state !== "cancelled")
				throw failure("cancellation_unconfirmed");
			return;
		}
		// Cancellation may return an expired attempt, but only a failed response confirms cancellation.
		const status = reply.status as Record<string, unknown> | undefined;
		if (!status || status.attemptId !== runtime.attemptId || status.state !== "failed")
			throw failure("cancellation_unconfirmed");
	} catch {
		throw failure("cancellation_unconfirmed");
	}
}
function preserveRejection(runtime: Runtime, error: unknown): boolean {
	if (runtime.finalizeRejected) return true;
	return (
		error instanceof CoordinatorAccountLinkError &&
		["review_required", "link_conflict", "schema_upgrade_required"].includes(error.code)
	);
}
async function runBrowserLink(
	runtime: Runtime,
	verifier: Uint8Array,
	startCode: Uint8Array,
): Promise<AccountResult> {
	try {
		const pin = await createAttempt(runtime, verifier, startCode);
		const url = new URL(
			runtime.intent === "link" ? "/auth/link/start" : "/auth/account/change/start",
			runtime.origin,
		);
		url.searchParams.set("attempt_id", runtime.attemptId);
		url.searchParams.set("start_code", encodeCoordinatorAuthProof32(startCode));
		await assertCurrentContext(runtime.options, runtime.signal);
		runtime.options.onBrowserStart(url.href);
		return await waitForFinalization(runtime, pin, verifier);
	} catch (error) {
		if (runtime.created && !runtime.succeeded && runtime.stoppedState === undefined) {
			try {
				await cancelAttempt(runtime);
			} catch (cancellationError) {
				// A known rejection describes this request, not future proof copies or cleanup.
				if (!preserveRejection(runtime, error)) throw cancellationError;
			}
		}
		if (error instanceof CoordinatorAccountLinkError) throw error;
		throw failure("link_stopped");
	}
}
async function runLink(runtime: Runtime): Promise<AccountResult> {
	const verifier = new Uint8Array(32);
	const startCode = new Uint8Array(32);
	let result: AccountResult | undefined;
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
		await runtime.receiver.close(
			runtime.intent === "link"
				? { linked: runtime.succeeded }
				: { intent: runtime.intent, completed: runtime.succeeded },
		);
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
	if (
		options.expectedAuthority !== "controller_attestation" &&
		options.expectedAuthority !== "device_claim"
	)
		throw failure("invalid_options");
	const result = await runAccountOperation(options, "link", options.expectedAuthority);
	if (result.state === "completed") throw failure("invalid_response");
	return result;
}
/** Change only the existing Identity's account link; never create or adopt local identity material. */
export async function changeCoordinatorAccount(
	options: ChangeCoordinatorAccountOptions,
): Promise<ChangeCoordinatorAccountResult> {
	if (options.intent !== "refresh" && options.intent !== "disconnect")
		throw failure("invalid_options");
	try {
		if (options.intent === "disconnect" && options.expectedLinkId)
			return await unlinkCoordinatorAccount(options);
		const result = await runAccountOperation(options, options.intent);
		if (result.state !== "completed") throw failure("invalid_response");
		return result;
	} catch (error) {
		const safeError =
			error instanceof CoordinatorAccountLinkError ? error : failure("request_failed");
		safeError.message = CHANGE_MESSAGES[safeError.code];
		throw safeError;
	}
}
function unlinkResult(
	reply: Record<string, unknown>,
	options: ChangeCoordinatorAccountOptions,
	attemptId: string,
): ChangeCoordinatorAccountResult {
	if (
		Object.keys(reply).length !== 5 ||
		reply.state !== "completed" ||
		reply.attemptId !== attemptId ||
		reply.targetLinkId !== options.expectedLinkId ||
		reply.identityId !== options.expectedIdentityId ||
		reply.coordinatorId !== options.expectedCoordinatorId ||
		!isAuthControllerId(options.expectedCoordinatorId)
	)
		throw failure("invalid_response");
	return {
		intent: "disconnect",
		state: "completed",
		attemptId,
		identityId: options.expectedIdentityId,
		coordinatorId: options.expectedCoordinatorId,
	};
}
function unlinkWasRejected(error: unknown, requestNumber: number): boolean {
	return (
		requestNumber === 1 &&
		error instanceof CoordinatorAccountLinkError &&
		[
			"schema_upgrade_required",
			"review_required",
			"context_changed",
			"device_unavailable",
			"link_stopped",
		].includes(error.code)
	);
}
async function unlinkCoordinatorAccount(
	options: ChangeCoordinatorAccountOptions,
): Promise<ChangeCoordinatorAccountResult> {
	const origin = normalizeCoordinatorAccountLinkOrigin(options.coordinatorUrl);
	if (
		!origin ||
		!isAuthControllerId(options.expectedLinkId) ||
		!isAuthControllerId(options.expectedIdentityId) ||
		!isAuthControllerId(options.groupId) ||
		!isAuthControllerId(options.expectedCoordinatorId)
	)
		throw failure("invalid_options");
	const signal = options.signal ?? new AbortController().signal;
	await assertCurrentContext(options, signal);
	const transport: Transport = {
		origin,
		options,
		signal,
		device: readDeviceWithKey(options),
		intent: "disconnect",
		created: false,
	};
	const attemptId = randomUUID();
	const body = {
		group_id: options.groupId,
		identity_id: options.expectedIdentityId,
		attempt_id: attemptId,
		target_link_id: options.expectedLinkId,
	};
	for (let requestNumber = 1; requestNumber <= 2; requestNumber++) {
		try {
			await assertCurrentContext(options, signal);
			const reply = await request(transport, {
				method: "POST",
				path: "/v1/auth/account-unlinks",
				body,
				failureCodes: requestNumber === 1 ? UNLINK_FAILURE_CODES : undefined,
			});
			return unlinkResult(reply, options, attemptId);
		} catch (error) {
			// Only an exact first-request rejection proves no mutation; later failures remain unknown.
			if (unlinkWasRejected(error, requestNumber)) throw error;
			if (signal.aborted || requestNumber === 2) throw failure("cancellation_unconfirmed");
		}
	}
	throw failure("cancellation_unconfirmed");
}
async function runAccountOperation(
	options: AccountOptions,
	intent: Runtime["intent"],
	authority?: CoordinatorAuthLinkAuthorityKind,
): Promise<AccountResult> {
	const origin = normalizeCoordinatorAccountLinkOrigin(options.coordinatorUrl);
	if (
		!origin ||
		!isAuthControllerId(options.groupId) ||
		!isAuthControllerId(options.expectedIdentityId) ||
		(options.expectedCoordinatorId !== undefined &&
			!isAuthControllerId(options.expectedCoordinatorId)) ||
		(options.assertCurrentContext !== undefined &&
			typeof options.assertCurrentContext !== "function") ||
		typeof options.onBrowserStart !== "function" ||
		(options.loopbackHost !== undefined &&
			options.loopbackHost !== "127.0.0.1" &&
			options.loopbackHost !== "::1")
	)
		throw failure("invalid_options");
	const deadline = Date.now() + AUTH_LINK_ATTEMPT_TTL_MS;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), AUTH_LINK_ATTEMPT_TTL_MS);
	const signal = options.signal
		? AbortSignal.any([controller.signal, options.signal])
		: controller.signal;
	try {
		await assertCurrentContext(options, signal);
		const device = readDeviceWithKey(options);
		const attemptId = randomUUID();
		const receiver = await createCoordinatorAccountLinkReceiver({
			intent,
			attemptId,
			coordinatorOrigin: origin,
			host: options.loopbackHost,
			signal,
		});
		return await runLink({
			intent,
			authority,
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
