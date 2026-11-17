import {
	type CoordinatorEnrollment,
	coordinatorRevokeDeviceAction,
	type MemoryStore,
	RemoteCoordinatorRequestError,
	type RetireTarget,
	type RetireTargetError,
	readCoordinatorSyncConfig,
	resolveRetireTarget,
	retireDeviceLocally,
} from "@codemem/core";
import { type Context, Hono } from "hono";
import { deviceRenameRoutes, listAllEnrollments } from "./device-rename.js";

type CoordinatorConfig = ReturnType<typeof readCoordinatorSyncConfig>;
type RetireFailure = { error: string; status: 400 | 404 | 409 | 502 | 503 };

const HASH = /^[a-f0-9]{64}$/;

function coordinatorCredentials(config: CoordinatorConfig) {
	const remoteUrl = config.syncCoordinatorUrl.trim();
	const adminSecret = config.syncCoordinatorAdminSecret.trim();
	return remoteUrl && adminSecret ? { remoteUrl, adminSecret } : null;
}

/** Maps revocation client failures to messages Devices can act on. */
function revocationFailure(error: unknown): RetireFailure {
	let code = error instanceof Error ? error.message : "";
	if (error instanceof RemoteCoordinatorRequestError) code = error.code;
	if (code === "revocation_preview_stale") return { error: "retire_preview_stale", status: 409 };
	if (code === "revocation_target_unavailable")
		return { error: "retire_target_unavailable", status: 409 };
	if (code === "revocation_outcome_unknown")
		return { error: "retire_outcome_unknown", status: 502 };
	return { error: "retire_unavailable", status: 503 };
}

function fail(c: Context, failure: RetireFailure) {
	return c.json({ error: failure.error }, failure.status);
}

const TARGET_FAILURES: Record<RetireTargetError, RetireFailure> = {
	device_not_enrolled: { error: "device_not_enrolled", status: 404 },
	cannot_retire_this_device: { error: "cannot_retire_this_device", status: 400 },
	device_already_retired: { error: "device_already_retired", status: 409 },
	device_enrollment_conflict: { error: "device_enrollment_conflict", status: 409 },
	device_evidence_incomplete: { error: "coordinator_evidence_too_large", status: 503 },
	device_key_unrecognized: { error: "device_key_unrecognized", status: 409 },
	local_identity_unverified: { error: "local_identity_unverified", status: 409 },
};

/** The device's whole alias group and its revocation evidence, read fresh from the coordinator. */
async function resolveTarget(
	config: CoordinatorConfig,
	store: MemoryStore,
	deviceId: string,
): Promise<RetireTarget | RetireFailure> {
	let enrollments: CoordinatorEnrollment[];
	try {
		// Revocation covers archived groups too, so their enrollments are evidence.
		enrollments = await listAllEnrollments(config, { includeArchived: true });
	} catch (error) {
		const code = error instanceof Error ? error.message : "";
		if (code === "coordinator_evidence_too_large") return { error: code, status: 503 };
		return { error: "retire_unavailable", status: 503 };
	}
	const target = resolveRetireTarget(store.db, {
		localDeviceId: store.deviceId,
		enrollments,
		deviceId,
	});
	return typeof target === "string" ? TARGET_FAILURES[target] : target;
}

function retireTarget(c: Context): string | RetireFailure {
	const deviceId = String(c.req.param("device_id") ?? "").trim();
	if (!deviceId) return { error: "device_id_required", status: 400 };
	return deviceId;
}

