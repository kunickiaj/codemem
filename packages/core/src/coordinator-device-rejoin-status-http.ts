import type { Context } from "hono";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { CoordinatorBrowserAuthClientKey } from "./coordinator-browser-auth-app.js";
import type {
	CoordinatorDeviceAuthLinkStore,
	DeviceAuthLinkDeps,
} from "./coordinator-device-auth-link.js";
import {
	DEVICE_REJOIN_STATUS_MAX_BODY_BYTES,
	type DeviceRejoinStatusInput,
	type DeviceRejoinStatusScope,
	parseDeviceRejoinStatusBody,
} from "./coordinator-device-rejoin-status.js";
import { readLiveDeviceRejoinStatus } from "./coordinator-device-rejoin-status-projection.js";
import { hasDeviceRemovalSchema } from "./coordinator-device-removal.js";

export type DeviceRejoinStatusHttpDeps = Pick<
	DeviceAuthLinkDeps,
	"config" | "readRequestBytes" | "rateLimitedResponse"
> & {
	clientKey: CoordinatorBrowserAuthClientKey;
	storeFactory: () => Pick<CoordinatorDeviceAuthLinkStore, "readDeviceRejoinBackend" | "close">;
};
export const DEVICE_REJOIN_STATUS_PATH = "/v1/auth/rejoin-attempts/:attemptId/status";

function unavailable(c: Context) {
	return c.json({ error: "device_rejoin_unavailable" }, 403);
}

async function handle(c: Context, deps: DeviceRejoinStatusHttpDeps): Promise<Response> {
	const { config } = deps;
	if (!config.enabled || !isAuthControllerId(config.coordinatorId)) return unavailable(c);
	const client = deps.clientKey(c);
	if (!isAuthControllerId(client) || client.length > 128) return unavailable(c);
	const rateKey = JSON.stringify(["device-rejoin:status", config.coordinatorId, client]);
	const limited = deps.rateLimitedResponse(c, rateKey, { authenticated: false });
	if (limited) return limited;
	const origin = new URL(config.redirectUri).origin;
	const url = new URL(c.req.url);
	if (url.origin !== origin) return unavailable(c);
	if (url.search) return c.json({ error: "device_rejoin_invalid_input" }, 400);
	const raw = await deps.readRequestBytes(c, DEVICE_REJOIN_STATUS_MAX_BODY_BYTES);
	if (!raw) return c.json({ error: "body_too_large" }, 413);
	const parsed = parseDeviceRejoinStatusBody(raw);
	if (!parsed.ok)
		return c.json({ error: parsed.error }, parsed.error === "body_too_large" ? 413 : 400);
	const attemptId = c.req.param("attemptId") ?? "";
	if (!isAuthControllerId(attemptId)) return c.json({ error: "device_rejoin_invalid_input" }, 400);
	return readStatus(
		c,
		deps,
		{
			coordinatorId: config.coordinatorId,
			attemptId,
			origin,
			issuer: config.issuer,
			authConfigRevision: config.revision,
			now: Date.now(),
		},
		parsed.input,
	);
}

async function readStatus(
	c: Context,
	deps: DeviceRejoinStatusHttpDeps,
	scope: DeviceRejoinStatusScope,
	input: DeviceRejoinStatusInput,
): Promise<Response> {
	const store = deps.storeFactory();
	try {
		const backend = await store.readDeviceRejoinBackend?.();
		if (!backend || !(await hasDeviceRemovalSchema(backend)))
			return c.json({ error: "not_found" }, 404);
		const result = await readLiveDeviceRejoinStatus(backend, scope, input);
		if (result.kind !== "live") return unavailable(c);
		return c.json(result.body);
	} finally {
		await store.close();
	}
}

export function createDeviceRejoinStatusHandler(deps: DeviceRejoinStatusHttpDeps) {
	return async (c: Context): Promise<Response> => {
		c.header("Cache-Control", "no-store");
		c.header("Referrer-Policy", "no-referrer");
		try {
			return await handle(c, deps);
		} catch {
			return c.json({ error: "device_rejoin_unknown" }, 503);
		}
	};
}
