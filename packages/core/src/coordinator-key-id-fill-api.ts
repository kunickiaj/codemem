import type { Context, Hono } from "hono";
import type { DeviceAuthLinkDeps } from "./coordinator-device-auth-link.js";
import type { CoordinatorFillEnrollmentKeyIdsOptions } from "./coordinator-device-removal.js";
import type { CoordinatorStore } from "./coordinator-store-contract.js";

interface KeyIdFillRouteDeps
	extends Pick<DeviceAuthLinkDeps, "readRequestBytes" | "parseJsonObject" | "rateLimitedResponse"> {
	storeFactory(): CoordinatorStore;
	authorizeAdmin(secret: string | undefined): { ok: true } | { ok: false; error: string };
}

export function registerCoordinatorKeyIdFillRoute(app: Hono, deps: KeyIdFillRouteDeps): void {
	app.post("/v1/admin/devices/key-id-fill", async (c) => {
		const auth = deps.authorizeAdmin(c.req.header("X-Codemem-Coordinator-Admin"));
		if (!auth.ok)
			return (
				deps.rateLimitedResponse(c, c.req.path, { authenticated: false }) ??
				c.json({ error: auth.error }, 401)
			);
		const limited = deps.rateLimitedResponse(c, "admin", { authenticated: true });
		if (limited) return limited;
		const raw = await deps.readRequestBytes(c, 4096);
		if (raw == null) return c.json({ error: "body_too_large" }, 413);
		const data = deps.parseJsonObject(raw);
		if (!data) return c.json({ error: "invalid_json" }, 400);
		const options = parseKeyIdFillOptions(data);
		if (!options) return c.json({ error: "invalid_input" }, 400);
		return fillAdminEnrollmentKeyIds(c, deps.storeFactory(), options);
	});
}

export function parseKeyIdFillOptions(
	data: Record<string, unknown>,
): CoordinatorFillEnrollmentKeyIdsOptions | null {
	if (Object.keys(data).some((key) => key !== "limit" && key !== "after")) return null;
	const { limit, after } = data;
	if (limit !== undefined && (!Number.isSafeInteger(limit) || (limit as number) < 1)) return null;
	if (
		after !== undefined &&
		after !== null &&
		(!Number.isSafeInteger(after) || (after as number) < 0)
	)
		return null;
	return { limit: limit as number | undefined, after: after as number | null | undefined };
}

/** One page per request keeps the upgrade within D1's per-request query budget. */
export async function fillAdminEnrollmentKeyIds(
	c: Context,
	store: CoordinatorStore,
	options: CoordinatorFillEnrollmentKeyIdsOptions,
): Promise<Response> {
	try {
		const result = await store.fillEnrollmentKeyIds(options);
		return c.json({ version: 1, ...result });
	} catch (error) {
		if (error instanceof Error && error.message === "device_removal_unavailable")
			return c.json({ error: "device_removal_unavailable" }, 503);
		return c.json({ error: "device_removal_incomplete" }, 500);
	} finally {
		await store.close();
	}
}