async function previewRetire(c: Context, store: MemoryStore) {
	const deviceId = retireTarget(c);
	if (typeof deviceId !== "string") return fail(c, deviceId);
	const config = readCoordinatorSyncConfig();
	const credentials = coordinatorCredentials(config);
	if (!credentials) return fail(c, { error: "coordinator_admin_required", status: 409 });
	const target = await resolveTarget(config, store, deviceId);
	if ("error" in target) return fail(c, target);
	try {
		const preview = await coordinatorRevokeDeviceAction({
			...credentials,
			groupId: target.groupId,
			deviceId: target.enrollmentDeviceId,
		});
		if (preview.state !== "ready") return fail(c, { error: "retire_unavailable", status: 503 });
		// Never confirm a revocation for a key other than the one checked here.
		if (preview.key_id !== target.keyId)
			return fail(c, { error: "device_enrollment_conflict", status: 409 });
		return c.json({
			device_id: deviceId,
			display_name: target.displayName,
			enrollment_device_id: target.enrollmentDeviceId,
			alias_device_ids: target.aliasDeviceIds,
			group_id: target.groupId,
			coordinator_id: preview.coordinator_id,
			key_id: preview.key_id,
			expected_digest: preview.expected_digest,
		});
	} catch (error) {
		return fail(c, revocationFailure(error));
	}
}

function confirmedPreview(body: Record<string, unknown>) {
	const groupId = typeof body.group_id === "string" ? body.group_id : "";
	const enrollmentDeviceId =
		typeof body.enrollment_device_id === "string" ? body.enrollment_device_id : "";
	const digest = typeof body.expected_digest === "string" ? body.expected_digest : "";
	const coordinatorId = typeof body.coordinator_id === "string" ? body.coordinator_id : "";
	const keyId = typeof body.key_id === "string" ? body.key_id : "";
	if (!groupId || !enrollmentDeviceId || !coordinatorId || !HASH.test(digest) || !HASH.test(keyId))
		return null;
	return {
		enrollmentDeviceId,
		revocation: { groupId, expectedDigest: digest, expectedContext: { coordinatorId, keyId } },
	};
}

async function commitRetire(c: Context, store: MemoryStore) {
	const deviceId = retireTarget(c);
	if (typeof deviceId !== "string") return fail(c, deviceId);
	const body = await c.req.json<Record<string, unknown>>().catch(() => null);
	const confirmed = body ? confirmedPreview(body) : null;
	if (!confirmed) return fail(c, { error: "retire_preview_required", status: 400 });
	const config = readCoordinatorSyncConfig();
	const credentials = coordinatorCredentials(config);
	if (!credentials) return fail(c, { error: "coordinator_admin_required", status: 409 });
	// Resolve again on the server, so the client can't redirect the commit to another enrollment.
	const target = await resolveTarget(config, store, deviceId);
	if ("error" in target) return fail(c, target);
	if (
		target.groupId !== confirmed.revocation.groupId ||
		target.enrollmentDeviceId !== confirmed.enrollmentDeviceId ||
		target.keyId !== confirmed.revocation.expectedContext.keyId
	)
		return fail(c, { error: "retire_preview_stale", status: 409 });
	try {
		const receipt = await coordinatorRevokeDeviceAction({
			...credentials,
			...confirmed.revocation,
			deviceId: target.enrollmentDeviceId,
		});
		if (receipt.state !== "revoked")
			return fail(c, { error: "retire_outcome_unknown", status: 502 });
	} catch (error) {
		return fail(c, revocationFailure(error));
	}
	// Other peers drop their pairing at their next coordinator refresh; this one drops it now.
	const unpaired = retireDeviceLocally(store.db, store.deviceId, target) > 0;
	return c.json({ state: "retired", device_id: deviceId, unpaired_here: unpaired });
}

/**
 * Retires another device: revokes its enrollment's device ID and its key across the
 * coordinator, after a preview the caller confirms by digest, then unpairs every
 * local ID that carries the key.
 */
export function deviceRetireRoutes(getStore: () => MemoryStore) {
	return new Hono()
		.post("/api/sync/devices/:device_id/retire/preview", (c) => previewRetire(c, getStore()))
		.post("/api/sync/devices/:device_id/retire", (c) => commitRetire(c, getStore()));
}

/** Rename and retirement routes for one device, mounted together by the sync app. */
export function deviceRoutes(getStore: () => MemoryStore) {
	return new Hono()
		.route("/", deviceRenameRoutes(getStore))
		.route("/", deviceRetireRoutes(getStore));
}
