/** Signed device routes for ADR 0005 Section 8 rebinding: start, status, finalize. */
import type { Context, Hono } from "hono";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import { decodeCoordinatorAuthProof32 } from "./coordinator-auth-proof.js";
import type { registerCoordinatorDeviceAuthLinkRoutes } from "./coordinator-device-auth-link.js";
import {
	createDeviceRebindDeviceSteps,
	type DeviceRebindResult,
	type DeviceRebindSigner,
} from "./coordinator-device-rebind-ceremony.js";
import type { DeviceRebindReceipt } from "./coordinator-device-rebind-commit.js";
import {
	createInMemoryRequestRateLimiter,
	type InMemoryRequestRateLimiter,
} from "./request-rate-limit.js";

type LinkDeps = Parameters<typeof registerCoordinatorDeviceAuthLinkRoutes>[1];
type Store = ReturnType<LinkDeps["storeFactory"]>;
type Deps = LinkDeps & { limiter: InMemoryRequestRateLimiter; now: () => number };
type Steps = ReturnType<typeof createDeviceRebindDeviceSteps>;
type Action = "start" | "status" | "finalize";

export const DEVICE_REBIND_ATTEMPTS_PATH = "/v1/auth/rebind-attempts";

const fields = {
	start: [
		"group_id",
		"identity_id",
		"attempt_id",
		"browser_start_hash",
		"loopback_redirect",
		"review_digest",
	],
	status: ["group_id"],
	finalize: ["group_id", "completion", "signature"],
} as const;
type Input = Record<(typeof fields)[Action][number], string>;
const isHash = (value: string) => /^[a-f0-9]{64}$/.test(value);

function exactInput(value: Record<string, unknown> | null, action: Action): value is Input {
	return (
		value !== null &&
		Object.keys(value).length === fields[action].length &&
		fields[action].every((key) => Object.hasOwn(value, key) && typeof value[key] === "string")
	);
}

const unknownOutcome = (c: Context) => c.json({ error: "device_rebind_unknown" }, 503);
const invalid = (c: Context) => c.json({ error: "device_rebind_invalid_input" }, 400);

async function readInput(c: Context, action: Action, deps: Deps) {
	const url = new URL(c.req.url);
	if (url.origin !== new URL(deps.config.redirectUri).origin)
		return c.json({ error: "device_rebind_unavailable" }, 403);
	if (action === "status") {
		const entries = [...url.searchParams.entries()];
		if (c.req.raw.body !== null || entries.length !== fields.status.length) return invalid(c);
		const data = Object.fromEntries(entries);
		return exactInput(data, action) ? { data, raw: new Uint8Array() } : invalid(c);
	}
	if (url.search) return invalid(c);
	const raw = await deps.readRequestBytes(c, 4096);
	if (!raw) return c.json({ error: "body_too_large" }, 413);
	const data = deps.parseJsonObject(raw);
	return exactInput(data, action) ? { data, raw } : invalid(c);
}

function validInput(data: Input, action: Action, attemptId: string): boolean {
	if (!isAuthControllerId(attemptId) || !isAuthControllerId(data.group_id)) return false;
	if (action === "finalize")
		return decodeCoordinatorAuthProof32(data.completion) !== null && data.signature.length <= 512;
	if (action === "status") return true;
	return (
		isAuthControllerId(data.identity_id) &&
		isHash(data.browser_start_hash) &&
		isHash(data.review_digest)
	);
}

/** Explicit allowlist: the receipt is the device's own durable record. */
function receiptJson(receipt: DeviceRebindReceipt) {
	return {
		attempt_id: receipt.attemptId,
		binding_id: receipt.bindingId,
		device_id: receipt.deviceId,
		previous_identity_id: receipt.previousIdentityId,
		target_identity_id: receipt.targetIdentityId,
		enrollment_count: receipt.enrollmentCount,
		finalized_at_ms: receipt.finalizedAtMs,
	};
}

/**
 * `retry` is the only refusal worth repeating as is; every other refusal needs
 * the person to act. An unknown outcome is 503: read status before retrying.
 */
