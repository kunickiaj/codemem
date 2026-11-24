import {
	commitViewerDeviceRemoval,
	type MemoryStore,
	readCoordinatorSyncConfig,
	removePairingState,
	removeRevokedPeers,
	verifiedLocalKeyId,
} from "@codemem/core";
import { type Context, Hono } from "hono";
import { parseJsonObjectBody } from "../helpers.js";
import { originGuard } from "../middleware.js";
import { commitLocalRemoval, hasNoRemovalCoordinator } from "./device-removal-local.js";
import { lookupViewerRemoval, matchesViewerRemovalContext } from "./device-removal-lookup.js";
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
	getSignedLookupStore?: () => Pick<MemoryStore, "db" | "dbPath" | "deviceId">;
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
		if (body.mode === "local" || body.mode === "already_removed")
			return await commitLocal(c, options, body, deviceId, body.mode);
		const config = { ...readConfig() };
		if (!readDeviceRemovalCoordinator(() => config))
			return c.json({ error: "coordinator_admin_required" }, 409);
		const input = confirmedRequest(body, deviceId);
		if (!input) return c.json({ error: "invalid_input" }, 400);
		const refusal = await checkCoordinatorRemoval(c, options, deviceId, input.coordinatorOrigin);
		if (refusal) return refusal;
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

async function checkCoordinatorRemoval(
	c: Context,
	options: Options,
	deviceId: string,
	origin: string,
) {
	if (!options.getSignedLookupStore) return null;
	const readConfig = options.readCoordinatorConfig ?? readCoordinatorSyncConfig;
	const evidence = await lookupViewerRemoval(options.getSignedLookupStore(), deviceId, readConfig);
	if ("error" in evidence) return c.json({ error: evidence.error }, evidence.status);
	if (evidence.mode !== "coordinator" || evidence.context.config.syncCoordinatorUrl !== origin)
		return c.json({ error: "removal_preview_stale" }, 409);
	return null;
}

async function commitLocal(
	c: Context,
	options: Options,
	body: Record<string, unknown>,
	deviceId: string,
	mode: "local" | "already_removed",
) {
	const expectedDigest = body.expected_digest;
	if (
		Object.keys(body).length !== 2 ||
		typeof expectedDigest !== "string" ||
		!/^[a-f0-9]{64}$/u.test(expectedDigest)
	)
		return c.json({ error: "invalid_input" }, 400);
	const readConfig = options.readCoordinatorConfig;
	const applied =
		mode === "local" && hasNoRemovalCoordinator(readConfig)
			? commitLocalRemoval(options.getStore(), { deviceId, expectedDigest }, readConfig)
			: await cleanupFromSignedLookup(options, { deviceId, expectedDigest, mode });
	if (!applied) return c.json({ error: "removal_preview_stale" }, 409);
	return c.json({ state: "removed", mode });
}

async function cleanupFromSignedLookup(
	options: Options,
	input: { deviceId: string; expectedDigest: string; mode: "local" | "already_removed" },
) {
	const store = options.getSignedLookupStore?.();
	if (!store) return false;
	const { deviceId, expectedDigest, mode } = input;
	const readConfig = options.readCoordinatorConfig ?? readCoordinatorSyncConfig;
	const hooks = options.createDeviceRemovalRefreshHooks();
	try {
		await hooks.waitForRefresh();
		const evidence = await lookupViewerRemoval(store, deviceId, readConfig);
		if ("error" in evidence || evidence.mode !== mode || evidence.expectedDigest !== expectedDigest)
			return false;
		return store.db
			.transaction(() => {
				if (!matchesViewerRemovalContext(store, deviceId, readConfig, evidence.contextDigest))
					return false;
				if (evidence.revoked) removeRevokedPeers(store.db, store.deviceId, [deviceId]);
				else
					removePairingState(store.db, {
						localDeviceId: store.deviceId,
						deviceIds: [deviceId],
						reason: "local",
					});
				return true;
			})
			.immediate();
	} finally {
		// Release the reserved slot even if lookup or cleanup did not complete.
		await hooks.refresh().catch(() => {});
	}
}

export function deviceRemovalCommitRoutes(options: Options) {
	return new Hono().post("/api/sync/devices/:device_id/remove", originGuard(), (c) => {
		c.header("Cache-Control", "no-store");
		return commitRemove(c, options);
	});
}
