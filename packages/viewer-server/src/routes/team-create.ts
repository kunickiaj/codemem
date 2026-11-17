import {
	createRecipientPolicyTeam,
	RecipientPolicyTeamCreateError,
	readCoordinatorSyncConfig,
} from "@codemem/core";
import { type Context, Hono } from "hono";
import type { StoreFactory } from "./sync.js";
import {
	coordinatorAdminStatusPayload,
	ensureLocalActorRecord,
	parseViewerJsonBody,
} from "./sync.js";

/**
 * Team invitations go through the configured coordinator group, and only a device
 * with the admin secret can issue them, so Teams are created only on such a device.
 */
function teamCreationUnavailable(status: ReturnType<typeof coordinatorAdminStatusPayload>): {
	code: "team_create_admin_required" | "team_create_coordinator_required";
	httpStatus: 403 | 409;
} | null {
	if (status.readiness === "ready") return null;
	if (status.readiness === "partial" && !status.has_admin_secret) {
		return { code: "team_create_admin_required", httpStatus: 403 };
	}
	return { code: "team_create_coordinator_required", httpStatus: 409 };
}

function isCreateTeamBody(body: unknown): body is { displayName: string } {
	return (
		Boolean(body) &&
		typeof body === "object" &&
		!Array.isArray(body) &&
		Object.keys(body as object).length === 1 &&
		typeof (body as Record<string, unknown>).displayName === "string"
	);
}

async function createTeam(
	c: Context,
	getStore: StoreFactory,
	readConfig: typeof readCoordinatorSyncConfig,
) {
	const unavailable = teamCreationUnavailable(coordinatorAdminStatusPayload(readConfig()));
	if (unavailable) return c.json({ error: unavailable.code }, unavailable.httpStatus);
	const body = await parseViewerJsonBody(c);
	if (!isCreateTeamBody(body)) return c.json({ error: "team_name_invalid" as const }, 400);
	try {
		const store = getStore();
		// A false result means this device's person can't be confirmed (for example,
		// history adoption is waiting on a conflict), so no one becomes admin.
		if (!ensureLocalActorRecord(store)) {
			return c.json({ error: "team_creator_unavailable" as const }, 409);
		}
		const team = createRecipientPolicyTeam(store.db, {
			displayName: body.displayName,
			creatorIdentityId: store.actorId,
			now: new Date().toISOString(),
		});
		return c.json(team, 201);
	} catch (error) {
		if (error instanceof RecipientPolicyTeamCreateError) {
			return c.json({ error: error.code }, error.code === "team_name_taken" ? 409 : 400);
		}
		return c.json({ error: "team_create_failed" as const }, 500);
	}
}

export function teamCreateRoutes(
	getStore: StoreFactory,
	readCoordinatorConfig: typeof readCoordinatorSyncConfig = readCoordinatorSyncConfig,
) {
	const app = new Hono();
	app.post("/api/sync/recipient-policy/v1/teams", (c) =>
		createTeam(c, getStore, readCoordinatorConfig),
	);
	return app;
}
