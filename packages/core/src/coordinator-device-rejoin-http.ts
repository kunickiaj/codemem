import type { Context, Hono } from "hono";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import { decodeCoordinatorAuthProof32 } from "./coordinator-auth-proof.js";
import type { CoordinatorBrowserAuthClientKey } from "./coordinator-browser-auth-app.js";
import type { DeviceAuthLinkDeps } from "./coordinator-device-auth-link.js";
import {
	type DeviceRejoinFinalizeInput,
	type DeviceRejoinFinalizeResult,
	finalizeDeviceRejoin,
} from "./coordinator-device-rejoin-finalize.js";
import { hasDeviceRemovalSchema } from "./coordinator-device-removal.js";

export const DEVICE_REJOIN_FINALIZE_PATH = "/v1/auth/rejoin-attempts/:attemptId/finalize";
const MAX_BYTES = 4096;
type Deps = Pick<
	DeviceAuthLinkDeps,
	"config" | "readRequestBytes" | "rateLimitedResponse" | "storeFactory"
> & { clientKey: CoordinatorBrowserAuthClientKey };

function finalizeInput(raw: Uint8Array, attemptId: string): DeviceRejoinFinalizeInput | null {
	if (!isAuthControllerId(attemptId)) return null;
	try {
		const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
		if (!data || typeof data !== "object" || Array.isArray(data)) return null;
		const fields = ["device_id", "completion", "signature"];
		if (Object.keys(data).length !== fields.length || !fields.every((f) => Object.hasOwn(data, f)))
			return null;
		const { device_id: deviceId, completion, signature } = data as Record<string, unknown>;
		if (
			!isAuthControllerId(deviceId) ||
			typeof completion !== "string" ||
			!decodeCoordinatorAuthProof32(completion) ||
			typeof signature !== "string"
		)
			return null;
		return { attemptId, deviceId, completion, signature };
	} catch {
		return null;
	}
}

function respond(c: Context, result: DeviceRejoinFinalizeResult) {
	switch (result.kind) {
		case "unavailable":
			return c.json({ error: "device_rejoin_unavailable" }, 403);
		case "refused":
			return c.json(
				{ error: "device_rejoin_refused", reason: result.reason },
				result.reason === "retry" ? 409 : 403,
			);
		default:
			return c.json({ state: result.kind, receipt: result.receipt });
	}
}

async function handleFinalize(c: Context, deps: Deps, origin: string) {
	c.header("Cache-Control", "no-store");
	c.header("Referrer-Policy", "no-referrer");
	const client = deps.clientKey(c);
	if (!isAuthControllerId(client) || client.length > 128)
		return respond(c, { kind: "unavailable" });
	const rateKey = JSON.stringify(["device-rejoin:finalize", deps.config.coordinatorId, client]);
	const limit = deps.rateLimitedResponse(c, rateKey, { authenticated: false });
	if (limit) return limit;
	const url = new URL(c.req.url);
	if (url.origin !== origin) return respond(c, { kind: "unavailable" });
	if (url.search) return c.json({ error: "device_rejoin_invalid_input" }, 400);
	const raw = await deps.readRequestBytes(c, MAX_BYTES);
	if (!raw) return c.json({ error: "body_too_large" }, 413);
	const input = finalizeInput(raw, c.req.param("attemptId") ?? "");
	if (!input) return c.json({ error: "device_rejoin_invalid_input" }, 400);
	const store = deps.storeFactory();
	try {
		const backend = await store.readDeviceRejoinBackend?.();
		if (!backend || !(await hasDeviceRemovalSchema(backend)))
			return c.json({ error: "not_found" }, 404);
		return respond(
			c,
			await finalizeDeviceRejoin(
				backend,
				{
					coordinatorId: deps.config.coordinatorId,
					origin,
					issuer: deps.config.issuer,
					authConfigRevision: deps.config.revision,
					now: Date.now(),
				},
				input,
			),
		);
	} finally {
		await store.close();
	}
}

/** This route uses the removed device's purpose-specific proof, never enrolled-device admission. */
export function registerCoordinatorDeviceRejoinFinalizeRoute(app: Hono, deps: Deps): void {
	if (!deps.config.enabled || !isAuthControllerId(deps.config.coordinatorId)) return;
	const origin = new URL(deps.config.redirectUri).origin;
	app.post(DEVICE_REJOIN_FINALIZE_PATH, async (c) => {
		try {
			return await handleFinalize(c, deps, origin);
		} catch {
			return c.json({ error: "device_rejoin_unknown" }, 503);
		}
	});
}
