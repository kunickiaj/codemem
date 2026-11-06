import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeCoordinatorAccountLinkOrigin } from "./coordinator-account-link-receiver.js";
import {
	assertCurrentContext,
	CoordinatorAccountLinkError,
	cancelAttempt,
	type FailureCodes,
	failure,
	finalize,
	type LinkCoordinatorAccountOptions,
	type LinkCoordinatorAccountResult,
	type LinkSession,
	type Pin,
	preserveRejection,
	readDeviceWithKey,
	readStatus,
	readyToFinalize,
	request,
	retryFinalization,
} from "./coordinator-account-link-runtime.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import { formatShortKeyFingerprint } from "./coordinator-auth-key-fingerprint.js";
import { AUTH_LINK_ATTEMPT_TTL_MS } from "./coordinator-auth-link-contract.js";
import {
	formatHeadlessUserCode,
	generateHeadlessUserCode,
	hashHeadlessUserCode,
} from "./coordinator-auth-link-headless.js";
import {
	encodeCoordinatorAuthProof32,
	hashCoordinatorAuthProofBytes32,
} from "./coordinator-auth-proof.js";

const HEADLESS_PATH = "/v1/auth/headless-link-attempts";
const MIN_POLL_INTERVAL_MS = 5_000;
const MAX_POLL_INTERVAL_MS = 60_000;
/** RFC 8628 slow_down: each rate-limit reply adds this much to the polling interval. */
const SLOW_DOWN_STEP_MS = 5_000;
const MAX_CODE_ATTEMPTS = 3;
const MAX_ACCOUNT_FIELD_LENGTH = 320;

/** What the person needs to enter the code in a browser on another computer. */
export interface HeadlessLinkCode {
	verificationUri: string;
	/** Display form, XXXX-XXXX. */
	code: string;
	/** Short device key fingerprint, as the browser shows it. */
	fingerprint: string;
	deviceId: string;
	expiresAtMs: number;
}
/** The Google account the coordinator verified in the browser. */
export interface HeadlessLinkApproval {
	issuer: string;
	subject: string;
	email: string | null;
	emailVerified: boolean | null;
	displayName: string | null;
}
export interface LinkCoordinatorAccountHeadlessOptions
	extends Omit<LinkCoordinatorAccountOptions, "loopbackHost" | "onBrowserStart"> {
	onCode: (code: HeadlessLinkCode) => void;
	onState?: (state: string) => void;
	/**
	 * Asks the person on this device. Only `true` links; the signal aborts at
	 * attempt expiry or cancellation.
	 */
	approve: (
		approval: HeadlessLinkApproval,
		context: { expiresAtMs: number; signal: AbortSignal },
	) => Promise<boolean>;
}
type Hooks = Pick<LinkCoordinatorAccountHeadlessOptions, "onCode" | "onState" | "approve">;

const CREATE_FAILURE_CODES: FailureCodes = {
	403: { auth_link_review_required: "review_required" },
	404: { not_found: "headless_unsupported" },
	409: { user_code_conflict: "user_code_conflict" },
};
const STATUS_FAILURE_CODES: FailureCodes = {
	404: { not_found: "headless_unsupported", auth_link_unavailable: "link_stopped" },
};
// Exact rejections that prove the create request stored no attempt.
const NOT_CREATED = new Set(["headless_unsupported", "user_code_conflict"]);

interface Created {
	pin: Pin;
	code: string;
	verificationUri: string;
	pollIntervalMs: number;
}

