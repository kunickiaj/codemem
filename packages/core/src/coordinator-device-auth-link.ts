import type { Context } from "hono";
import type {
	CoordinatorAuthBrowserConfig,
	CoordinatorAuthBrowserTransactionStore,
} from "./coordinator-auth-browser-transaction-contract.js";
import type { CoordinatorAuthControllerStore } from "./coordinator-auth-controller.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import {
	AUTH_LINK_PURPOSE,
	type CoordinatorAuthLinkRejected,
	type CoordinatorAuthLinkSigner,
	type CoordinatorAuthLinkStore,
} from "./coordinator-auth-link-contract.js";
import { parseCoordinatorAuthLoopback } from "./coordinator-auth-loopback.js";
import {
	decodeCoordinatorAuthProof32,
	hashCoordinatorAuthProofBytes32,
} from "./coordinator-auth-proof.js";
import type { CoordinatorEnrollment, CoordinatorStore } from "./coordinator-store-contract.js";

export type CoordinatorDeviceAuthLinkStore = CoordinatorStore &
	Pick<CoordinatorAuthControllerStore, "createAuthControllerAttestation"> &
	Pick<
		CoordinatorAuthLinkStore,
		| "createAuthLinkAttempt"
		| "getAuthLinkAttemptStatus"
		| "finalizeAuthLinkAttempt"
		| "failAuthLinkAttempt"
	> &
	Pick<CoordinatorAuthBrowserTransactionStore, "retireAuthBrowserTransactions">;

export interface CoordinatorDeviceAuthLinkOptions {
	config: CoordinatorAuthBrowserConfig;
	storeFactory: () => CoordinatorDeviceAuthLinkStore;
}

interface SignedRequest {
	method: string;
	url: string;
	groupId: string;
	body: Uint8Array;
	deviceId: string | null;
	signature: string | null;
	timestamp: string | null;
	nonce: string | null;
}
interface DeviceAuthLinkDeps extends CoordinatorDeviceAuthLinkOptions {
	authorizeRequest: (
		store: CoordinatorDeviceAuthLinkStore,
		request: SignedRequest,
	) => Promise<{ ok: boolean; error: string; enrollment: CoordinatorEnrollment | null }>;
	authErrorStatus: (error: string) => 401 | 403 | 409;
	readRequestBytes: (c: Context, maxBytes: number) => Promise<Uint8Array | null>;
	parseJsonObject: (raw: Uint8Array) => Record<string, unknown> | null;
	rateLimitedResponse: (
		c: Context,
		key: string,
		options: { authenticated: boolean },
	) => Response | null;
}
interface DeviceAuthLinkApp {
	get(path: string, handler: (c: Context) => Promise<Response>): unknown;
	post(path: string, handler: (c: Context) => Promise<Response>): unknown;
}
type Action = "create" | "status" | "finalize" | "cancel";
const FIELDS = {
	create: [
		"group_id",
		"attempt_id",
		"runtime_verifier_hash",
		"browser_start_hash",
		"loopback_redirect",
	],
	finalize: [
		"purpose",
		"coordinator_id",
		"attempt_id",
		"group_id",
		"identity_id",
		"device_id",
		"fingerprint",
		"runtime_verifier",
		"completion",
	],
	cancel: ["group_id"],
} as const;

function exactStrings<T extends string>(
	data: Record<string, unknown> | null,
	fields: readonly T[],
): data is Record<T, string> {
	return (
		data !== null &&
		Object.keys(data).length === fields.length &&
		fields.every((field) => Object.hasOwn(data, field) && typeof data[field] === "string")
	);
}
function isHash(value: unknown): value is string {
	return typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
}
function validInput(
	action: Action,
	data: Record<string, unknown>,
	attemptId: string,
	config: CoordinatorAuthBrowserConfig,
): data is Record<string, unknown> & { group_id: string } {
	if (!isAuthControllerId(data.group_id) || !isAuthControllerId(attemptId)) return false;
	if (action === "create") {
		return (
			exactStrings(data, FIELDS.create) &&
			isHash(data.runtime_verifier_hash) &&
			isHash(data.browser_start_hash) &&
			parseCoordinatorAuthLoopback(data.loopback_redirect).ok
		);
	}
	if (action !== "finalize") return true;
	return (
		exactStrings(data, FIELDS.finalize) &&
		data.purpose === AUTH_LINK_PURPOSE &&
		data.coordinator_id === config.coordinatorId &&
		data.attempt_id === attemptId &&
		isAuthControllerId(data.identity_id) &&
		isAuthControllerId(data.device_id) &&
		isHash(data.fingerprint) &&
		decodeCoordinatorAuthProof32(data.runtime_verifier) !== null &&
		decodeCoordinatorAuthProof32(data.completion) !== null
	);
}
function rejectedResponse(
	c: Context,
	result: CoordinatorAuthLinkRejected,
	options: { reviewRequired?: boolean } = {},
): Response {
	if (result.error === "attempt_limited") return c.json({ error: "auth_link_limited" }, 429);
	if (result.error === "attempt_conflict" || result.error === "link_conflict") {
		return c.json({ error: "auth_link_conflict" }, 409);
	}
	if (options.reviewRequired && result.error === "controller_not_active") {
		return c.json({ error: "auth_link_review_required" }, 403);
	}
	return c.json({ error: "auth_link_unavailable" }, 403);
}

