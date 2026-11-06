import type { Context } from "hono";
import type { CoordinatorAuthBrowserConfig } from "./coordinator-auth-browser-transaction-contract.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import { HEADLESS_LINK_BROWSER_PATHS } from "./coordinator-auth-headless-view.js";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import type {
	CoordinatorAuthLinkCreateResult,
	CoordinatorAuthLinkResult,
	CoordinatorAuthLinkSigner,
} from "./coordinator-auth-link-contract.js";
import {
	type CoordinatorAuthLinkHeadlessApproval,
	type CoordinatorAuthLinkHeadlessApprovalInput,
	type CoordinatorAuthLinkHeadlessCreateInput,
	type CoordinatorAuthLinkHeadlessFinalizeInput,
	isHeadlessUserCodeHeldByAnotherAttempt,
} from "./coordinator-auth-link-headless.js";
import {
	type CoordinatorDeviceAuthLinkStore,
	createRejectedResponse,
	type DeviceAuthLinkApp,
	type DeviceAuthLinkDeps,
	exactStrings,
	FIELDS,
	finalizeInput,
	isHash,
	rejectedResponse,
	resolveCreateAuthority,
	runSignedDeviceRequest,
	type SignedDeviceInput,
	validFinalizeFields,
} from "./coordinator-device-auth-link.js";

export const HEADLESS_LINK_ATTEMPTS_PATH = "/v1/auth/headless-link-attempts";
/** The device polls status no faster than this; the device rate limit allows far more. */
export const HEADLESS_LINK_POLL_INTERVAL_S = 5;
const MAX_BODY_BYTES = 4096;
const MAX_SUBJECT_LENGTH = 255;

const HEADLESS_FIELDS = {
	create: [
		"group_id",
		"identity_id",
		"authority",
		"attempt_id",
		"runtime_verifier_hash",
		"user_code_hash",
	],
	finalize: [...FIELDS.finalize, "approved_issuer", "approved_subject"],
} as const;

/** Store operations behind the headless routes; checked at request time. */
export interface HeadlessDeviceLinkOperations {
	readHeadlessLinkBackend(): Promise<AuthLinkBackend | null>;
	createHeadlessAuthLinkAttempt(
		input: CoordinatorAuthLinkHeadlessCreateInput,
		config: CoordinatorAuthBrowserConfig,
	): Promise<CoordinatorAuthLinkCreateResult>;
	readHeadlessAuthLinkApproval(
		input: CoordinatorAuthLinkHeadlessApprovalInput,
		config: CoordinatorAuthBrowserConfig,
	): Promise<CoordinatorAuthLinkHeadlessApproval | null>;
	finalizeHeadlessAuthLinkAttempt(
		input: CoordinatorAuthLinkHeadlessFinalizeInput,
		config: CoordinatorAuthBrowserConfig,
	): Promise<CoordinatorAuthLinkResult>;
}
type HeadlessStore = CoordinatorDeviceAuthLinkStore & HeadlessDeviceLinkOperations;
type Action = "create" | "status" | "finalize";
type Ctx = { c: Context; deps: DeviceAuthLinkDeps; backend: AuthLinkBackend };

function hasHeadlessOperations(store: CoordinatorDeviceAuthLinkStore): store is HeadlessStore {
	const candidate = store as Partial<HeadlessDeviceLinkOperations>;
	return (
		typeof candidate.readHeadlessLinkBackend === "function" &&
		typeof candidate.createHeadlessAuthLinkAttempt === "function" &&
		typeof candidate.readHeadlessAuthLinkApproval === "function" &&
		typeof candidate.finalizeHeadlessAuthLinkAttempt === "function"
	);
}

/** The code-entry page URL; null unless the configured redirect is an https URL. */
export function headlessVerificationUri(config: CoordinatorAuthBrowserConfig): string | null {
	try {
		const redirect = new URL(config.redirectUri);
		if (redirect.protocol !== "https:") return null;
		return new URL(HEADLESS_LINK_BROWSER_PATHS.code, redirect.origin).href;
	} catch {
		return null;
	}
}

function invalid(c: Context): Response {
	return c.json({ error: "auth_link_invalid_input" }, 400);
}