function readCreateReply(reply: Record<string, unknown>, session: LinkSession) {
	const status = readStatus(reply, session);
	const interval = reply.poll_interval_s;
	if (
		Object.keys(reply).length !== 6 ||
		status.state !== "pending" ||
		!isAuthControllerId(reply.coordinator_id) ||
		!isAuthControllerId(reply.identity_id) ||
		reply.authority !== session.authority ||
		typeof interval !== "number" ||
		!Number.isSafeInteger(interval) ||
		interval < 1 ||
		interval > 60
	)
		throw failure("invalid_response");
	const verificationUri = readVerificationUri(reply.verification_uri, session.origin);
	if (
		session.options.expectedIdentityId !== reply.identity_id ||
		(session.options.expectedCoordinatorId !== undefined &&
			session.options.expectedCoordinatorId !== reply.coordinator_id)
	)
		throw failure("identity_mismatch");
	return {
		status,
		verificationUri,
		pollIntervalMs: Math.max(MIN_POLL_INTERVAL_MS, interval * 1000),
		pin: { coordinatorId: reply.coordinator_id, identityId: reply.identity_id },
	};
}

const VERIFICATION_PATH = "/auth/link/device";
/** The person is sent only to the code-entry page of the coordinator they already trust. */
function readVerificationUri(value: unknown, origin: string): string {
	if (typeof value !== "string" || value.length > 2048) throw failure("invalid_response");
	const expected = new URL(VERIFICATION_PATH, origin).href;
	// Exact match rejects http, credentials, other paths, queries and fragments.
	if (expected.startsWith("https:") && value === expected) return expected;
	throw failure("invalid_response");
}

async function createHeadlessAttempt(session: LinkSession): Promise<Created> {
	for (let codeAttempt = 1; ; codeAttempt++) {
		const code = generateHeadlessUserCode();
		if (codeAttempt > 1) session.attemptId = randomUUID();
		await assertCurrentContext(session.options, session.signal);
		try {
			const reply = await request(session, {
				method: "POST",
				path: HEADLESS_PATH,
				creates: true,
				failureCodes: CREATE_FAILURE_CODES,
				body: {
					group_id: session.options.groupId,
					identity_id: session.options.expectedIdentityId,
					authority: session.authority ?? "",
					attempt_id: session.attemptId,
					runtime_verifier_hash: session.verifierHash ?? "",
					user_code_hash: await hashHeadlessUserCode(code),
				},
			});
			const created = readCreateReply(reply, session);
			session.expiresAtMs = created.status.expiresAtMs;
			session.deadline = Math.min(session.deadline, created.status.expiresAtMs);
			return { ...created, code };
		} catch (error) {
			if (!(error instanceof CoordinatorAccountLinkError) || !NOT_CREATED.has(error.code))
				throw error;
			session.created = false;
			// Another attempt holds this code; a fresh code and attempt id can still succeed.
			if (error.code !== "user_code_conflict" || codeAttempt >= MAX_CODE_ATTEMPTS) throw error;
		}
	}
}

function nullableText(value: unknown): value is string | null {
	return value === null || (typeof value === "string" && value.length <= MAX_ACCOUNT_FIELD_LENGTH);
}

function readApproval(value: unknown): HeadlessLinkApproval {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw failure("invalid_response");
	const data = value as Record<string, unknown>;
	if (
		Object.keys(data).length !== 5 ||
		typeof data.issuer !== "string" ||
		typeof data.subject !== "string" ||
		!data.issuer ||
		!data.subject ||
		data.issuer.length > MAX_ACCOUNT_FIELD_LENGTH ||
		data.subject.length > 255 ||
		!nullableText(data.email) ||
		!nullableText(data.display_name) ||
		(data.email_verified !== null && typeof data.email_verified !== "boolean")
	)
		throw failure("invalid_response");
	return {
		issuer: data.issuer,
		subject: data.subject,
		email: data.email,
		emailVerified: data.email_verified,
		displayName: data.display_name,
	};
}

async function askApproval(
	session: LinkSession,
	hooks: Hooks,
	approval: HeadlessLinkApproval,
): Promise<void> {
	const expiresAtMs = session.expiresAtMs ?? session.deadline;
	const signal = AbortSignal.any([
		session.signal,
		AbortSignal.timeout(Math.max(1, expiresAtMs - Date.now())),
	]);
	let approved = false;
	try {
		approved = (await hooks.approve(approval, { expiresAtMs, signal })) === true;
	} catch {
		approved = false;
	}
	// A prompt that outlived the attempt or this run is a stop, not a decision.
	if (signal.aborted) throw failure("link_stopped");
	if (!approved) throw failure("link_declined");
	await assertCurrentContext(session.options, session.signal);
}

