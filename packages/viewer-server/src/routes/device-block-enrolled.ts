import {
	commitViewerDeviceRemoval,
	coordinatorRevokeDeviceAction,
	type MemoryStore,
	readCoordinatorSyncConfig,
	verifiedLocalKeyId,
} from "@codemem/core";
import { type Context, Hono } from "hono";
import { parseJsonObjectBody } from "../helpers.js";
import { originGuard } from "../middleware.js";
import { commitViewerDeviceBlock } from "./device-block-action.js";
import type { DeviceRemovalRefreshHooksFactory } from "./device-removal-commit.js";
import { lookupViewerRemoval } from "./device-removal-lookup.js";
import { readDeviceRemovalCoordinator } from "./device-removal-review.js";

type Options = {
	getStore(): Pick<MemoryStore, "db" | "dbPath" | "deviceId">;
	readCoordinatorConfig?: typeof readCoordinatorSyncConfig;
	createDeviceRemovalRefreshHooks: DeviceRemovalRefreshHooksFactory;
};
const path = "/api/sync/devices/:device_id/block-enrolled";
const hash = /^[a-f0-9]{64}$/u;

function captureBlock(body: Record<string, unknown>, deviceId: string) {
	const {
		group_id: groupId,
		coordinator_id: coordinatorId,
		key_id: keyId,
		coordinator_origin: coordinatorOrigin,
		expected_digest: expectedDigest,
	} = body;
	if (
		Object.keys(body).length !== 5 ||
		typeof groupId !== "string" ||
		typeof coordinatorId !== "string" ||
		typeof coordinatorOrigin !== "string" ||
		typeof keyId !== "string" ||
		!hash.test(keyId) ||
		typeof expectedDigest !== "string" ||
		!hash.test(expectedDigest)
	)
		return null;
	return {
		deviceId,
		groupId,
		expectedContext: { coordinatorId, keyId },
		removal: { deviceIds: [deviceId], coordinatorOrigin, expectedDigest },
	};
}

async function previewEnrolledBlock(c: Context, options: Options) {
	c.header("Cache-Control", "no-store");
	const body = await parseJsonObjectBody(c, 4_096);
	if (body instanceof Response) return body;
	if (Object.keys(body).length !== 1 || typeof body.group_id !== "string")
		return c.json({ error: "invalid_input" }, 400);
	const readConfig = options.readCoordinatorConfig ?? readCoordinatorSyncConfig;
	try {
		const store = options.getStore();
		const deviceId = c.req.param("device_id") ?? "";
		const lookup = await lookupViewerRemoval(store, deviceId, readConfig);
		if ("error" in lookup) return c.json({ error: lookup.error }, lookup.status);
		if (lookup.mode !== "coordinator") return c.json({ error: "removal_preview_stale" }, 409);
		const remote = readDeviceRemovalCoordinator(() => lookup.context.config);
		if (!remote) return c.json({ error: "coordinator_admin_required" }, 409);
		const preview = await coordinatorRevokeDeviceAction({
			remoteUrl: remote.url,
			adminSecret: remote.adminSecret,
			timeoutS: remote.timeoutS,
			deviceId,
			groupId: body.group_id,
		});
		if (preview.state !== "ready") return c.json({ error: "device_block_unavailable" }, 503);
		if (preview.key_id === lookup.context.subject.localKeyId)
			return c.json({ error: "cannot_remove_this_device" }, 400);
		return c.json({ coordinator_id: preview.coordinator_id, key_id: preview.key_id });
	} catch {
		return c.json({ error: "device_block_unavailable" }, 503);
	}
}

async function runEnrolledBlock(c: Context, options: Options) {
	c.header("Cache-Control", "no-store");
	const body = await parseJsonObjectBody(c, 4_096);
	if (body instanceof Response) return body;
	const input = captureBlock(body, c.req.param("device_id") ?? "");
	if (!input) return c.json({ error: "invalid_input" }, 400);
	const readConfig = options.readCoordinatorConfig ?? readCoordinatorSyncConfig;
	try {
		const store = options.getStore();
		const readContext = () => ({
			coordinator: readDeviceRemovalCoordinator(readConfig),
			local: { deviceId: store.deviceId, keyId: verifiedLocalKeyId(store.db, store.deviceId) },
		});
		if (!readContext().coordinator) return c.json({ error: "coordinator_admin_required" }, 409);
		const lookup = await lookupViewerRemoval(store, input.deviceId, readConfig);
		if ("error" in lookup) return c.json({ error: lookup.error }, lookup.status);
		if (
			lookup.mode !== "coordinator" ||
			lookup.context.config.syncCoordinatorUrl !== input.removal.coordinatorOrigin
		)
			return c.json({ error: "removal_preview_stale" }, 409);
		const result = await commitViewerDeviceBlock(input, {
			readContext,
			revoke: coordinatorRevokeDeviceAction,
			remove: (reviewed) =>
				commitViewerDeviceRemoval(reviewed, {
					db: store.db,
					readContext,
					...options.createDeviceRemovalRefreshHooks(),
					expectedEnrollment: { groupId: input.groupId, keyId: input.expectedContext.keyId },
				}),
		});
		if ("removal" in result)
			return c.json({ state: result.kind, removal_id: result.removal.evidence.removalId });
		return c.json({ state: result.kind, error: result.error });
	} catch {
		return c.json({ error: "device_block_unavailable" }, 503);
	}
}

export function enrolledDeviceBlockRoutes(options: Options) {
	return new Hono()
		.post(`${path}/preview`, originGuard(), (c) => previewEnrolledBlock(c, options))
		.post(path, originGuard(), (c) => runEnrolledBlock(c, options));
}