async function applyDeviceAction(
	c: Context,
	action: Action,
	store: CoordinatorDeviceAuthLinkStore,
	data: Record<string, unknown> & { group_id: string },
	attemptId: string,
	signer: CoordinatorAuthLinkSigner,
	config: CoordinatorAuthBrowserConfig,
): Promise<Response> {
	if (action === "status") {
		const status = await store.getAuthLinkAttemptStatus(
			attemptId,
			{ kind: "device", signer },
			config,
		);
		if (!status) return c.json({ error: "auth_link_unavailable" }, 404);
		return c.json({ status });
	}
	if (action === "create") {
		if (!exactStrings(data, FIELDS.create))
			return c.json({ error: "auth_link_invalid_input" }, 400);
		const result = await store.createAuthLinkAttempt(
			{
				attemptId,
				signer,
				runtimeVerifierHash: data.runtime_verifier_hash,
				browserStartHash: data.browser_start_hash,
				loopbackRedirect: data.loopback_redirect,
			},
			config,
		);
		if (result.kind === "rejected") return rejectedResponse(c, result, { reviewRequired: true });
		return c.json(
			{
				status: result.status,
				identity_id: result.identityId,
				coordinator_id: config.coordinatorId,
			},
			result.kind === "created" ? 201 : 200,
		);
	}
	if (action === "cancel") {
		return cancelDeviceAttempt(c, store, attemptId, signer, config);
	}
	if (!exactStrings(data, FIELDS.finalize))
		return c.json({ error: "auth_link_invalid_input" }, 400);
	return finalizeDeviceAttempt(c, store, data, attemptId, signer, config);
}

async function cancelDeviceAttempt(
	c: Context,
	store: CoordinatorDeviceAuthLinkStore,
	attemptId: string,
	signer: CoordinatorAuthLinkSigner,
	config: CoordinatorAuthBrowserConfig,
): Promise<Response> {
	const result = await store.failAuthLinkAttempt(
		{
			attemptId,
			requester: { kind: "device", signer },
			reason: "cancelled",
		},
		config,
	);
	if (result.kind === "rejected") return rejectedResponse(c, result);
	if (result.status.state !== "failed") return c.json({ error: "auth_link_unavailable" }, 503);
	// Failure is already committed: cleanup faults must never report success.
	const retired = await store.retireAuthBrowserTransactions(config, { attemptId });
	if (retired.kind !== "retired" || retired.more)
		return c.json({ error: "auth_link_unavailable" }, 503);
	return c.json({ status: result.status });
}

async function finalizeDeviceAttempt(
	c: Context,
	store: CoordinatorDeviceAuthLinkStore,
	data: Record<(typeof FIELDS.finalize)[number], string>,
	attemptId: string,
	signer: CoordinatorAuthLinkSigner,
	config: CoordinatorAuthBrowserConfig,
): Promise<Response> {
	const runtimeVerifier = decodeCoordinatorAuthProof32(data.runtime_verifier);
	const completion = decodeCoordinatorAuthProof32(data.completion);
	if (!runtimeVerifier || !completion) return c.json({ error: "auth_link_invalid_input" }, 400);
	const runtimeVerifierHash = await hashCoordinatorAuthProofBytes32(runtimeVerifier);
	const completionSecretHash = await hashCoordinatorAuthProofBytes32(completion);
	const result = await store.finalizeAuthLinkAttempt(
		{
			purpose: AUTH_LINK_PURPOSE,
			coordinatorId: config.coordinatorId,
			attemptId,
			groupId: data.group_id,
			identityId: data.identity_id,
			deviceId: data.device_id,
			fingerprint: data.fingerprint,
			runtimeVerifierHash,
			completionSecretHash,
			signer,
		},
		config,
	);
	if (result.kind === "rejected") return rejectedResponse(c, result, { reviewRequired: true });
	return c.json({ status: result.status });
}