/** Polling cadence: slow_down on 429 (RFC 8628) and back off on transport failures. */
class PollSchedule {
	intervalMs: number;
	nextMs: number;
	constructor(intervalMs: number) {
		this.intervalMs = intervalMs;
		this.nextMs = intervalMs;
	}
	succeeded(): void {
		this.nextMs = this.intervalMs;
	}
	rateLimited(retryAfterMs: number | undefined): void {
		this.intervalMs = Math.min(this.intervalMs + SLOW_DOWN_STEP_MS, MAX_POLL_INTERVAL_MS);
		this.nextMs = Math.max(retryAfterMs ?? 0, this.intervalMs);
	}
	failed(): void {
		this.nextMs = Math.min(Math.max(this.nextMs, this.intervalMs) * 2, MAX_POLL_INTERVAL_MS);
	}
}

/** One status read; null means wait and poll again. */
async function readPoll(
	session: LinkSession,
	schedule: PollSchedule,
): Promise<Record<string, unknown> | null> {
	try {
		const reply = await request(session, {
			method: "GET",
			path: `${HEADLESS_PATH}/${encodeURIComponent(session.attemptId)}?group_id=${encodeURIComponent(session.options.groupId)}`,
			failureCodes: STATUS_FAILURE_CODES,
			rateLimited: true,
		});
		schedule.succeeded();
		return reply;
	} catch (error) {
		if (session.signal.aborted || !(error instanceof CoordinatorAccountLinkError)) throw error;
		if (error.code === "rate_limited") schedule.rateLimited(error.retryAfterMs);
		else if (error.code === "request_failed") schedule.failed();
		else throw error;
		return null;
	}
}

/** Validates one status reply and reports state changes; stops on a final failed/expired state. */
function observeStatus(
	session: LinkSession,
	reply: Record<string, unknown>,
	report: (state: string) => void,
) {
	const status = readStatus(reply, session);
	if (Object.keys(reply).length !== 3 || !Object.hasOwn(reply, "poll_interval_s"))
		throw failure("invalid_response");
	if (status.state === "failed" || status.state === "expired") {
		// A validated own status proves no cleanup is needed.
		session.stoppedState = status.state;
		throw failure("link_stopped");
	}
	report(status.state);
	return status;
}

async function finalizeApproved(
	session: LinkSession,
	created: Created,
	verifier: Uint8Array,
	approval: HeadlessLinkApproval,
	requestNumber: number,
): Promise<LinkCoordinatorAccountResult | null> {
	try {
		const result = await finalize(
			session,
			created.pin,
			verifier,
			encodeCoordinatorAuthProof32(verifier),
			{
				requestNumber,
				// Bind the link to the exact account this person approved.
				headless: {
					path: `${HEADLESS_PATH}/${encodeURIComponent(session.attemptId)}/finalize`,
					issuer: approval.issuer,
					subject: approval.subject,
				},
			},
		);
		if (result.state === "completed") throw failure("invalid_response");
		return result;
	} catch (error) {
		if (!retryFinalization(error, requestNumber, { intent: "link" })) throw error;
		// Only an own proof-bearing POST reply can report success; poll, then retry.
		return null;
	}
}

