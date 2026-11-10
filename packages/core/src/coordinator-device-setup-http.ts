/** Same-Identity completion derives authority from a committed own-device claim. */
import type { Context, Hono } from "hono";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import {
	type DeviceAuthLinkDeps,
	exactStrings,
	runSignedDeviceRequest,
} from "./coordinator-device-auth-link.js";
import {
	completeDeviceClaimBinding,
	readDeviceClaimBindingReadiness,
} from "./coordinator-device-claim-binding.js";
import { readDeviceSelfBindEligibility } from "./coordinator-device-self-bind-authority.js";

export const DEVICE_BINDING_PATH = "/v1/auth/device-binding";
const fields = ["group_id", "identity_id"] as const;
const invalid = (c: Context) => c.json({ error: "device_binding_invalid_input" }, 400);

async function readInput(c: Context, deps: DeviceAuthLinkDeps) {
	const url = new URL(c.req.url);
	if (url.origin !== new URL(deps.config.redirectUri).origin)
		return c.json({ error: "device_binding_unavailable" }, 403);
	if (c.req.method === "GET") {
		const entries = [...url.searchParams.entries()];
		if (c.req.raw.body !== null || entries.length !== fields.length) return invalid(c);
		const data = Object.fromEntries(entries);
		return exactStrings(data, fields) ? { data, raw: new Uint8Array() } : invalid(c);
	}
	if (
		url.search ||
		c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
	)
		return invalid(c);
	const raw = await deps.readRequestBytes(c, 4096);
	if (!raw) return c.json({ error: "body_too_large" }, 413);
	const data = deps.parseJsonObject(raw);
	return exactStrings(data, fields) ? { data, raw } : invalid(c);
}

function handle(c: Context, deps: DeviceAuthLinkDeps, now: () => number): Promise<Response> {
	c.header("Referrer-Policy", "no-referrer");
	if (c.req.method !== "GET" && c.req.method !== "POST") {
		c.header("Cache-Control", "no-store");
		return Promise.resolve(c.json({ error: "method_not_allowed" }, 405, { Allow: "GET, POST" }));
	}
	return runSignedDeviceRequest(c, deps, {
		label: "device_binding",
		read: async () => {
			const input = await readInput(c, deps);
			if (input instanceof Response) return input;
			if (!fields.every((key) => isAuthControllerId(input.data[key]))) return invalid(c);
			return { ...input, attemptId: "" };
		},
		apply: async (store, signer, input) => {
			const backend = await store.readDeviceRebindBackend?.();
			if (!backend) return c.json({ error: "not_found" }, 404);
			const bindingInput = { signer, currentIdentityId: String(input.data.identity_id) };
			const at = now();
			const operation =
				c.req.method === "GET" ? readDeviceClaimBindingReadiness : completeDeviceClaimBinding;
			const result = await operation(backend, bindingInput, deps.config, at);
			if (result.kind === "complete" || result.kind === "completed")
				return c.json({ kind: "complete" });
			if (c.req.method === "GET" && result.kind === "requires_review") {
				const eligibility = await readDeviceSelfBindEligibility(
					backend,
					bindingInput,
					deps.config,
					at,
				);
				if (
					eligibility.kind === "eligible" &&
					eligibility.identityId === bindingInput.currentIdentityId
				)
					return c.json({ kind: "connect_required" });
			}
			return c.json({ kind: result.kind });
		},
	});
}

/** Uses the maintained signed admission, including nonce/revocation checks. */
export function registerCoordinatorDeviceSetupRoutes(
	app: Hono,
	deps: DeviceAuthLinkDeps & { now?: () => number },
): void {
	if (!deps.config.enabled) return;
	const { coordinatorId, issuer, revision, enabled, redirectUri } = deps.config;
	const captured: DeviceAuthLinkDeps = {
		config: Object.freeze({ coordinatorId, issuer, revision, enabled, redirectUri }),
		storeFactory: deps.storeFactory,
		authorizeRequest: deps.authorizeRequest,
		authErrorStatus: deps.authErrorStatus,
		readRequestBytes: deps.readRequestBytes,
		parseJsonObject: deps.parseJsonObject,
		rateLimitedResponse: deps.rateLimitedResponse,
	};
	const now = deps.now ?? (() => Date.now());
	app.get(DEVICE_BINDING_PATH, (c) => handle(c, captured, now));
	app.post(DEVICE_BINDING_PATH, (c) => handle(c, captured, now));
}
