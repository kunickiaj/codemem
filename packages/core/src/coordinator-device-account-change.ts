import type { Context, Hono } from "hono";
import type { AccountChangeOperations } from "./coordinator-account-change.js";
import { AUTH_ACCOUNT_CHANGE_PURPOSE } from "./coordinator-account-change-contract.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { CoordinatorAuthLinkSigner } from "./coordinator-auth-link-contract.js";
import { parseCoordinatorAuthLoopback } from "./coordinator-auth-loopback.js";
import {
	decodeCoordinatorAuthProof32,
	hashCoordinatorAuthProofBytes32,
} from "./coordinator-auth-proof.js";
import type { registerCoordinatorDeviceAuthLinkRoutes } from "./coordinator-device-auth-link.js";

type LinkDeps = Parameters<typeof registerCoordinatorDeviceAuthLinkRoutes>[1];
type ChangeOperations = Pick<
	AccountChangeOperations,
	"create" | "readStatus" | "finalize" | "cancel" | "readCapabilities" | "unlink"
>;
export interface CoordinatorDeviceAccountChangeOptions {
	config: LinkDeps["config"];
	storeFactory: LinkDeps["storeFactory"];
	/** Must check the account-change schema, not only the older link schema. */
	assertReady: (store: ReturnType<LinkDeps["storeFactory"]>) => Promise<void>;
	operationsFactory: (
		store: ReturnType<LinkDeps["storeFactory"]>,
	) => ChangeOperations | null | Promise<ChangeOperations | null>;
}
type Deps = Omit<LinkDeps, "config" | "storeFactory"> & CoordinatorDeviceAccountChangeOptions;
type Action = "create" | "status" | "finalize" | "cancel" | "capabilities" | "unlink";
const pins = ["group_id", "identity_id", "runtime_verifier_hash"] as const;
const fields = {
	unlink: ["group_id", "identity_id", "attempt_id", "target_link_id"],
	capabilities: ["group_id", "identity_id"],
	create: [...pins, "intent", "attempt_id", "browser_start_hash", "loopback_redirect"],
	status: pins,
	cancel: pins,
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
function unavailable(c: Context): Response {
	return c.json({ error: "authentication_unavailable" }, 503);
}
function denied(c: Context): Response {
	return c.json({ error: "account_change_unavailable" }, 403);
}
function invalid(c: Context): Response {
	return c.json({ error: "account_change_invalid_input" }, 400);
}

async function readInput(c: Context, action: Action, deps: Deps) {
	const url = new URL(c.req.url);
	if (url.origin !== new URL(deps.config.redirectUri).origin) return denied(c);
	if (action === "status" || action === "capabilities") {
		const entries = [...url.searchParams.entries()];
		if (c.req.raw.body !== null || entries.length !== fields[action].length) return invalid(c);
		const data = Object.fromEntries(entries);
		if (!exactInput(data, action)) return invalid(c);
		return { data, raw: new Uint8Array() };
	}
	if (url.search) return invalid(c);
	const raw = await deps.readRequestBytes(c, 4096);
	if (!raw) return c.json({ error: "body_too_large" }, 413);
	const data = deps.parseJsonObject(raw);
	if (!exactInput(data, action)) return invalid(c);
	return { data, raw };
}
function validPins(data: Input, attemptId: string): boolean {
	return (
		isAuthControllerId(attemptId) &&
		isAuthControllerId(data.group_id) &&
		isAuthControllerId(data.identity_id)
	);
}
function validInput(data: Input, action: Action, attemptId: string, deps: Deps): boolean {
	if (action === "capabilities")
		return isAuthControllerId(data.group_id) && isAuthControllerId(data.identity_id);
	if (!validPins(data, attemptId)) return false;
	if (action === "unlink") return isAuthControllerId(data.target_link_id);
	if (action === "finalize") {
		return (
			data.purpose === AUTH_ACCOUNT_CHANGE_PURPOSE &&
			data.coordinator_id === deps.config.coordinatorId &&
			data.attempt_id === attemptId &&
			isAuthControllerId(data.device_id) &&
			isHash(data.fingerprint) &&
			decodeCoordinatorAuthProof32(data.runtime_verifier) !== null &&
			decodeCoordinatorAuthProof32(data.completion) !== null
		);
	}
	if (!isHash(data.runtime_verifier_hash)) return false;
	if (action !== "create") return true;
	return (
		(data.intent === "refresh" || data.intent === "disconnect") &&
		isHash(data.browser_start_hash) &&
		parseCoordinatorAuthLoopback(data.loopback_redirect).ok
	);
}
async function finalizeProof(
	c: Context,
	data: Input,
	input: {
		attemptId: string;
		signer: CoordinatorAuthLinkSigner;
		expectedIdentityId: string;
		runtimeVerifierHash: string;
	},
	operations: ChangeOperations,
	deps: Deps,
): Promise<string | Response> {
	if (data.device_id !== input.signer.deviceId || data.fingerprint !== input.signer.fingerprint)
		return denied(c);
	const verifier = decodeCoordinatorAuthProof32(data.runtime_verifier);
	const completion = decodeCoordinatorAuthProof32(data.completion);
	if (!verifier || !completion) return invalid(c);
	const runtimeVerifierHash = await hashCoordinatorAuthProofBytes32(verifier);
	const result = await operations.finalize(
		{
			...input,
			runtimeVerifierHash,
			completionSecretHash: await hashCoordinatorAuthProofBytes32(completion),
		},
		deps.config,
	);
	return result ? runtimeVerifierHash : denied(c);
}
async function applyAction(
	c: Context,
	action: Action,
	data: Input,
	attemptId: string,
	signer: CoordinatorAuthLinkSigner,
	operations: ChangeOperations,
	deps: Deps,
): Promise<Response> {
	if (action === "unlink") return applyUnlink(c, data, attemptId, signer, operations, deps);
	if (action === "capabilities") {
		const { unlinkTarget, ...actions } = await operations.readCapabilities(
			{ signer, expectedIdentityId: data.identity_id },
			deps.config,
		);
		return c.json({
			coordinator_id: deps.config.coordinatorId,
			identity_id: data.identity_id,
			actions,
			...(unlinkTarget ? { unlink_target: unlinkTarget } : {}),
		});
	}
	return applyBrowserAction(c, action, data, attemptId, signer, operations, deps);
}
async function applyUnlink(
	c: Context,
	data: Input,
	attemptId: string,
	signer: CoordinatorAuthLinkSigner,
	operations: ChangeOperations,
	deps: Deps,
): Promise<Response> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify(fields.unlink.map((key) => data[key]))),
	);
	const requestHash = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	const result = await operations.unlink(
		{
			attemptId,
			signer,
			expectedIdentityId: data.identity_id,
			expectedLinkId: data.target_link_id,
			requestHash,
		},
		deps.config,
	);
	return result
		? c.json({
				state: "completed",
				attemptId,
				identityId: data.identity_id,
				coordinatorId: deps.config.coordinatorId,
				targetLinkId: result.targetLinkId,
			})
		: denied(c);
}
async function applyBrowserAction(
	c: Context,
	action: Action,
	data: Input,
	attemptId: string,
	signer: CoordinatorAuthLinkSigner,
	operations: ChangeOperations,
	deps: Deps,
): Promise<Response> {
	const input = {
		attemptId,
		signer,
		expectedIdentityId: data.identity_id,
		runtimeVerifierHash: data.runtime_verifier_hash,
	};
	if (action === "finalize") {
		const proof = await finalizeProof(c, data, input, operations, deps);
		if (proof instanceof Response) return proof;
		input.runtimeVerifierHash = proof;
	}
	if (action === "create") {
		const created = await operations.create(
			{
				...input,
				intent: data.intent,
				browserStartHash: data.browser_start_hash,
				loopbackRedirect: data.loopback_redirect,
			},
			deps.config,
		);
		if (!created) return denied(c);
	}
	if (action === "cancel" && !(await operations.cancel(input, deps.config))) return denied(c);
	const status = await operations.readStatus(input, deps.config);
	if (!status) return denied(c);
	// Explicit allowlist: private browser state and provider data never cross HTTP.
	const publicStatus = {
		attemptId: status.attemptId,
		intent: status.intent,
		state: status.state,
		expiresAtMs: status.expiresAtMs,
		identityId: status.identityId,
	};
	if (action === "finalize" && status.state !== "completed") return unavailable(c);
	if (action === "create")
		return c.json({
			coordinator_id: deps.config.coordinatorId,
			identity_id: status.identityId,
			status: publicStatus,
		});
	return c.json({ status: publicStatus });
}
async function handle(c: Context, action: Action, deps: Deps): Promise<Response> {
	c.header("Cache-Control", "no-store");
	c.header("Referrer-Policy", "no-referrer");
	let store: ReturnType<Deps["storeFactory"]> | undefined;
	try {
		try {
			const input = await readInput(c, action, deps);
			if (input instanceof Response) return input;
			const attemptId = ["create", "unlink"].includes(action)
				? input.data.attempt_id
				: (c.req.param("attemptId") ?? "");
			if (!validInput(input.data, action, attemptId, deps)) return invalid(c);
			store = deps.storeFactory();
			const auth = await deps.authorizeRequest(store, {
				method: c.req.method,
				url: c.req.url,
				groupId: input.data.group_id,
				body: input.raw,
				deviceId: c.req.header("X-Opencode-Device") ?? null,
				signature: c.req.header("X-Opencode-Signature") ?? null,
				timestamp: c.req.header("X-Opencode-Timestamp") ?? null,
				nonce: c.req.header("X-Opencode-Nonce") ?? null,
			});
			if (!auth.ok || !auth.enrollment)
				return (
					deps.rateLimitedResponse(c, `account-change:${action}`, { authenticated: false }) ??
					c.json({ error: "account_change_unavailable" }, deps.authErrorStatus(auth.error))
				);
			const enrollment = auth.enrollment;
			const limited = deps.rateLimitedResponse(
				c,
				`${deps.config.coordinatorId}:${enrollment.device_id}`,
				{ authenticated: true },
			);
			if (limited) return limited;
			await deps.assertReady(store);
			const operations = await deps.operationsFactory(store);
			if (!operations) return c.json({ error: "not_found" }, 404);
			return await applyAction(
				c,
				action,
				input.data,
				attemptId,
				{
					groupId: enrollment.group_id,
					deviceId: enrollment.device_id,
					publicKey: enrollment.public_key,
					fingerprint: enrollment.fingerprint,
				},
				operations,
				deps,
			);
		} finally {
			await store?.close();
		}
	} catch {
		return unavailable(c);
	}
}

/** Explicit capability only; signed admission precedes account-change schema checks. */
export function registerCoordinatorDeviceAccountChangeRoutes(app: Hono, deps: Deps): void {
	if (!deps.config.enabled) return;
	const { coordinatorId, issuer, revision, enabled, redirectUri } = deps.config;
	const captured = {
		...deps,
		config: Object.freeze({ coordinatorId, issuer, revision, enabled, redirectUri }),
	};
	app.post("/v1/auth/account-changes", (c) => handle(c, "create", captured));
	app.post("/v1/auth/account-unlinks", (c) => handle(c, "unlink", captured));
	app.get("/v1/auth/account-changes", (c) => handle(c, "capabilities", captured));
	app.get("/v1/auth/account-changes/:attemptId", (c) => handle(c, "status", captured));
	app.post("/v1/auth/account-changes/:attemptId/finalize", (c) => handle(c, "finalize", captured));
	app.post("/v1/auth/account-changes/:attemptId/cancel", (c) => handle(c, "cancel", captured));
}
