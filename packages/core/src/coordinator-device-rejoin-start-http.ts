import type { Context } from "hono";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { CoordinatorBrowserAuthClientKey } from "./coordinator-browser-auth-app.js";
import type { DeviceAuthLinkDeps } from "./coordinator-device-auth-link.js";
import {
	DEVICE_REJOIN_MAX_BODY_BYTES,
	parseDeviceRejoinStartBody,
} from "./coordinator-device-rejoin-start-input.js";
import { prepareVerifiedRejoinStart } from "./coordinator-device-rejoin-start-write.js";
import { hasDeviceRemovalSchema } from "./coordinator-device-removal.js";

type Deps = Pick<
	DeviceAuthLinkDeps,
	"config" | "readRequestBytes" | "rateLimitedResponse" | "storeFactory"
> & {
	/** Verified connection address from the platform. Never a client-selected header. */
	clientAddress: CoordinatorBrowserAuthClientKey;
};

export const DEVICE_REJOIN_START_PATH = "/v1/auth/rejoin-attempts";

function unavailable(c: Context) {
	return c.json({ error: "device_rejoin_unavailable" }, 403);
}

async function handle(c: Context, deps: Deps, origin: string): Promise<Response> {
	c.header("Cache-Control", "no-store");
	c.header("Referrer-Policy", "no-referrer");
	if (!deps.config.enabled) return c.json({ error: "not_found" }, 404);
	if (!isAuthControllerId(deps.config.coordinatorId)) return unavailable(c);
	const address = deps.clientAddress(c);
	if (!isAuthControllerId(address) || address.length > 128) return unavailable(c);
	const prefix = ["device-rejoin:start", deps.config.coordinatorId, address];
	const anonymous = deps.rateLimitedResponse(c, JSON.stringify(prefix), { authenticated: false });
	if (anonymous) return anonymous;
	const url = new URL(c.req.url);
	if (url.origin !== origin) return unavailable(c);
	if (url.search) return c.json({ error: "device_rejoin_invalid_input" }, 400);
	const raw = await deps.readRequestBytes(c, DEVICE_REJOIN_MAX_BODY_BYTES);
	if (!raw) return c.json({ error: "body_too_large" }, 413);
	const parsed = parseDeviceRejoinStartBody(raw);
	if (!parsed.ok)
		return c.json({ error: parsed.error }, parsed.error === "body_too_large" ? 413 : 400);
	return admit(c, deps, origin, prefix, parsed.input);
}

async function admit(
	c: Context,
	deps: Deps,
	origin: string,
	ratePrefix: string[],
	input: Extract<ReturnType<typeof parseDeviceRejoinStartBody>, { ok: true }>["input"],
): Promise<Response> {
	const store = deps.storeFactory();
	try {
		const backend = await store.readDeviceRejoinBackend?.();
		if (!backend || !(await hasDeviceRemovalSchema(backend)))
			return c.json({ error: "not_found" }, 404);
		const prepared = await prepareVerifiedRejoinStart(
			backend,
			{
				coordinatorId: deps.config.coordinatorId,
				origin,
				issuer: deps.config.issuer,
				authConfigRevision: deps.config.revision,
			},
			input,
			Date.now(),
		);
		if (!prepared) return unavailable(c);
		const deviceRate = deps.rateLimitedResponse(
			c,
			JSON.stringify([...ratePrefix, prepared.deviceId]),
			{ authenticated: true },
		);
		if (deviceRate) return deviceRate;
		const result = await prepared.insert(Date.now);
		if (result.kind === "started" || result.kind === "prior_start") return c.json(result.body);
		if (result.kind === "retry")
			return c.json({ error: "device_rejoin_refused", reason: "retry" }, 409);
		return unavailable(c);
	} finally {
		await store.close();
	}
}

/** Start uses the verified platform address and the removed device's purpose-specific proof. */
export function createDeviceRejoinStartHandler(deps: Deps): (c: Context) => Promise<Response> {
	const origin = new URL(deps.config.redirectUri).origin;
	return async (c) => {
		try {
			return await handle(c, deps, origin);
		} catch {
			return c.json({ error: "device_rejoin_unknown" }, 503);
		}
	};
}
