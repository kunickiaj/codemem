/**
 * Coordinator API — Hono-based HTTP server for the coordinator relay.
 *
 * Manages device enrollment, presence, invites, and join requests.
 * Ported from codemem/coordinator_api.py.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import type { InvitePayload } from "./coordinator-invites.js";
import { encodeInvitePayload, inviteLink } from "./coordinator-invites.js";
import type { CoordinatorEnrollment, CoordinatorStore } from "./coordinator-store-contract.js";
import { DEFAULT_TIME_WINDOW_S, verifySignature } from "./sync-auth.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 64 * 1024;
const ADMIN_HEADER = "X-Codemem-Coordinator-Admin";

export interface CoordinatorRuntimeDeps {
	adminSecret(): string | null;
	now(): string;
}

export interface CreateCoordinatorAppOptions {
	storeFactory?: () => CoordinatorStore;
	runtime?: CoordinatorRuntimeDeps;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultAdminSecret(): string | null {
	const value = (process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET ?? "").trim();
	return value || null;
}

function authorizeAdmin(
	headerValue: string | null | undefined,
	runtime: CoordinatorRuntimeDeps,
): { ok: boolean; error: string } {
	const expected = runtime.adminSecret();
	if (!expected) return { ok: false, error: "admin_not_configured" };
	const provided = (headerValue ?? "").trim();
	if (!provided) return { ok: false, error: "missing_admin_header" };
	if (provided !== expected) return { ok: false, error: "invalid_admin_secret" };
	return { ok: true, error: "ok" };
}

/** Extract path + query string from a full URL for signature verification. */
function pathWithQuery(url: string): string {
	const parsed = new URL(url);
	return parsed.search ? `${parsed.pathname}${parsed.search}` : parsed.pathname;
}

async function recordNonce(
	store: CoordinatorStore,
	deviceId: string,
	nonce: string,
	createdAt: string,
): Promise<boolean> {
	return await store.recordNonce(deviceId, nonce, createdAt);
}

async function cleanupNonces(store: CoordinatorStore, cutoff: string): Promise<void> {
	await store.cleanupNonces(cutoff);
}

interface AuthResult {
	ok: boolean;
	error: string;
	enrollment: CoordinatorEnrollment | null;
}

