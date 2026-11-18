import type { Context } from "hono";
import {
	BOUNDARY_READINESS_MAX_BODY_BYTES,
	type BoundaryReadinessProject,
	type PutBoundaryReadinessResult,
} from "./coordinator-boundary-readiness.js";
import type { CoordinatorEnrollment, CoordinatorStore } from "./coordinator-store-contract.js";
import { supportsSyncFeature } from "./sync-capability.js";

export const BOUNDARY_READINESS_PATH = "/v1/boundary-readiness";
/** The sync feature a device advertises in presence while it runs the migration code. */
export const BOUNDARY_MIGRATION_SYNC_FEATURE = "project_boundary_migration_v1";

interface SignedRequest {
	method: string;
	url: string;
	groupId: string;
	body: Uint8Array;
	deviceId: string | null;
	signature: string | null;
	timestamp: string | null;
	nonce: string | null;
}

export interface BoundaryReadinessRouteDeps {
	storeFactory: () => CoordinatorStore;
	authorizeRequest: (
		store: CoordinatorStore,
		request: SignedRequest,
	) => Promise<{ ok: boolean; error: string; enrollment: CoordinatorEnrollment | null }>;
	authErrorStatus: (error: string) => 401 | 403 | 409;
	readRequestBytes: (c: Context, maxBytes: number) => Promise<Uint8Array | null>;
	parseJsonObject: (raw: Uint8Array) => Record<string, unknown> | null;
	rateLimitedResponse: (
		c: Context,
		key: string,
		options: { authenticated: boolean },
	) => Response | null;
}

interface BoundaryReadinessApp {
	post(path: string, handler: (c: Context) => Promise<Response>): unknown;
}

/**
 * A device that posts presence without the migration feature no longer runs the
 * migration code, as after a downgrade. Its readiness record is removed before
 * the presence is stored, so a failure here fails the request and the device
 * tries again, instead of leaving a record that says an older build is ready.
 */
export async function discardReadinessWithoutFeature(
	store: Pick<CoordinatorStore, "discardBoundaryReadiness">,
	presence: { groupId: string; deviceId: string; capabilities?: Record<string, unknown> },
): Promise<void> {
	const features = presence.capabilities?.sync_features;
	if (supportsSyncFeature(features, BOUNDARY_MIGRATION_SYNC_FEATURE)) return;
	await store.discardBoundaryReadiness({
		groupId: presence.groupId,
		deviceId: presence.deviceId,
	});
}

interface ReadinessBody {
	sequence: number;
	omittedProjects: number;
	projects: BoundaryReadinessProject[];
}

/**
 * The record of a request body, or the error to answer with. The store checks
 * every field again. This only refuses what cannot be a record of this version
 * and a body that names another device or group than the signed caller.
 */
function parseReadinessBody(
	data: Record<string, unknown> | null,
	caller: { groupId: string; deviceId: string },
): ReadinessBody | { error: string } {
	if (!data) return { error: "invalid_json" };
	if (data.version !== 1) return { error: "readiness_version_unsupported" };
	if (data.device_id !== undefined && data.device_id !== caller.deviceId) {
		return { error: "device_id_mismatch" };
	}
	if (data.group_id !== undefined && data.group_id !== caller.groupId) {
		return { error: "group_id_mismatch" };
	}
	if (typeof data.sequence !== "number" || !Array.isArray(data.projects)) {
		return { error: "readiness_record_invalid" };
	}
	const omitted = data.omitted_projects ?? 0;
	if (typeof omitted !== "number") return { error: "readiness_record_invalid" };
	return {
		sequence: data.sequence,
		omittedProjects: omitted,
		projects: data.projects as BoundaryReadinessProject[],
	};
}

function storedResponse(c: Context, result: PutBoundaryReadinessResult): Response {
	if (result.kind === "stored") {
		return c.json({
			version: 1,
			status: "stored",
			sequence: result.sequence,
			rejected: result.rejected,
		});
	}
	if (result.kind === "stale") {
		return c.json({ version: 1, status: "stale", sequence: result.sequence });
	}
	if (result.kind === "not_enrolled") return c.json({ error: "device_not_enrolled" }, 403);
	return c.json({ error: "boundary_readiness_unavailable" }, 503);
}

async function putResponse(
	c: Context,
	store: CoordinatorStore,
	caller: { groupId: string; deviceId: string },
	body: ReadinessBody,
): Promise<Response> {
	try {
		return storedResponse(c, await store.putBoundaryReadiness({ ...caller, ...body }));
	} catch (error) {
		const code = error instanceof Error ? error.message : "";
		if (code === "invalid_input") return c.json({ error: "readiness_record_invalid" }, 400);
		if (code === "boundary_readiness_too_large") {
			return c.json({ error: "boundary_readiness_too_large" }, 413);
		}
		return c.json({ error: "boundary_readiness_unavailable" }, 503);
	}
}

/** A denial or rate-limit response, or the signed caller's enrollment. */
async function authorizeCaller(
	c: Context,
	deps: BoundaryReadinessRouteDeps,
	store: CoordinatorStore,
	request: { groupId: string; raw: Uint8Array },
): Promise<Response | CoordinatorEnrollment> {
	const auth = await deps.authorizeRequest(store, {
		method: c.req.method,
		url: c.req.url,
		groupId: request.groupId,
		body: request.raw,
		deviceId: c.req.header("X-Opencode-Device") ?? null,
		signature: c.req.header("X-Opencode-Signature") ?? null,
		timestamp: c.req.header("X-Opencode-Timestamp") ?? null,
		nonce: c.req.header("X-Opencode-Nonce") ?? null,
	});
	if (!auth.ok || !auth.enrollment) {
		return (
			deps.rateLimitedResponse(c, c.req.path, { authenticated: false }) ??
			c.json({ error: auth.error }, deps.authErrorStatus(auth.error))
		);
	}
	const limited = deps.rateLimitedResponse(c, String(auth.enrollment.device_id), {
		authenticated: true,
	});
	return limited ?? auth.enrollment;
}

/**
 * Lets an enrolled device store its readiness record for one group. The device
 * is the one whose key signed the request, never one the body names. A
 * coordinator without this route answers 404, which a device reads as "not
 * updated yet".
 */
export function registerCoordinatorBoundaryReadinessRoute(
	app: BoundaryReadinessApp,
	deps: BoundaryReadinessRouteDeps,
): void {
	app.post(BOUNDARY_READINESS_PATH, async (c) => {
		const groupId = (c.req.query("group_id") ?? "").trim();
		if (!groupId) return c.json({ error: "group_id_required" }, 400);
		const raw = await deps.readRequestBytes(c, BOUNDARY_READINESS_MAX_BODY_BYTES);
		if (raw == null) return c.json({ error: "body_too_large" }, 413);
		const store = deps.storeFactory();
		try {
			const caller = await authorizeCaller(c, deps, store, { groupId, raw });
			if (caller instanceof Response) return caller;
			const device = { groupId, deviceId: String(caller.device_id) };
			const body = parseReadinessBody(deps.parseJsonObject(raw), device);
			if ("error" in body) return c.json({ error: body.error }, 400);
			return await putResponse(c, store, device, body);
		} finally {
			await store.close();
		}
	});
}