function validCreate(data: Record<string, unknown>): boolean {
	return (
		exactStrings(data, HEADLESS_FIELDS.create) &&
		isAuthControllerId(data.group_id) &&
		isAuthControllerId(data.identity_id) &&
		isAuthControllerId(data.attempt_id) &&
		(data.authority === "device_claim" || data.authority === "controller_attestation") &&
		isHash(data.runtime_verifier_hash) &&
		isHash(data.user_code_hash)
	);
}

function validFinalize(
	data: Record<string, unknown>,
	attemptId: string,
	config: CoordinatorAuthBrowserConfig,
): boolean {
	return (
		exactStrings(data, HEADLESS_FIELDS.finalize) &&
		isAuthControllerId(data.group_id) &&
		validFinalizeFields(data, attemptId, config) &&
		data.approved_issuer === config.issuer &&
		data.approved_subject.length > 0 &&
		data.approved_subject.length <= MAX_SUBJECT_LENGTH
	);
}

async function readBody(
	c: Context,
	deps: DeviceAuthLinkDeps,
	action: "create" | "finalize",
): Promise<SignedDeviceInput | Response> {
	const raw = await deps.readRequestBytes(c, MAX_BODY_BYTES);
	if (!raw) return c.json({ error: "body_too_large" }, 413);
	const data = deps.parseJsonObject(raw);
	if (!data) return invalid(c);
	if (action === "create") {
		if (!validCreate(data)) return invalid(c);
		return { raw, data: data as SignedDeviceInput["data"], attemptId: String(data.attempt_id) };
	}
	const attemptId = c.req.param("attemptId") ?? "";
	if (!isAuthControllerId(attemptId) || !validFinalize(data, attemptId, deps.config))
		return invalid(c);
	return { raw, data: data as SignedDeviceInput["data"], attemptId };
}

/** Status is a signed GET: its only input is the exact group_id query. */
function readStatusQuery(c: Context): SignedDeviceInput | Response {
	const entries = [...new URL(c.req.url).searchParams.entries()];
	const entry = entries[0];
	const attemptId = c.req.param("attemptId") ?? "";
	if (
		entries.length !== 1 ||
		!entry ||
		entry[0] !== "group_id" ||
		!isAuthControllerId(entry[1]) ||
		!isAuthControllerId(attemptId)
	)
		return invalid(c);
	return { raw: new Uint8Array(), data: { group_id: entry[1] }, attemptId };
}

async function createAttempt(
	ctx: Ctx,
	store: HeadlessStore,
	signer: CoordinatorAuthLinkSigner,
	input: SignedDeviceInput,
): Promise<Response> {
	const { c, deps } = ctx;
	const verificationUri = headlessVerificationUri(deps.config);
	if (!verificationUri) return c.json({ error: "headless_link_origin_unavailable" }, 503);
	const data = input.data as Record<(typeof HEADLESS_FIELDS.create)[number], string>;
	const authority = await resolveCreateAuthority(c, store, data, signer, deps.config);
	if (authority instanceof Response) return authority;
	const result = await store.createHeadlessAuthLinkAttempt(
		{
			authority,
			expectedIdentityId: data.identity_id,
			attemptId: input.attemptId,
			signer,
			runtimeVerifierHash: data.runtime_verifier_hash,
			userCodeHash: data.user_code_hash,
		},
		deps.config,
	);
	if (result.kind === "rejected") {
		const held =
			result.error === "attempt_conflict" &&
			(await isHeadlessUserCodeHeldByAnotherAttempt(ctx.backend, {
				coordinatorId: deps.config.coordinatorId,
				userCodeHash: data.user_code_hash,
				attemptId: input.attemptId,
			}));
		// The device picks a fresh code and retries; the code is never shared with another attempt.
		if (held) return c.json({ error: "user_code_conflict" }, 409);
		return createRejectedResponse(c, result);
	}
	return c.json(
		{
			status: result.status,
			identity_id: result.identityId,
			authority: authority.kind,
			coordinator_id: deps.config.coordinatorId,
			verification_uri: verificationUri,
			poll_interval_s: HEADLESS_LINK_POLL_INTERVAL_S,
		},
		result.kind === "created" ? 201 : 200,
	);
}