async function waitForApproval(
	session: LinkSession,
	hooks: Hooks,
	created: Created,
	verifier: Uint8Array,
): Promise<LinkCoordinatorAccountResult> {
	const schedule = new PollSchedule(created.pollIntervalMs);
	let approval: HeadlessLinkApproval | undefined;
	let lastState = "pending";
	let finalRequests = 0;
	const report = (state: string) => {
		if (state !== lastState) hooks.onState?.(state);
		lastState = state;
	};
	while (!session.signal.aborted && Date.now() < session.deadline) {
		await delay(Math.min(schedule.nextMs, Math.max(1, session.deadline - Date.now())), undefined, {
			signal: session.signal,
		});
		const reply = await readPoll(session, schedule);
		if (!reply) continue;
		const status = observeStatus(session, reply, report);
		if (status.state === "confirmed" && !approval) {
			approval = readApproval(reply.approval);
			await askApproval(session, hooks, approval);
		}
		if (!approval || !readyToFinalize(status, finalRequests)) continue;
		finalRequests++;
		const result = await finalizeApproved(session, created, verifier, approval, finalRequests);
		if (result) return result;
	}
	throw failure("link_stopped");
}

async function runHeadlessLink(
	session: LinkSession,
	hooks: Hooks,
	verifier: Uint8Array,
): Promise<LinkCoordinatorAccountResult> {
	try {
		session.verifierHash = await hashCoordinatorAuthProofBytes32(verifier);
		const created = await createHeadlessAttempt(session);
		await assertCurrentContext(session.options, session.signal);
		hooks.onCode({
			verificationUri: created.verificationUri,
			code: formatHeadlessUserCode(created.code),
			fingerprint: formatShortKeyFingerprint(session.device.fingerprint),
			deviceId: session.device.deviceId,
			expiresAtMs: session.expiresAtMs ?? session.deadline,
		});
		hooks.onState?.("pending");
		return await waitForApproval(session, hooks, created, verifier);
	} catch (error) {
		if (session.created && !session.succeeded && session.stoppedState === undefined) {
			try {
				await cancelAttempt(session);
			} catch (cancellationError) {
				if (!preserveRejection(session, error)) throw cancellationError;
			}
		}
		if (error instanceof CoordinatorAccountLinkError) throw error;
		throw failure("link_stopped");
	}
}

function validOptions(options: LinkCoordinatorAccountHeadlessOptions): boolean {
	return (
		(options.expectedAuthority === "controller_attestation" ||
			options.expectedAuthority === "device_claim") &&
		isAuthControllerId(options.groupId) &&
		isAuthControllerId(options.expectedIdentityId) &&
		(options.expectedCoordinatorId === undefined ||
			isAuthControllerId(options.expectedCoordinatorId)) &&
		(options.assertCurrentContext === undefined ||
			typeof options.assertCurrentContext === "function") &&
		typeof options.onCode === "function" &&
		typeof options.approve === "function" &&
		(options.onState === undefined || typeof options.onState === "function")
	);
}

/**
 * Link the existing device/Identity from a device without a local browser.
 * The person enters a short code on another computer and approves the
 * verified Google account here. No enrollment, Identity adoption, or key creation.
 */
export async function linkCoordinatorAccountHeadless(
	options: LinkCoordinatorAccountHeadlessOptions,
): Promise<LinkCoordinatorAccountResult> {
	const origin = normalizeCoordinatorAccountLinkOrigin(options.coordinatorUrl);
	if (!origin || !validOptions(options)) throw failure("invalid_options");
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), AUTH_LINK_ATTEMPT_TTL_MS);
	const signal = options.signal
		? AbortSignal.any([controller.signal, options.signal])
		: controller.signal;
	const verifier = new Uint8Array(32);
	try {
		await assertCurrentContext(options, signal);
		const device = readDeviceWithKey(options);
		verifier.set(randomBytes(32));
		const session: LinkSession = {
			intent: "link",
			authority: options.expectedAuthority,
			options: { ...options, onBrowserStart: () => {} },
			origin,
			device,
			attemptId: randomUUID(),
			deadline: Date.now() + AUTH_LINK_ATTEMPT_TTL_MS,
			signal,
			created: false,
			succeeded: false,
		};
		return await runHeadlessLink(session, options, verifier);
	} catch (error) {
		if (error instanceof CoordinatorAccountLinkError) throw error;
		throw failure("link_stopped");
	} finally {
		verifier.fill(0);
		clearTimeout(timer);
		controller.abort();
	}
}
