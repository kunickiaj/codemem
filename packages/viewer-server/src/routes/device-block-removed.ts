import {
	coordinatorRevokeDeviceAction,
	type MemoryStore,
	RemoteCoordinatorRequestError,
	readCoordinatorSyncConfig,
	verifiedLocalKeyId,
} from "@codemem/core";
import { type Context, Hono } from "hono";
import { parseJsonObjectBody } from "../helpers.js";
import { originGuard } from "../middleware.js";
import { readDeviceRemovalCoordinator } from "./device-removal-review.js";

type Options = {
	getStore(): Pick<MemoryStore, "db" | "deviceId">;
	readCoordinatorConfig?: typeof readCoordinatorSyncConfig;
};
type BlockPhase = "preview" | "commit";
const path = "/api/sync/devices/:device_id/block";

function blockTarget(c: Context, body: Record<string, unknown>, phase: BlockPhase) {
	const deviceId = c.req.param("device_id") ?? "";
	const {
		group_id: groupId,
		removal_id: requiredRemovalId,
		expected_digest: expectedDigest,
	} = body;
	if (typeof groupId !== "string" || typeof requiredRemovalId !== "string") return null;
	if (phase === "preview" && Object.keys(body).length === 2)
		return { deviceId, groupId, requiredRemovalId };
	if (
		phase === "commit" &&
		Object.keys(body).length === 3 &&
		typeof expectedDigest === "string" &&
		/^[a-f0-9]{64}$/u.test(expectedDigest)
	)
		return { deviceId, groupId, requiredRemovalId, expectedDigest };
	return null;
}

function blockFailure(c: Context, error: unknown) {
	if (error instanceof RemoteCoordinatorRequestError && error.status === 409)
		return c.json({ error: error.code }, 409);
	return c.json({ error: "device_block_unavailable" }, 503);
}

async function blockRemoved(c: Context, options: Options, phase: BlockPhase) {
	c.header("Cache-Control", "no-store");
	const body = await parseJsonObjectBody(c, 4_096);
	if (body instanceof Response) return body;
	const target = blockTarget(c, body, phase);
	if (!target) return c.json({ error: "invalid_input" }, 400);
	try {
		const readConfig = options.readCoordinatorConfig ?? readCoordinatorSyncConfig;
		const remote = readDeviceRemovalCoordinator(readConfig);
		if (!remote) return c.json({ error: "coordinator_admin_required" }, 409);
		const store = options.getStore();
		if (store.deviceId === target.deviceId)
			return c.json({ error: "cannot_remove_this_device" }, 400);
		const localKey = verifiedLocalKeyId(store.db, store.deviceId);
		if (!localKey) return c.json({ error: "local_identity_unverified" }, 409);
		const { expectedDigest, ...subject } = target;
		const request = {
			...subject,
			remoteUrl: remote.url,
			adminSecret: remote.adminSecret,
			timeoutS: remote.timeoutS,
		};
		const review = await coordinatorRevokeDeviceAction(request);
		if (review.state !== "ready") return c.json({ error: "device_block_unavailable" }, 503);
		if (review.key_id === localKey) return c.json({ error: "cannot_remove_this_device" }, 400);
		if (phase === "preview") return c.json(review);
		const current = readDeviceRemovalCoordinator(readConfig);
		if (
			expectedDigest !== review.expected_digest ||
			current?.url !== remote.url ||
			current.adminSecret !== remote.adminSecret ||
			verifiedLocalKeyId(store.db, store.deviceId) !== localKey
		)
			return c.json({ error: "revocation_preview_stale" }, 409);
		return c.json(
			await coordinatorRevokeDeviceAction({
				...request,
				expectedDigest,
				expectedContext: { coordinatorId: review.coordinator_id, keyId: review.key_id },
			}),
		);
	} catch (error) {
		return blockFailure(c, error);
	}
}

/** Viewer bridge for Block from a listed tombstone. The coordinator checks the exact removal. */
export function removedDeviceBlockRoutes(options: Options) {
	return new Hono()
		.post(`${path}/preview`, originGuard(), (c) => blockRemoved(c, options, "preview"))
		.post(path, originGuard(), (c) => blockRemoved(c, options, "commit"));
}