async function readStatus(
	ctx: Ctx,
	store: HeadlessStore,
	signer: CoordinatorAuthLinkSigner,
	input: SignedDeviceInput,
): Promise<Response> {
	const { c, deps } = ctx;
	const status = await store.getAuthLinkAttemptStatus(
		input.attemptId,
		{ kind: "device", signer },
		deps.config,
	);
	if (!status) return c.json({ error: "auth_link_unavailable" }, 404);
	const approval =
		status.state === "confirmed"
			? await store.readHeadlessAuthLinkApproval(
					{ attemptId: input.attemptId, signer },
					deps.config,
				)
			: null;
	return c.json({
		status,
		poll_interval_s: HEADLESS_LINK_POLL_INTERVAL_S,
		approval: approval && {
			issuer: approval.issuer,
			subject: approval.subject,
			email: approval.email,
			email_verified: approval.emailVerified,
			display_name: approval.displayName,
		},
	});
}

async function finalizeAttempt(
	ctx: Ctx,
	store: HeadlessStore,
	signer: CoordinatorAuthLinkSigner,
	input: SignedDeviceInput,
): Promise<Response> {
	const { c, deps } = ctx;
	const data = input.data as Record<(typeof HEADLESS_FIELDS.finalize)[number], string>;
	const proof = await finalizeInput(data, input.attemptId, signer, deps.config);
	if (!proof) return invalid(c);
	const result = await store.finalizeHeadlessAuthLinkAttempt(
		{
			...proof,
			approvedAccount: { issuer: data.approved_issuer, subject: data.approved_subject },
		},
		deps.config,
	);
	if (result.kind === "rejected") return rejectedResponse(c, result, { reviewRequired: true });
	return c.json({ status: result.status });
}

const APPLY = { create: createAttempt, status: readStatus, finalize: finalizeAttempt } as const;

function handleHeadlessRequest(
	c: Context,
	action: Action,
	deps: DeviceAuthLinkDeps,
): Promise<Response> {
	let backend: AuthLinkBackend | null = null;
	return runSignedDeviceRequest(c, deps, {
		label: `headless_${action}`,
		// Off (not found) unless this coordinator has the headless tables.
		gate: async (store) => {
			backend = hasHeadlessOperations(store) ? await store.readHeadlessLinkBackend() : null;
			return backend ? null : c.json({ error: "not_found" }, 404);
		},
		read: async () => (action === "status" ? readStatusQuery(c) : readBody(c, deps, action)),
		apply: (store, signer, input) => {
			if (!backend || !hasHeadlessOperations(store))
				return Promise.resolve(c.json({ error: "not_found" }, 404));
			return APPLY[action]({ c, deps, backend }, store, signer, input);
		},
	});
}

/**
 * Device-signed headless link routes. Mount only with the browser half, which
 * serves the code-entry page these routes send the person to.
 */
export function registerCoordinatorDeviceHeadlessLinkRoutes(
	app: DeviceAuthLinkApp,
	deps: DeviceAuthLinkDeps,
): void {
	const { coordinatorId, issuer, revision, enabled, redirectUri } = deps.config;
	if (!enabled) return;
	// Retain only the reviewed configuration snapshot, never SDK secrets.
	const config = Object.freeze({ coordinatorId, issuer, revision, enabled, redirectUri });
	const captured: DeviceAuthLinkDeps = {
		config,
		storeFactory: deps.storeFactory,
		authorizeRequest: deps.authorizeRequest,
		authErrorStatus: deps.authErrorStatus,
		readRequestBytes: deps.readRequestBytes,
		parseJsonObject: deps.parseJsonObject,
		rateLimitedResponse: deps.rateLimitedResponse,
	};
	app.post(HEADLESS_LINK_ATTEMPTS_PATH, (c) => handleHeadlessRequest(c, "create", captured));
	app.get(`${HEADLESS_LINK_ATTEMPTS_PATH}/:attemptId`, (c) =>
		handleHeadlessRequest(c, "status", captured),
	);
	app.post(`${HEADLESS_LINK_ATTEMPTS_PATH}/:attemptId/finalize`, (c) =>
		handleHeadlessRequest(c, "finalize", captured),
	);
}
