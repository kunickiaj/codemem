import type { Context, Hono } from "hono";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { DeviceAuthLinkDeps } from "./coordinator-device-auth-link.js";
import type { CoordinatorListDeviceRemovalsInput } from "./coordinator-device-removal-list.js";
import type { CoordinatorStore } from "./coordinator-store-contract.js";

interface DeviceRemovalRouteDeps extends Pick<DeviceAuthLinkDeps, "rateLimitedResponse"> {
	storeFactory(): CoordinatorStore;
	authorizeAdmin(secret: string | undefined): { ok: boolean; error: string };
}

function parseRemovalListQuery(query: URLSearchParams): CoordinatorListDeviceRemovalsInput | null {
	const options: CoordinatorListDeviceRemovalsInput = {};
	const seen = new Set<string>();
	for (const [name, value] of query) {
		if (seen.has(name)) return null;
		seen.add(name);
		switch (name) {
			case "before_seq": {
				const beforeSeq = Number(value);
				if (!/^-?\d+$/u.test(value) || !Number.isSafeInteger(beforeSeq)) return null;
				options.beforeSeq = beforeSeq;
				break;
			}
			case "device_id":
				if (!isAuthControllerId(value)) return null;
				options.deviceId = value;
				break;
			case "include_blocked":
				if (value !== "1") return null;
				options.includeBlocked = true;
				break;
			default:
				return null;
		}
	}
	return options;
}

async function listDeviceRemovals(
	c: Context,
	store: CoordinatorStore,
	options: CoordinatorListDeviceRemovalsInput,
): Promise<Response> {
	try {
		const { items, next_before_seq } = await store.listDeviceRemovals(options);
		return c.json({ version: 1, items, next_before_seq });
	} catch (error) {
		if (error instanceof Error && error.message === "device_removal_unavailable")
			return c.json({ error: "device_removal_unavailable" }, 503);
		throw error;
	} finally {
		await store.close();
	}
}

export function registerCoordinatorDeviceRemovalRoutes(app: Hono, deps: DeviceRemovalRouteDeps) {
	app.get("/v1/admin/devices/removals", async (c) => {
		const auth = deps.authorizeAdmin(c.req.header("X-Codemem-Coordinator-Admin"));
		if (!auth.ok)
			return (
				deps.rateLimitedResponse(c, c.req.path, { authenticated: false }) ??
				c.json({ error: auth.error }, 401)
			);
		const limited = deps.rateLimitedResponse(c, "admin", { authenticated: true });
		if (limited) return limited;
		const options = parseRemovalListQuery(new URL(c.req.url).searchParams);
		if (!options) return c.json({ error: "invalid_input" }, 400);
		return listDeviceRemovals(c, deps.storeFactory(), options);
	});
}