function respond(c: Context, result: DeviceRebindResult | null, deps: Deps): Response {
	if (!result || result.kind === "unknown") return unknownOutcome(c);
	if (result.kind === "refused")
		return c.json(
			{ error: "device_rebind_refused", reason: result.reason },
			result.reason === "retry" ? 409 : 403,
		);
	if (result.kind === "started")
		return c.json({
			attempt_id: result.attemptId,
			expires_at_ms: result.expiresAtMs,
			coordinator_id: deps.config.coordinatorId,
			origin: new URL(deps.config.redirectUri).origin,
			issuer: deps.config.issuer,
			auth_config_revision: deps.config.revision,
		});
	if (result.kind === "status")
		return c.json({
			state: result.state,
			expires_at_ms: result.expiresAtMs,
			target_identity_id: result.targetIdentityId,
			receipt: result.receipt ? receiptJson(result.receipt) : null,
		});
	if (result.kind === "finalized" || result.kind === "prior_commit")
		return c.json({ state: result.kind, receipt: receiptJson(result.receipt) });
	return unknownOutcome(c);
}

function runAction(
	steps: Steps,
	action: Action,
	data: Input,
	attemptId: string,
	signer: DeviceRebindSigner,
) {
	if (action === "status") return steps.status({ attemptId, signer });
	if (action === "finalize")
		return steps.finalize({
			attemptId,
			signer,
			completionSecret: data.completion,
			signature: data.signature,
		});
	return steps.start(
		{
			attemptId,
			signer,
			currentIdentityId: data.identity_id,
			loopbackRedirect: data.loopback_redirect,
			browserStartHash: data.browser_start_hash,
			reviewDigest: data.review_digest,
		},
		signer.deviceId,
	);
}

async function authorize(
	c: Context,
	action: Action,
	data: Input,
	raw: Uint8Array,
	store: Store,
	deps: Deps,
) {
	const auth = await deps.authorizeRequest(store, {
		method: c.req.method,
		url: c.req.url,
		groupId: data.group_id,
		body: raw,
		deviceId: c.req.header("X-Opencode-Device") ?? null,
		signature: c.req.header("X-Opencode-Signature") ?? null,
		timestamp: c.req.header("X-Opencode-Timestamp") ?? null,
		nonce: c.req.header("X-Opencode-Nonce") ?? null,
	});
	if (!auth.ok || !auth.enrollment)
		return (
			deps.rateLimitedResponse(c, `device-rebind:${action}`, { authenticated: false }) ??
			c.json({ error: "device_rebind_unavailable" }, deps.authErrorStatus(auth.error))
		);
	const e = auth.enrollment;
	return (
		deps.rateLimitedResponse(c, `${deps.config.coordinatorId}:${e.device_id}`, {
			authenticated: true,
		}) ?? {
			groupId: e.group_id,
			deviceId: e.device_id,
			publicKey: e.public_key,
			fingerprint: e.fingerprint,
		}
	);
}

async function handle(c: Context, action: Action, deps: Deps): Promise<Response> {
	c.header("Cache-Control", "no-store");
	c.header("Referrer-Policy", "no-referrer");
	let store: Store | undefined;
	try {
		try {
			const input = await readInput(c, action, deps);
			if (input instanceof Response) return input;
			const attemptId =
				action === "start" ? input.data.attempt_id : (c.req.param("attemptId") ?? "");
			if (!validInput(input.data, action, attemptId)) return invalid(c);
			store = deps.storeFactory();
			const signer = await authorize(c, action, input.data, input.raw, store, deps);
			if (signer instanceof Response) return signer;
			const steps = await deviceSteps(store, deps);
			if (!steps) return c.json({ error: "not_found" }, 404);
			return respond(c, await runAction(steps, action, input.data, attemptId, signer), deps);
		} finally {
			await store?.close();
		}
	} catch {
		return unknownOutcome(c);
	}
}

async function deviceSteps(store: Store, deps: Deps): Promise<Steps | null> {
	const backend = (await store.readDeviceRebindBackend?.()) ?? null;
	if (!backend) return null;
	return createDeviceRebindDeviceSteps({
		backend,
		config: deps.config,
		publicOrigin: new URL(deps.config.redirectUri).origin,
		limiter: deps.limiter,
		now: deps.now,
	});
}

/** Signed admission runs before any rebind storage is touched. */
export function registerCoordinatorDeviceRebindRoutes(
	app: Hono,
	deps: LinkDeps & { now?: () => number },
): void {
	if (!deps.config.enabled) return;
	const now = deps.now ?? (() => Date.now());
	const captured: Deps = { ...deps, now, limiter: createInMemoryRequestRateLimiter({ now }) };
	app.post(DEVICE_REBIND_ATTEMPTS_PATH, (c) => handle(c, "start", captured));
	app.get(`${DEVICE_REBIND_ATTEMPTS_PATH}/:attemptId`, (c) => handle(c, "status", captured));
	app.post(`${DEVICE_REBIND_ATTEMPTS_PATH}/:attemptId/finalize`, (c) =>
		handle(c, "finalize", captured),
	);
}
