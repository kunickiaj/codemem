import {
	commitViewerDeviceRemoval,
	type MemoryStore,
	readCoordinatorSyncConfig,
	verifiedLocalKeyId,
} from "@codemem/core";
import { type Context, Hono } from "hono";
import { parseJsonObjectBody } from "../helpers.js";
import { originGuard } from "../middleware.js";
import { commitLocalRemoval, hasNoRemovalCoordinator } from "./device-removal-local.js";
import { readDeviceRemovalCoordinator } from "./device-removal-review.js";
import { listAllEnrollments } from "./device-rename.js";

export type DeviceRemovalRefreshHooksFactory = () => {
	waitForRefresh(): Promise<void>;
	refresh(): Promise<void>;
};

interface Options {
	getStore(): Pick<MemoryStore, "db" | "deviceId">;
	readCoordinatorConfig?: typeof readCoordinatorSyncConfig;
	createDeviceRemovalRefreshHooks: DeviceRemovalRefreshHooksFactory;
}

const REFUSAL_STATUS = {
	invalid_input: 400,
	cannot_remove_this_device: 400,
	coordinator_admin_required: 409,
	local_identity_unverified: 409,
	removal_preview_stale: 409,
	coordinator_update_required: 503,
	device_removal_unavailable: 503,
} as const;

function confirmedRequest(body: Record<string, unknown>, deviceId: string) {
	const { coordinator_origin: coordinatorOrigin, expected_digest: expectedDigest } = body;
	if (
		Object.keys(body).length !== 2 ||
		typeof coordinatorOrigin !== "string" ||
		typeof expectedDigest !== "string"
	)
		return null;
	return { deviceIds: [deviceId], expectedDigest, coordinatorOrigin };
}

async function readRemovalProgress(
	config: ReturnType<typeof readCoordinatorSyncConfig>,
	readConfig: typeof readCoordinatorSyncConfig,
	removalSeq: number,
) {
	try {
		const current = readConfig();
		if (
			current.syncCoordinatorUrl !== config.syncCoordinatorUrl ||
			current.syncCoordinatorAdminSecret !== config.syncCoordinatorAdminSecret
		)
			return null;
		const rows = await listAllEnrollments(config);
		return rows.map(({ device_id, group_id, display_name, presence_capabilities }) => {
			const sequence = presence_capabilities?.applied_removal_seq;
			let state: "older" | "pending" | "applied" = "older";
			if (typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence >= 0)
				state = sequence >= removalSeq ? "applied" : "pending";
			// Last advertised progress still applies when presence has expired.
			return { device_id, group_id, display_name, state };
		});
	} catch {
		// A failed progress read cannot turn a confirmed removal into an error.
		return null;
	}
}

async function commitRemove(c: Context, options: Options) {
	const readConfig = options.readCoordinatorConfig ?? readCoordinatorSyncConfig;
	try {
		const body = await parseJsonObjectBody(c, 8_192);
		if (body instanceof Response) return body;
		const deviceId = c.req.param("device_id") ?? "";
		if (body.mode === "local") return commitLocal(c, options, body, deviceId);
		const config = { ...readConfig() };
		if (!readDeviceRemovalCoordinator(() => config))
			return c.json({ error: "coordinator_admin_required" }, 409);
		const input = confirmedRequest(body, deviceId);
		if (!input) return c.json({ error: "invalid_input" }, 400);
		const store = options.getStore();
		const result = await commitViewerDeviceRemoval(input, {
			db: store.db,
			readContext: () => {
				const deviceId = store.deviceId;
				return {
					coordinator: readDeviceRemovalCoordinator(readConfig),
					local: { deviceId, keyId: verifiedLocalKeyId(store.db, deviceId) },
				};
			},
			...options.createDeviceRemovalRefreshHooks(),
		});
		if (result.kind === "rejected")
			return c.json({ error: result.error }, REFUSAL_STATUS[result.error]);
		if (result.kind === "unknown") return c.json({ error: result.error }, 502);
		return c.json({
			state: "removed",
			removal_id: result.evidence.removalId,
			removal_seq: result.evidence.removalSeq,
			evidence: result.evidence.source,
			local_cleanup: result.localCleanup.state,
			refresh_pending: result.refreshPending,
			progress: await readRemovalProgress(config, readConfig, result.evidence.removalSeq),
		});
	} catch {
		return c.json({ error: "device_removal_unavailable" }, 503);
	}
}

function commitLocal(
	c: Context,
	options: Options,
	body: Record<string, unknown>,
	deviceId: string,
) {
	const expectedDigest = body.expected_digest;
	if (
		Object.keys(body).length !== 2 ||
		typeof expectedDigest !== "string" ||
		!/^[a-f0-9]{64}$/u.test(expectedDigest)
	)
		return c.json({ error: "invalid_input" }, 400);
	const readConfig = options.readCoordinatorConfig;
	if (!hasNoRemovalCoordinator(readConfig)) return c.json({ error: "removal_preview_stale" }, 409);
	const applied = commitLocalRemoval(options.getStore(), { deviceId, expectedDigest }, readConfig);
	if (!applied) return c.json({ error: "removal_preview_stale" }, 409);
	return c.json({ state: "removed", mode: "local" });
}

/** Unmounted until Devices and the real refresh lifecycle can use the complete flow. */
export function deviceRemovalCommitRoutes(options: Options) {
	return new Hono().post("/api/sync/devices/:device_id/remove", originGuard(), (c) => {
		c.header("Cache-Control", "no-store");
		return commitRemove(c, options);
	});
}
