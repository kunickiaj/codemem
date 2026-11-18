import { resumeProjectOnThisDevice, stopProjectOnThisDevice } from "@codemem/core";
import { type Context, Hono } from "hono";
import type { StoreFactory } from "./sync.js";
import { parseViewerJsonBody } from "./sync.js";

/**
 * Stopping and resuming a Project on this device (ADR 0007 Decision 4). A device
 * can always withdraw itself, so neither route needs the coordinator admin secret.
 * They change only what this device sends and receives.
 */
async function readProjectIdentity(c: Context): Promise<string | null> {
	const body = await parseViewerJsonBody(c);
	if (!body || Object.keys(body).length !== 1) return null;
	const identity = body.workspace_identity;
	return typeof identity === "string" && identity.trim() ? identity.trim() : null;
}

async function stopProject(c: Context, getStore: StoreFactory) {
	const identity = await readProjectIdentity(c);
	if (!identity) return c.json({ error: "project_identity_invalid" as const }, 400);
	const store = getStore();
	const stopped = store.db
		.transaction(() =>
			stopProjectOnThisDevice(store.db, {
				deviceId: store.deviceId,
				workspaceIdentity: identity,
				now: new Date().toISOString(),
			}),
		)
		.immediate();
	if (!stopped) return c.json({ error: "project_not_on_own_boundary" as const }, 404);
	return c.json({ workspace_identity: identity, stopped_at: stopped.withdrawnAt });
}

async function resumeProject(c: Context, getStore: StoreFactory) {
	const identity = await readProjectIdentity(c);
	if (!identity) return c.json({ error: "project_identity_invalid" as const }, 400);
	const store = getStore();
	const resumed = resumeProjectOnThisDevice(store.db, {
		deviceId: store.deviceId,
		workspaceIdentity: identity,
		now: new Date().toISOString(),
	});
	if (!resumed) return c.json({ error: "project_not_stopped" as const }, 404);
	return c.json({ workspace_identity: identity, stopped_at: null });
}

export function projectWithdrawalRoutes(getStore: StoreFactory) {
	const app = new Hono();
	app.post("/api/sync/project-withdrawals/v1/stop", (c) => stopProject(c, getStore));
	app.post("/api/sync/project-withdrawals/v1/resume", (c) => resumeProject(c, getStore));
	return app;
}