async function readDeviceInput(
	c: Context,
	action: Action,
	url: string,
	deps: DeviceAuthLinkDeps,
): Promise<{ raw: Uint8Array; data: Record<string, unknown> } | Response> {
	if (action === "status") {
		const entries = [...new URL(url).searchParams.entries()];
		const entry = entries[0];
		if (entries.length !== 1 || !entry || entry[0] !== "group_id") {
			return c.json({ error: "auth_link_invalid_input" }, 400);
		}
		return { raw: new Uint8Array(), data: { group_id: entry[1] } };
	}
	const raw = await deps.readRequestBytes(c, 4096);
	if (!raw) return c.json({ error: "body_too_large" }, 413);
	const data = deps.parseJsonObject(raw);
	if (!exactStrings(data, FIELDS[action])) return c.json({ error: "auth_link_invalid_input" }, 400);
	return { raw, data };
}

async function handleDeviceRequest(
	c: Context,
	action: Action,
	deps: DeviceAuthLinkDeps,
): Promise<Response> {
	c.header("Cache-Control", "no-store");
	const { config, storeFactory, authorizeRequest, rateLimitedResponse, authErrorStatus } = deps;
	let store: CoordinatorDeviceAuthLinkStore | undefined;
	try {
		try {
			const request = {
				method: c.req.method,
				url: c.req.url,
				deviceId: c.req.header("X-Opencode-Device") ?? null,
				signature: c.req.header("X-Opencode-Signature") ?? null,
				timestamp: c.req.header("X-Opencode-Timestamp") ?? null,
				nonce: c.req.header("X-Opencode-Nonce") ?? null,
			};
			const pathAttemptId = c.req.param("attemptId") ?? "";
			const input = await readDeviceInput(c, action, request.url, deps);
			if (input instanceof Response) return input;
			const { raw, data } = input;
			const attemptId = action === "create" ? data.attempt_id : pathAttemptId;
			if (!isAuthControllerId(attemptId) || !validInput(action, data, attemptId, config))
				return c.json({ error: "auth_link_invalid_input" }, 400);
			store = storeFactory();
			const auth = await authorizeRequest(store, {
				...request,
				groupId: data.group_id,
				body: raw,
			});
			if (!auth.ok || !auth.enrollment) {
				return (
					rateLimitedResponse(c, `link:${action}`, { authenticated: false }) ??
					c.json({ error: "auth_link_unavailable" }, authErrorStatus(auth.error))
				);
			}
			const enrollment = auth.enrollment;
			const limited = rateLimitedResponse(c, `${config.coordinatorId}:${enrollment.device_id}`, {
				authenticated: true,
			});
			if (limited) return limited;
			const signer = {
				groupId: enrollment.group_id,
				deviceId: enrollment.device_id,
				publicKey: enrollment.public_key,
				fingerprint: enrollment.fingerprint,
			};
			return await applyDeviceAction(c, action, store, data, attemptId, signer, config);
		} finally {
			await store?.close();
		}
	} catch {
		return c.json({ error: "auth_link_unavailable" }, 503);
	}
}

export function registerCoordinatorDeviceAuthLinkRoutes(
	app: DeviceAuthLinkApp,
	deps: DeviceAuthLinkDeps,
): void {
	const { coordinatorId, issuer, revision, enabled, redirectUri } = deps.config;
	if (!enabled) return;
	// Retain only the reviewed configuration snapshot, never SDK secrets.
	const config = Object.freeze({ coordinatorId, issuer, revision, enabled, redirectUri });
	const {
		storeFactory,
		authorizeRequest,
		authErrorStatus,
		readRequestBytes,
		parseJsonObject,
		rateLimitedResponse,
	} = deps;
	const captured = {
		config,
		storeFactory,
		authorizeRequest,
		authErrorStatus,
		readRequestBytes,
		parseJsonObject,
		rateLimitedResponse,
	};
	app.post("/v1/auth/link-attempts", (c) => handleDeviceRequest(c, "create", captured));
	app.get("/v1/auth/link-attempts/:attemptId", (c) => handleDeviceRequest(c, "status", captured));
	app.post("/v1/auth/link-attempts/:attemptId/finalize", (c) =>
		handleDeviceRequest(c, "finalize", captured),
	);
	app.post("/v1/auth/link-attempts/:attemptId/cancel", (c) =>
		handleDeviceRequest(c, "cancel", captured),
	);
}