async function authorizeRequest(
	store: CoordinatorStore,
	runtime: CoordinatorRuntimeDeps,
	opts: {
		method: string;
		url: string;
		groupId: string;
		body: Buffer;
		deviceId: string | null;
		signature: string | null;
		timestamp: string | null;
		nonce: string | null;
	},
): Promise<AuthResult> {
	const { deviceId, signature, timestamp, nonce } = opts;
	if (!deviceId || !signature || !timestamp || !nonce) {
		return { ok: false, error: "missing_headers", enrollment: null };
	}

	const enrollment = await store.getEnrollment(opts.groupId, deviceId);
	if (!enrollment) {
		return { ok: false, error: "unknown_device", enrollment: null };
	}

	let valid: boolean;
	try {
		valid = verifySignature({
			method: opts.method,
			pathWithQuery: pathWithQuery(opts.url),
			bodyBytes: opts.body,
			timestamp,
			nonce,
			signature,
			publicKey: String(enrollment.public_key),
			deviceId,
		});
	} catch {
		return { ok: false, error: "signature_verification_error", enrollment: null };
	}

	if (!valid) {
		return { ok: false, error: "invalid_signature", enrollment: null };
	}

	const createdAt = runtime.now();
	if (!(await recordNonce(store, deviceId, nonce, createdAt))) {
		return { ok: false, error: "nonce_replay", enrollment: null };
	}

	const cutoff = new Date(
		new Date(createdAt).getTime() - DEFAULT_TIME_WINDOW_S * 2 * 1000,
	).toISOString();
	await cleanupNonces(store, cutoff);

	return { ok: true, error: "ok", enrollment };
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

export function createCoordinatorApp(
	opts?: CreateCoordinatorAppOptions,
): InstanceType<typeof Hono> {
	const runtime: CoordinatorRuntimeDeps = opts?.runtime ?? {
		adminSecret: defaultAdminSecret,
		now: () => new Date().toISOString(),
	};
	if (!opts?.storeFactory) {
		throw new Error("createCoordinatorApp requires a storeFactory.");
	}
	const createStore = opts.storeFactory;
	const app = new Hono();

	// -----------------------------------------------------------------------
	// POST /v1/presence — upsert device presence (authenticated)
	// -----------------------------------------------------------------------

	app.post("/v1/presence", async (c) => {
		const raw = Buffer.from(await c.req.arrayBuffer());
		if (raw.length > MAX_BODY_BYTES) {
			return c.json({ error: "body_too_large" }, 413);
		}

		let data: Record<string, unknown>;
		try {
			data = JSON.parse(raw.toString("utf-8"));
			if (typeof data !== "object" || data === null || Array.isArray(data)) {
				return c.json({ error: "invalid_json" }, 400);
			}
		} catch {
			return c.json({ error: "invalid_json" }, 400);
		}

		const groupId = String(data.group_id ?? "").trim();
		if (!groupId) {
			return c.json({ error: "group_id_required" }, 400);
		}

		const store = createStore();
		try {
			const auth = await authorizeRequest(store, runtime, {
				method: c.req.method,
				url: c.req.url,
				groupId,
				body: raw,
				deviceId: c.req.header("X-Opencode-Device") ?? null,
				signature: c.req.header("X-Opencode-Signature") ?? null,
				timestamp: c.req.header("X-Opencode-Timestamp") ?? null,
				nonce: c.req.header("X-Opencode-Nonce") ?? null,
			});
			if (!auth.ok || !auth.enrollment) {
				return c.json({ error: auth.error }, 401);
			}

			if (data.fingerprint && String(data.fingerprint) !== String(auth.enrollment.fingerprint)) {
				return c.json({ error: "fingerprint_mismatch" }, 401);
			}

			const rawAddresses = data.addresses ?? [];
			if (!Array.isArray(rawAddresses) || !rawAddresses.every((item) => typeof item === "string")) {
				return c.json({ error: "addresses_must_be_list_of_strings" }, 400);
			}

			let ttlS: number;
			try {
				ttlS = Math.max(1, Number.parseInt(String(data.ttl_s ?? 180), 10));
				if (Number.isNaN(ttlS)) {
					return c.json({ error: "ttl_s_must_be_int" }, 400);
				}
			} catch {
				return c.json({ error: "ttl_s_must_be_int" }, 400);
			}

			const response = await store.upsertPresence({
				groupId,
				deviceId: String(auth.enrollment.device_id),
				addresses: rawAddresses as string[],
				ttlS,
				capabilities:
					typeof data.capabilities === "object" &&
					data.capabilities !== null &&
					!Array.isArray(data.capabilities)
						? (data.capabilities as Record<string, unknown>)
						: undefined,
			});

			return c.json({ ok: true, ...response });
		} finally {
			await store.close();
		}
	});

	// -----------------------------------------------------------------------
	// GET /v1/peers — list group peers (authenticated)
	// -----------------------------------------------------------------------

	app.get("/v1/peers", async (c) => {
		const groupId = (c.req.query("group_id") ?? "").trim();
		if (!groupId) {
			return c.json({ error: "group_id_required" }, 400);
		}

		const store = createStore();
		try {
			const auth = await authorizeRequest(store, runtime, {
				method: c.req.method,
				url: c.req.url,
				groupId,
				body: Buffer.alloc(0),
				deviceId: c.req.header("X-Opencode-Device") ?? null,
				signature: c.req.header("X-Opencode-Signature") ?? null,
				timestamp: c.req.header("X-Opencode-Timestamp") ?? null,
				nonce: c.req.header("X-Opencode-Nonce") ?? null,
			});
			if (!auth.ok || !auth.enrollment) {
				return c.json({ error: auth.error }, 401);
			}

			const items = await store.listGroupPeers(groupId, String(auth.enrollment.device_id));
			return c.json({ items });
		} finally {
			await store.close();
		}
	});

	// -----------------------------------------------------------------------
	// GET /v1/reciprocal-approvals — list pending local approval state
	// -----------------------------------------------------------------------

	app.get("/v1/reciprocal-approvals", async (c) => {
		const groupId = (c.req.query("group_id") ?? "").trim();
		const direction = (c.req.query("direction") ?? "incoming").trim();
		const status = (c.req.query("status") ?? "pending").trim() || "pending";
		if (!groupId) {
			return c.json({ error: "group_id_required" }, 400);
		}
		if (!["incoming", "outgoing"].includes(direction)) {
			return c.json({ error: "direction_must_be_incoming_or_outgoing" }, 400);
		}

		const store = createStore();
		try {
			const auth = await authorizeRequest(store, runtime, {
				method: c.req.method,
				url: c.req.url,
				groupId,
				body: Buffer.alloc(0),
				deviceId: c.req.header("X-Opencode-Device") ?? null,
				signature: c.req.header("X-Opencode-Signature") ?? null,
				timestamp: c.req.header("X-Opencode-Timestamp") ?? null,
				nonce: c.req.header("X-Opencode-Nonce") ?? null,
			});
			if (!auth.ok || !auth.enrollment) {
				return c.json({ error: auth.error }, 401);
			}
			const items = await store.listReciprocalApprovals({
				groupId,
				deviceId: String(auth.enrollment.device_id),
				direction: direction as "incoming" | "outgoing",
				status,
			});
			return c.json({ items });
		} finally {
			await store.close();
		}
	});

	// -----------------------------------------------------------------------
	// POST /v1/reciprocal-approvals — register a local trust action
	// -----------------------------------------------------------------------

	app.post("/v1/reciprocal-approvals", async (c) => {
		const raw = Buffer.from(await c.req.arrayBuffer());
		if (raw.length > MAX_BODY_BYTES) {
			return c.json({ error: "body_too_large" }, 413);
		}

		let data: Record<string, unknown>;
		try {
			data = JSON.parse(raw.toString("utf-8"));
			if (typeof data !== "object" || data === null || Array.isArray(data)) {
				return c.json({ error: "invalid_json" }, 400);
			}
		} catch {
			return c.json({ error: "invalid_json" }, 400);
		}

		const groupId = String(data.group_id ?? "").trim();
		const requestedDeviceId = String(data.requested_device_id ?? "").trim();
		if (!groupId || !requestedDeviceId) {
			return c.json({ error: "group_id_and_requested_device_id_required" }, 400);
		}

		const store = createStore();
		try {
			const auth = await authorizeRequest(store, runtime, {
				method: c.req.method,
				url: c.req.url,
				groupId,
				body: raw,
				deviceId: c.req.header("X-Opencode-Device") ?? null,
				signature: c.req.header("X-Opencode-Signature") ?? null,
				timestamp: c.req.header("X-Opencode-Timestamp") ?? null,
				nonce: c.req.header("X-Opencode-Nonce") ?? null,
			});
			if (!auth.ok || !auth.enrollment) {
				return c.json({ error: auth.error }, 401);
			}
			if (requestedDeviceId === String(auth.enrollment.device_id)) {
				return c.json({ error: "requested_device_must_differ" }, 400);
			}
			const targetEnrollment = await store.getEnrollment(groupId, requestedDeviceId);
			if (!targetEnrollment) {
				return c.json({ error: "requested_device_not_found" }, 404);
			}
			const request = await store.createReciprocalApproval({
				groupId,
				requestingDeviceId: String(auth.enrollment.device_id),
				requestedDeviceId,
			});
			return c.json({ ok: true, request });
		} finally {
			await store.close();
		}
	});

	// -----------------------------------------------------------------------
	// Admin routes
	// -----------------------------------------------------------------------

	// POST /v1/admin/devices — enroll a device
	app.post("/v1/admin/devices", async (c) => {
		const adminAuth = authorizeAdmin(c.req.header(ADMIN_HEADER), runtime);
		if (!adminAuth.ok) return c.json({ error: adminAuth.error }, 401);

		const raw = Buffer.from(await c.req.arrayBuffer());
		if (raw.length > MAX_BODY_BYTES) return c.json({ error: "body_too_large" }, 413);

		let data: Record<string, unknown>;
		try {
			data = JSON.parse(raw.toString("utf-8"));
			if (typeof data !== "object" || data === null || Array.isArray(data)) {
				return c.json({ error: "invalid_json" }, 400);
			}
		} catch {
			return c.json({ error: "invalid_json" }, 400);
		}

		const groupId = String(data.group_id ?? "").trim();
		const deviceId = String(data.device_id ?? "").trim();
		const fingerprint = String(data.fingerprint ?? "").trim();
		const publicKey = String(data.public_key ?? "").trim();
		const displayName = String(data.display_name ?? "").trim() || null;

		if (!groupId || !deviceId || !fingerprint || !publicKey) {
			return c.json({ error: "group_id_device_id_fingerprint_public_key_required" }, 400);
		}

		const store = createStore();
		try {
			await store.createGroup(groupId);
			await store.enrollDevice(groupId, {
				deviceId,
				fingerprint,
				publicKey,
				displayName,
			});
		} finally {
			await store.close();
		}

		return c.json({ ok: true });
	});

	// GET /v1/admin/devices — list enrolled devices
	app.get("/v1/admin/devices", async (c) => {
		const adminAuth = authorizeAdmin(c.req.header(ADMIN_HEADER), runtime);
		if (!adminAuth.ok) return c.json({ error: adminAuth.error }, 401);

		const groupId = (c.req.query("group_id") ?? "").trim();
		if (!groupId) return c.json({ error: "group_id_required" }, 400);

		const includeDisabled = ["1", "true", "yes"].includes(
			(c.req.query("include_disabled") ?? "0").trim().toLowerCase(),
		);

		const store = createStore();
		try {
			return c.json({ items: await store.listEnrolledDevices(groupId, includeDisabled) });
		} finally {
			await store.close();
		}
	});

	// POST /v1/admin/devices/rename
	app.post("/v1/admin/devices/rename", async (c) => {
		const adminAuth = authorizeAdmin(c.req.header(ADMIN_HEADER), runtime);
		if (!adminAuth.ok) return c.json({ error: adminAuth.error }, 401);

		const raw = Buffer.from(await c.req.arrayBuffer());
		if (raw.length > MAX_BODY_BYTES) return c.json({ error: "body_too_large" }, 413);

		let data: Record<string, unknown>;
		try {
			data = JSON.parse(raw.toString("utf-8"));
			if (typeof data !== "object" || data === null || Array.isArray(data)) {
				return c.json({ error: "invalid_json" }, 400);
			}
		} catch {
			return c.json({ error: "invalid_json" }, 400);
		}

		const groupId = String(data.group_id ?? "").trim();
		const deviceId = String(data.device_id ?? "").trim();
		const displayName = String(data.display_name ?? "").trim();

		if (!groupId || !deviceId) {
			return c.json({ error: "group_id_and_device_id_required" }, 400);
		}
		if (!displayName) {
			return c.json({ error: "display_name_required" }, 400);
		}

		const store = createStore();
		try {
			const ok = await store.renameDevice(groupId, deviceId, displayName);
			if (!ok) return c.json({ error: "device_not_found" }, 404);
			return c.json({ ok: true });
		} finally {
			await store.close();
		}
	});

	// POST /v1/admin/devices/disable
	app.post("/v1/admin/devices/disable", async (c) => {
		const adminAuth = authorizeAdmin(c.req.header(ADMIN_HEADER), runtime);
		if (!adminAuth.ok) return c.json({ error: adminAuth.error }, 401);

		const raw = Buffer.from(await c.req.arrayBuffer());
		if (raw.length > MAX_BODY_BYTES) return c.json({ error: "body_too_large" }, 413);

		let data: Record<string, unknown>;
		try {
			data = JSON.parse(raw.toString("utf-8"));
			if (typeof data !== "object" || data === null || Array.isArray(data)) {
				return c.json({ error: "invalid_json" }, 400);
			}
		} catch {
			return c.json({ error: "invalid_json" }, 400);
		}

		const groupId = String(data.group_id ?? "").trim();
		const deviceId = String(data.device_id ?? "").trim();

		if (!groupId || !deviceId) {
			return c.json({ error: "group_id_and_device_id_required" }, 400);
		}

		const store = createStore();
		try {
			const ok = await store.setDeviceEnabled(groupId, deviceId, false);
			if (!ok) return c.json({ error: "device_not_found" }, 404);
			return c.json({ ok: true });
		} finally {
			await store.close();
		}
	});

	// POST /v1/admin/devices/remove
	app.post("/v1/admin/devices/remove", async (c) => {
		const adminAuth = authorizeAdmin(c.req.header(ADMIN_HEADER), runtime);
		if (!adminAuth.ok) return c.json({ error: adminAuth.error }, 401);

		const raw = Buffer.from(await c.req.arrayBuffer());
		if (raw.length > MAX_BODY_BYTES) return c.json({ error: "body_too_large" }, 413);

		let data: Record<string, unknown>;
		try {
			data = JSON.parse(raw.toString("utf-8"));
			if (typeof data !== "object" || data === null || Array.isArray(data)) {
				return c.json({ error: "invalid_json" }, 400);
			}
		} catch {
			return c.json({ error: "invalid_json" }, 400);
		}

		const groupId = String(data.group_id ?? "").trim();
		const deviceId = String(data.device_id ?? "").trim();

		if (!groupId || !deviceId) {
			return c.json({ error: "group_id_and_device_id_required" }, 400);
		}

		const store = createStore();
		try {
			const ok = await store.removeDevice(groupId, deviceId);
			if (!ok) return c.json({ error: "device_not_found" }, 404);
			return c.json({ ok: true });
		} finally {
			await store.close();
		}
	});

	// POST /v1/admin/invites — create an invite
	app.post("/v1/admin/invites", async (c) => {
		const adminAuth = authorizeAdmin(c.req.header(ADMIN_HEADER), runtime);
		if (!adminAuth.ok) return c.json({ error: adminAuth.error }, 401);

		const raw = Buffer.from(await c.req.arrayBuffer());
		if (raw.length > MAX_BODY_BYTES) return c.json({ error: "body_too_large" }, 413);

		let data: Record<string, unknown>;
		try {
			data = JSON.parse(raw.toString("utf-8"));
			if (typeof data !== "object" || data === null || Array.isArray(data)) {
				return c.json({ error: "invalid_json" }, 400);
			}
		} catch {
			return c.json({ error: "invalid_json" }, 400);
		}

		const groupId = String(data.group_id ?? "").trim();
		const policy = String(data.policy ?? "auto_admit").trim();
		const expiresAt = String(data.expires_at ?? "").trim();
		const createdBy = String(data.created_by ?? "").trim() || null;

		if (!groupId || !["auto_admit", "approval_required"].includes(policy) || !expiresAt) {
			return c.json({ error: "group_id_policy_and_expires_at_required" }, 400);
		}

		const store = createStore();
		try {
			const group = await store.getGroup(groupId);
			if (!group) return c.json({ error: "group_not_found" }, 404);

			const invite = await store.createInvite({
				groupId,
				policy,
				expiresAt,
				createdBy,
			});

			const payload: InvitePayload = {
				v: 1,
				kind: "coordinator_team_invite",
				coordinator_url: String(data.coordinator_url ?? "").trim(),
				group_id: groupId,
				policy,
				token: String(invite.token ?? ""),
				expires_at: expiresAt,
				team_name: (invite.team_name_snapshot as string) ?? null,
			};
			const encoded = encodeInvitePayload(payload);

			// Omit token from the returned invite object (matches Python)
			const { token: _token, ...inviteWithoutToken } = invite;

			return c.json({
				ok: true,
				invite: inviteWithoutToken,
				payload,
				encoded,
				link: inviteLink(encoded),
			});
		} finally {
			await store.close();
		}
	});

	// GET /v1/admin/invites — list invites
	app.get("/v1/admin/invites", async (c) => {
		const adminAuth = authorizeAdmin(c.req.header(ADMIN_HEADER), runtime);
		if (!adminAuth.ok) return c.json({ error: adminAuth.error }, 401);

		const groupId = (c.req.query("group_id") ?? "").trim();
		if (!groupId) return c.json({ error: "group_id_required" }, 400);

		const store = createStore();
		try {
			const rows = (await store.listInvites(groupId)).map(
				({ token: _token, ...inviteWithoutToken }) => inviteWithoutToken,
			);
			return c.json({ items: rows });
		} finally {
			await store.close();
		}
	});

	// POST /v1/admin/join-requests/approve
	app.post("/v1/admin/join-requests/approve", async (c) => {
		return handleJoinRequestReview(c, true, { createStore, runtime });
	});

	// POST /v1/admin/join-requests/deny
	app.post("/v1/admin/join-requests/deny", async (c) => {
		return handleJoinRequestReview(c, false, { createStore, runtime });
	});

	// GET /v1/admin/join-requests — list join requests
	app.get("/v1/admin/join-requests", async (c) => {
		const adminAuth = authorizeAdmin(c.req.header(ADMIN_HEADER), runtime);
		if (!adminAuth.ok) return c.json({ error: adminAuth.error }, 401);

		const groupId = (c.req.query("group_id") ?? "").trim();
		if (!groupId) return c.json({ error: "group_id_required" }, 400);

		const store = createStore();
		try {
			return c.json({ items: await store.listJoinRequests(groupId) });
		} finally {
			await store.close();
		}
	});

	// -----------------------------------------------------------------------
	// POST /v1/join — join via invite token (unauthenticated)
	// -----------------------------------------------------------------------

	app.post("/v1/join", async (c) => {
		const raw = Buffer.from(await c.req.arrayBuffer());
		if (raw.length > MAX_BODY_BYTES) return c.json({ error: "body_too_large" }, 413);

		let data: Record<string, unknown>;
		try {
			data = JSON.parse(raw.toString("utf-8"));
			if (typeof data !== "object" || data === null || Array.isArray(data)) {
				return c.json({ error: "invalid_json" }, 400);
			}
		} catch {
			return c.json({ error: "invalid_json" }, 400);
		}

		const token = String(data.token ?? "").trim();
		const deviceId = String(data.device_id ?? "").trim();
		const fingerprint = String(data.fingerprint ?? "").trim();
		const publicKey = String(data.public_key ?? "").trim();
		const displayName = String(data.display_name ?? "").trim() || null;

		if (!token || !deviceId || !fingerprint || !publicKey) {
			return c.json({ error: "token_device_id_fingerprint_public_key_required" }, 400);
		}

		const store = createStore();
		try {
			const invite = await store.getInviteByToken(token);
			if (!invite) return c.json({ error: "invalid_token" }, 404);

			if (invite.revoked_at) return c.json({ error: "revoked_token" }, 400);

			const expiresAtStr = String(invite.expires_at ?? "");
			if (expiresAtStr) {
				const expiresAt = new Date(expiresAtStr.replace("Z", "+00:00"));
				if (expiresAt <= new Date(runtime.now())) {
					return c.json({ error: "expired_token" }, 400);
				}
			}

			const inviteGroupId = String(invite.group_id);
			const existing = await store.getEnrollment(inviteGroupId, deviceId);
			if (existing) {
				return c.json({
					ok: true,
					status: "already_enrolled",
					group_id: invite.group_id,
					policy: invite.policy,
				});
			}

			const invitePolicy = String(invite.policy);
			if (!["auto_admit", "approval_required"].includes(invitePolicy)) {
				return c.json({ error: `unknown invite policy: ${invitePolicy}` }, 400);
			}

			if (invitePolicy === "approval_required") {
				const request = await store.createJoinRequest({
					groupId: inviteGroupId,
					deviceId,
					publicKey,
					fingerprint,
					displayName,
					token,
				});
				return c.json({
					ok: true,
					status: "pending",
					group_id: invite.group_id,
					policy: invite.policy,
					request_id: request.request_id,
				});
			}

			await store.enrollDevice(inviteGroupId, {
				deviceId,
				fingerprint,
				publicKey,
				displayName,
			});

			return c.json({
				ok: true,
				status: "enrolled",
				group_id: invite.group_id,
				policy: invite.policy,
			});
		} finally {
			await store.close();
		}
	});

	return app;
}

// ---------------------------------------------------------------------------
// Shared handler for approve/deny
// ---------------------------------------------------------------------------

async function handleJoinRequestReview(
	c: Context,
	approved: boolean,
	deps: { createStore: () => CoordinatorStore; runtime: CoordinatorRuntimeDeps },
) {
	const adminAuth = authorizeAdmin(c.req.header(ADMIN_HEADER), deps.runtime);
	if (!adminAuth.ok) return c.json({ error: adminAuth.error }, 401);

	const raw = Buffer.from(await c.req.arrayBuffer());
	if (raw.length > MAX_BODY_BYTES) return c.json({ error: "body_too_large" }, 413);

	let data: Record<string, unknown>;
	try {
		data = JSON.parse(raw.toString("utf-8"));
		if (typeof data !== "object" || data === null || Array.isArray(data)) {
			return c.json({ error: "invalid_json" }, 400);
		}
	} catch {
		return c.json({ error: "invalid_json" }, 400);
	}

	const requestId = String(data.request_id ?? "").trim();
	const reviewedBy = String(data.reviewed_by ?? "").trim() || null;

	if (!requestId) return c.json({ error: "request_id_required" }, 400);

	const store = deps.createStore();
	try {
		const request = await store.reviewJoinRequest({
			requestId,
			approved,
			reviewedBy,
		});

		if (!request) return c.json({ error: "request_not_found" }, 404);

		if (request._no_transition) {
			return c.json({ error: "request_not_pending", status: request.status }, 409);
		}

		return c.json({ ok: true, request });
	} finally {
		await store.close();
	}
}
