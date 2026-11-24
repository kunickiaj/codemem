import {
	coordinatorListRemovedDevicesAction,
	type MemoryStore,
	normalizeCoordinatorAccountLinkOrigin,
	RemoteCoordinatorRequestError,
	readCoordinatorSyncConfig,
	requestJson,
} from "@codemem/core";
import { type Context, Hono } from "hono";
import { originGuard } from "../middleware.js";
import { hasNoRemovalCoordinator, readLocalRemoval } from "./device-removal-local.js";
import { lookupViewerRemoval } from "./device-removal-lookup.js";

const LIST_PATH = "/api/sync/devices/removals";
const DIGEST = /^[a-f0-9]{64}$/u;

export function readDeviceRemovalCoordinator(readConfig: typeof readCoordinatorSyncConfig) {
	const config = readConfig();
	const url = normalizeCoordinatorAccountLinkOrigin(config.syncCoordinatorUrl);
	const adminSecret = config.syncCoordinatorAdminSecret;
	if (!url || !adminSecret.trim()) return null;
	return { url, adminSecret, timeoutS: config.syncCoordinatorTimeoutS };
}

function coordinatorReadFailure(c: Context, error: unknown) {
	if (error instanceof RemoteCoordinatorRequestError && error.status === 404)
		return c.json({ error: "coordinator_update_required" }, 503);
	return c.json({ error: "device_removal_unavailable" }, 503);
}

async function listRemovals(c: Context, options: Options) {
	try {
		const remote = readDeviceRemovalCoordinator(
			options.readCoordinatorConfig ?? readCoordinatorSyncConfig,
		);
		if (!remote) return c.json({ error: "coordinator_admin_required" }, 409);
		const rows = await coordinatorListRemovedDevicesAction({ remote });
		const items = rows.map(({ device_id, group_id, display_name, removal_seq, removal_id }) => ({
			device_id,
			group_id,
			display_name,
			removal_seq,
			...(options.getSignedLookupStore ? { removal_id } : {}),
		}));
		return c.json({ items });
	} catch (error) {
		return coordinatorReadFailure(c, error);
	}
}

function reviewPreview(
	c: Context,
	payload: Record<string, unknown> | null,
	ids: {
		deviceId: string;
		localId: string;
		localKeyId: string;
		coordinatorOrigin: string;
	},
) {
	if (
		payload?.state !== "ready" ||
		payload.version !== 1 ||
		!Array.isArray(payload.device_ids) ||
		payload.device_ids.length !== 1 ||
		payload.device_ids[0] !== ids.deviceId
	)
		return coordinatorReadFailure(c, null);
	const { rejoin, expected_digest, key_id, enrollments } = payload;
	if (
		(rejoin !== "invitation" && rejoin !== "sign_in" && rejoin !== "none") ||
		typeof expected_digest !== "string" ||
		!DIGEST.test(expected_digest) ||
		(key_id !== null && (typeof key_id !== "string" || !DIGEST.test(key_id))) ||
		!Array.isArray(enrollments) ||
		enrollments.length === 0 ||
		enrollments.length > 50
	)
		return coordinatorReadFailure(c, null);
	if (key_id === ids.localKeyId) return c.json({ error: "cannot_remove_this_device" }, 400);
	for (const row of enrollments) {
		if (!row || typeof row.device_id !== "string") return coordinatorReadFailure(c, null);
		if (row.device_id === ids.localId) return c.json({ error: "cannot_remove_this_device" }, 400);
	}
	const groupId = enrollments.find(
		(row) => row.device_id === ids.deviceId && typeof row.group_id === "string",
	)?.group_id;
	return c.json({
		device_id: ids.deviceId,
		rejoin,
		expected_digest,
		key_id,
		coordinator_origin: ids.coordinatorOrigin,
		...(groupId ? { group_id: groupId } : {}),
	});
}

interface Options {
	readCoordinatorConfig?: typeof readCoordinatorSyncConfig;
	localIdentity: () => { deviceId: string; keyId: string | null };
	getLocalStore?: () => Pick<MemoryStore, "db" | "deviceId">;
	getSignedLookupStore?: () => Pick<MemoryStore, "db" | "dbPath" | "deviceId">;
}

function previewLocalRemoval(c: Context, options: Options, deviceId: string) {
	if (!options.getLocalStore || !hasNoRemovalCoordinator(options.readCoordinatorConfig))
		return null;
	const local = readLocalRemoval(options.getLocalStore(), deviceId);
	if ("error" in local) return c.json({ error: local.error }, local.status);
	return c.json(local);
}

async function previewRemoval(c: Context, options: Options) {
	const deviceId = c.req.param("device_id") ?? "";
	if (
		!deviceId ||
		deviceId !== deviceId.trim() ||
		deviceId.length > 256 ||
		/[\p{Cc}\p{Cf}\p{Cs}]/u.test(deviceId)
	)
		return c.json({ error: "invalid_input" }, 400);
	try {
		const local = previewLocalRemoval(c, options, deviceId);
		if (local) return local;
		return await previewConfiguredRemoval(c, options, deviceId);
	} catch (error) {
		return coordinatorReadFailure(c, error);
	}
}

async function previewConfiguredRemoval(c: Context, options: Options, deviceId: string) {
	const readConfig = options.readCoordinatorConfig ?? readCoordinatorSyncConfig;
	let config = readConfig();
	if (options.getSignedLookupStore) {
		const evidence = await lookupViewerRemoval(
			options.getSignedLookupStore(),
			deviceId,
			readConfig,
		);
		if ("error" in evidence) return c.json({ error: evidence.error }, evidence.status);
		if (evidence.mode !== "coordinator")
			return c.json({
				mode: evidence.mode,
				device_id: deviceId,
				expected_digest: evidence.expectedDigest,
			});
		config = evidence.context.config;
	}
	const { deviceId: localId, keyId: localKeyId } = options.localIdentity();
	if (localId === deviceId) return c.json({ error: "cannot_remove_this_device" }, 400);
	if (!localKeyId) return c.json({ error: "local_identity_unverified" }, 409);
	const remote = readDeviceRemovalCoordinator(() => config);
	if (!remote) return c.json({ error: "coordinator_admin_required" }, 409);
	const [status, payload] = await requestJson(
		"POST",
		`${remote.url}/v1/admin/devices/removal-preview`,
		{
			body: { device_ids: [deviceId] },
			headers: { "X-Codemem-Coordinator-Admin": remote.adminSecret },
			timeoutS: remote.timeoutS,
			maxResponseBytes: 128_000,
		},
	);
	if (status === 200)
		return reviewPreview(c, payload, {
			deviceId,
			localId,
			localKeyId,
			coordinatorOrigin: remote.url,
		});
	if (status === 404 && payload?.error === "removal_target_not_enrolled")
		return c.json({ error: "removal_target_not_enrolled" }, 404);
	if (status === 404) return c.json({ error: "coordinator_update_required" }, 503);
	if (status === 409) return c.json({ error: "removal_target_unavailable" }, 409);
	return coordinatorReadFailure(c, null);
}

/** Read-only coordinator evidence. No removal or local pairing mutation is mounted here. */
export function deviceRemovalReviewRoutes(options: Options) {
	return new Hono()
		.use(LIST_PATH, originGuard({ unsafeGetPathPrefixes: [LIST_PATH] }))
		.get(LIST_PATH, (c) => {
			c.header("Cache-Control", "no-store");
			return listRemovals(c, options);
		})
		.post("/api/sync/devices/:device_id/remove/preview", (c) => {
			c.header("Cache-Control", "no-store");
			return previewRemoval(c, options);
		});
}
