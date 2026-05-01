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
import type {
	CoordinatorBootstrapGrantVerification,
	CoordinatorEnrollment,
	CoordinatorScope,
	CoordinatorScopeMembership,
	CoordinatorStore,
} from "./coordinator-store-contract.js";
import {
	createInMemoryRequestRateLimiter,
	type InMemoryRequestRateLimiter,
} from "./request-rate-limit.js";
import { explainScopeMembershipRevocation } from "./scope-membership-semantics.js";
import { DEFAULT_TIME_WINDOW_S } from "./sync-auth-constants.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 64 * 1024;
const ADMIN_HEADER = "X-Codemem-Coordinator-Admin";
const DEFAULT_COORDINATOR_READ_LIMIT = 120;
const DEFAULT_COORDINATOR_MUTATION_LIMIT = 30;

export interface CoordinatorRequestRateLimitOptions {
	limiter?: InMemoryRequestRateLimiter;
	readLimit?: number;
	mutationLimit?: number;
	unauthenticatedReadLimit?: number;
	unauthenticatedMutationLimit?: number;
}

export interface CoordinatorRuntimeDeps {
	adminSecret(): string | null;
	now(): string;
}

export interface CreateCoordinatorAppOptions {
	storeFactory: () => CoordinatorStore;
	runtime: CoordinatorRuntimeDeps;
	requestVerifier: CoordinatorRequestVerifier;
	requestRateLimit?: CoordinatorRequestRateLimitOptions;
}

export interface CoordinatorVerifyRequestInput {
	method: string;
	pathWithQuery: string;
	bodyBytes: Uint8Array;
	timestamp: string;
	nonce: string;
	signature: string;
	publicKey: string;
	deviceId: string;
}

export type CoordinatorRequestVerifier = (
	input: CoordinatorVerifyRequestInput,
) => Promise<boolean> | boolean;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
	requestVerifier: CoordinatorRequestVerifier,
	opts: {
		method: string;
		url: string;
		groupId: string;
		body: Uint8Array;
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
		valid = await requestVerifier({
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
	if (!opts?.storeFactory || !opts.runtime || !opts.requestVerifier) {
		throw new Error("createCoordinatorApp requires storeFactory, runtime, and requestVerifier.");
	}
	const runtime = opts.runtime;
	const createStore = opts.storeFactory;
	const requestVerifier = opts.requestVerifier;
	const requestRateLimit = opts.requestRateLimit ?? {};
	const rateLimiter = requestRateLimit.limiter ?? createInMemoryRequestRateLimiter();
	const readLimit = Math.max(
		1,
		Math.trunc(requestRateLimit.readLimit ?? DEFAULT_COORDINATOR_READ_LIMIT),
	);
	const mutationLimit = Math.max(
		1,
		Math.trunc(requestRateLimit.mutationLimit ?? DEFAULT_COORDINATOR_MUTATION_LIMIT),
	);
	const unauthenticatedReadLimit = Math.max(
		1,
		Math.trunc(requestRateLimit.unauthenticatedReadLimit ?? Math.min(20, readLimit)),
	);
	const unauthenticatedMutationLimit = Math.max(
		1,
		Math.trunc(requestRateLimit.unauthenticatedMutationLimit ?? Math.min(10, mutationLimit)),
	);
	const app = new Hono();
	const textDecoder = new TextDecoder();

	function rateLimitedResponse(c: Context, key: string, authenticated: boolean) {
		const isRead = c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS";
		const result = rateLimiter.check(
			`${c.req.method}:${authenticated ? "auth" : "anon"}:${key}`,
			authenticated
				? isRead
					? readLimit
					: mutationLimit
				: isRead
					? unauthenticatedReadLimit
					: unauthenticatedMutationLimit,
		);
		if (result.allowed) return null;
		c.header("Retry-After", String(result.retryAfterS));
		return c.json({ error: "rate_limited", retry_after_s: result.retryAfterS }, 429);
	}

	async function readRequestBytes(c: Context): Promise<Uint8Array | null> {
		const contentLength = Number.parseInt(c.req.header("content-length") ?? "", 10);
		if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
			return null;
		}
		const stream = c.req.raw.body;
		if (!stream) return new Uint8Array();
		const reader = stream.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!value) continue;
				total += value.byteLength;
				if (total > MAX_BODY_BYTES) {
					await reader.cancel();
					return null;
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		const combined = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			combined.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return combined;
	}

	function parseJsonObject(raw: Uint8Array): Record<string, unknown> | null {
		try {
			const data: unknown = JSON.parse(textDecoder.decode(raw));
			if (typeof data !== "object" || data === null || Array.isArray(data)) {
				return null;
			}
			return data as Record<string, unknown>;
		} catch {
			return null;
		}
	}

	function optionalString(data: Record<string, unknown>, key: string): string | null {
		const value = data[key];
		if (value == null) return null;
		return String(value).trim() || null;
	}

	function optionalNumber(data: Record<string, unknown>, key: string): number | null {
		const value = data[key];
		if (value == null || value === "") return null;
		if (typeof value !== "number" && typeof value !== "string") return Number.NaN;
		if (typeof value === "string") {
			const trimmed = value.trim();
			if (!trimmed) return Number.NaN;
			const number = Number(trimmed);
			return Number.isFinite(number) ? Math.trunc(number) : Number.NaN;
		}
		const number = value;
		return Number.isFinite(number) ? Math.trunc(number) : Number.NaN;
	}

	function queryFlag(value: string | undefined | null): boolean {
		return ["1", "true", "yes"].includes(
			String(value ?? "")
				.trim()
				.toLowerCase(),
		);
	}

	async function requireActiveAdminGroup(store: CoordinatorStore, groupId: string, c: Context) {
		if (!groupId) return c.json({ error: "group_id_required" }, 400);
		const group = await store.getGroup(groupId);
		if (!group) return c.json({ error: "group_not_found" }, 404);
		if (group.archived_at) return c.json({ error: "group_archived" }, 409);
		return null;
	}

	async function findAdminScope(
		store: CoordinatorStore,
		groupId: string,
		scopeId: string,
		c: Context,
	): Promise<{ scope: CoordinatorScope | null; response: Response | null }> {
		const groupError = await requireActiveAdminGroup(store, groupId, c);
		if (groupError) return { scope: null, response: groupError };
		if (!scopeId) return { scope: null, response: c.json({ error: "scope_id_required" }, 400) };
		const matching = await store.listScopes({ groupId, includeInactive: true });
		const scope = matching.find((item) => item.scope_id === scopeId) ?? null;
		if (!scope) return { scope: null, response: c.json({ error: "scope_not_found" }, 404) };
		return { scope, response: null };
	}

	// -----------------------------------------------------------------------
	// POST /v1/presence — upsert device presence (authenticated)
	// -----------------------------------------------------------------------

	app.post("/v1/presence", async (c) => {
		const raw = await readRequestBytes(c);
		if (raw == null) {
			return c.json({ error: "body_too_large" }, 413);
		}

		const data = parseJsonObject(raw);
		if (!data) {
			return c.json({ error: "invalid_json" }, 400);
		}

		const groupId = String(data.group_id ?? "").trim();
		if (!groupId) {
			return c.json({ error: "group_id_required" }, 400);
		}

		const store = createStore();
		try {
			const auth = await authorizeRequest(store, runtime, requestVerifier, {
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
				return rateLimitedResponse(c, c.req.path, false) ?? c.json({ error: auth.error }, 401);
			}
			const limited = rateLimitedResponse(c, String(auth.enrollment.device_id), true);
			if (limited) return limited;

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
			const auth = await authorizeRequest(store, runtime, requestVerifier, {
				method: c.req.method,
				url: c.req.url,
				groupId,
				body: new Uint8Array(0),
				deviceId: c.req.header("X-Opencode-Device") ?? null,
				signature: c.req.header("X-Opencode-Signature") ?? null,
				timestamp: c.req.header("X-Opencode-Timestamp") ?? null,
				nonce: c.req.header("X-Opencode-Nonce") ?? null,
			});
			if (!auth.ok || !auth.enrollment) {
				return rateLimitedResponse(c, c.req.path, false) ?? c.json({ error: auth.error }, 401);
			}
			const limited = rateLimitedResponse(c, String(auth.enrollment.device_id), true);
			if (limited) return limited;

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
			const auth = await authorizeRequest(store, runtime, requestVerifier, {
				method: c.req.method,
				url: c.req.url,
				groupId,
				body: new Uint8Array(0),
				deviceId: c.req.header("X-Opencode-Device") ?? null,
				signature: c.req.header("X-Opencode-Signature") ?? null,
				timestamp: c.req.header("X-Opencode-Timestamp") ?? null,
				nonce: c.req.header("X-Opencode-Nonce") ?? null,
			});
			if (!auth.ok || !auth.enrollment) {
				return rateLimitedResponse(c, c.req.path, false) ?? c.json({ error: auth.error }, 401);
			}
			const limited = rateLimitedResponse(c, String(auth.enrollment.device_id), true);
			if (limited) return limited;
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
		const raw = await readRequestBytes(c);
		if (raw == null) {
			return c.json({ error: "body_too_large" }, 413);
		}

		const data = parseJsonObject(raw);
		if (!data) {
			return c.json({ error: "invalid_json" }, 400);
		}

		const groupId = String(data.group_id ?? "").trim();
		const requestedDeviceId = String(data.requested_device_id ?? "").trim();
		if (!groupId || !requestedDeviceId) {
			return c.json({ error: "group_id_and_requested_device_id_required" }, 400);
		}

		const store = createStore();
		try {
			const auth = await authorizeRequest(store, runtime, requestVerifier, {
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
				return rateLimitedResponse(c, c.req.path, false) ?? c.json({ error: auth.error }, 401);
			}
			const limited = rateLimitedResponse(c, String(auth.enrollment.device_id), true);
			if (limited) return limited;
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
		if (!adminAuth.ok)
			return rateLimitedResponse(c, c.req.path, false) ?? c.json({ error: adminAuth.error }, 401);
		const limited = rateLimitedResponse(c, "admin", true);
		if (limited) return limited;

		const raw = await readRequestBytes(c);
		if (raw == null) return c.json({ error: "body_too_large" }, 413);

		const data = parseJsonObject(raw);
		if (!data) {
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
		if (fingerprintPublicKey(publicKey) !== fingerprint) {
			return c.json({ error: "fingerprint_mismatch" }, 400);
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

	// GET /v1/admin/groups — list coordinator groups
	app.get("/v1/admin/groups", async (c) => {
		const adminAuth = authorizeAdmin(c.req.header(ADMIN_HEADER), runtime);
		if (!adminAuth.ok)
			return rateLimitedResponse(c, c.req.path, false) ?? c.json({ error: adminAuth.error }, 401);
		const limited = rateLimitedResponse(c, "admin", true);
		if (limited) return limited;

		const includeArchived = ["1", "true", "yes"].includes(
			(c.req.query("include_archived") ?? "0").trim().toLowerCase(),
		);

		const store = createStore();
		try {
			return c.json({ items: await store.listGroups(includeArchived) });
		} finally {
			await store.close();
		}
	});

	app.post("/v1/admin/groups", async (c) => {
		const adminAuth = authorizeAdmin(c.req.header(ADMIN_HEADER), runtime);
		if (!adminAuth.ok)
			return rateLimitedResponse(c, c.req.path, false) ?? c.json({ error: adminAuth.error }, 401);
		const limited = rateLimitedResponse(c, "admin", true);
		if (limited) return limited;

		const raw = await readRequestBytes(c);
		if (raw == null) return c.json({ error: "body_too_large" }, 413);
		const data = parseJsonObject(raw);
		if (!data) return c.json({ error: "invalid_json" }, 400);

		const groupId = String(data.group_id ?? "").trim();
		const displayName = String(data.display_name ?? "").trim() || null;
		if (!groupId) return c.json({ error: "group_id_required" }, 400);

		const store = createStore();
		try {
			await store.createGroup(groupId, displayName);
			return c.json({ ok: true, group: await store.getGroup(groupId) });
		} finally {
			await store.close();
		}
	});

	app.post("/v1/admin/groups/rename", async (c) => {
		const adminAuth = authorizeAdmin(c.req.header(ADMIN_HEADER), runtime);
		if (!adminAuth.ok)
			return rateLimitedResponse(c, c.req.path, false) ?? c.json({ error: adminAuth.error }, 401);
		const limited = rateLimitedResponse(c, "admin", true);
		if (limited) return limited;

		const raw = await readRequestBytes(c);
		if (raw == null) return c.json({ error: "body_too_large" }, 413);
		const data = parseJsonObject(raw);
		if (!data) return c.json({ error: "invalid_json" }, 400);

		const groupId = String(data.group_id ?? "").trim();
		const displayName = String(data.display_name ?? "").trim();
		if (!groupId || !displayName) {
			return c.json({ error: "group_id_and_display_name_required" }, 400);
		}

		const store = createStore();
		try {
			const ok = await store.renameGroup(groupId, displayName);
			if (!ok) return c.json({ error: "group_not_found" }, 404);
			return c.json({ ok: true, group: await store.getGroup(groupId) });
		} finally {
			await store.close();
		}
	});

	app.post("/v1/admin/groups/archive", async (c) => {
		const adminAuth = authorizeAdmin(c.req.header(ADMIN_HEADER), runtime);
		if (!adminAuth.ok)
			return rateLimitedResponse(c, c.req.path, false) ?? c.json({ error: adminAuth.error }, 401);
		const limited = rateLimitedResponse(c, "admin", true);
		if (limited) return limited;

		const raw = await readRequestBytes(c);
		if (raw == null) return c.json({ error: "body_too_large" }, 413);
		const data = parseJsonObject(raw);
		if (!data) return c.json({ error: "invalid_json" }, 400);

		const groupId = String(data.group_id ?? "").trim();
		if (!groupId) return c.json({ error: "group_id_required" }, 400);

		const store = createStore();
		try {
			const ok = await store.archiveGroup(groupId, runtime.now());
			if (!ok) return c.json({ error: "group_not_found_or_already_archived" }, 404);
			return c.json({ ok: true, group: await store.getGroup(groupId) });
		} finally {
			await store.close();
		}
	});

	app.post("/v1/admin/groups/unarchive", async (c) => {
		const adminAuth = authorizeAdmin(c.req.header(ADMIN_HEADER), runtime);
		if (!adminAuth.ok)
			return rateLimitedResponse(c, c.req.path, false) ?? c.json({ error: adminAuth.error }, 401);
		const limited = rateLimitedResponse(c, "admin", true);
		if (limited) return limited;

		const raw = await readRequestBytes(c);
		if (raw == null) return c.json({ error: "body_too_large" }, 413);
		const data = parseJsonObject(raw);
		if (!data) return c.json({ error: "invalid_json" }, 400);

		const groupId = String(data.group_id ?? "").trim();
		if (!groupId) return c.json({ error: "group_id_required" }, 400);

		const store = createStore();
		try {
			const ok = await store.unarchiveGroup(groupId);
			if (!ok) return c.json({ error: "group_not_found_or_not_archived" }, 404);
			return c.json({ ok: true, group: await store.getGroup(groupId) });
		} finally {
			await store.close();
		}
	});

	// GET /v1/admin/groups/:group_id/scopes — list Sharing domains for a group
	app.get("/v1/admin/groups/:group_id/scopes", async (c) => {
		const adminAuth = authorizeAdmin(c.req.header(ADMIN_HEADER), runtime);
		if (!adminAuth.ok)
			return rateLimitedResponse(c, c.req.path, false) ?? c.json({ error: adminAuth.error }, 401);
		const limited = rateLimitedResponse(c, "admin", true);
		if (limited) return limited;

		const groupId = String(c.req.param("group_id") ?? "").trim();
		const store = createStore();
		try {
			const groupError = await requireActiveAdminGroup(store, groupId, c);
			if (groupError) return groupError;
			const includeInactive = queryFlag(c.req.query("include_inactive"));
			return c.json({
				items: await store.listScopes({ groupId, includeInactive }),
			});
		} finally {
			await store.close();
		}
	});

	// POST /v1/admin/groups/:group_id/scopes — create a Sharing domain
	app.post("/v1/admin/groups/:group_id/scopes", async (c) => {
		const adminAuth = authorizeAdmin(c.req.header(ADMIN_HEADER), runtime);
		if (!adminAuth.ok)
			return rateLimitedResponse(c, c.req.path, false) ?? c.json({ error: adminAuth.error }, 401);
		const limited = rateLimitedResponse(c, "admin", true);
		if (limited) return limited;

		const raw = await readRequestBytes(c);
		if (raw == null) return c.json({ error: "body_too_large" }, 413);
		const data = parseJsonObject(raw);
		if (!data) return c.json({ error: "invalid_json" }, 400);

		const groupId = String(c.req.param("group_id") ?? "").trim();
		const scopeId = optionalString(data, "scope_id");
		const label = optionalString(data, "label");
		const membershipEpoch = optionalNumber(data, "membership_epoch");
		if (!scopeId || !label) return c.json({ error: "scope_id_and_label_required" }, 400);
		if (Number.isNaN(membershipEpoch)) {
			return c.json({ error: "membership_epoch_must_be_number" }, 400);
		}

		const store = createStore();
		try {
			const groupError = await requireActiveAdminGroup(store, groupId, c);
			if (groupError) return groupError;
			const scope = await store.createScope({
				scopeId,
				label,
				kind: optionalString(data, "kind"),
				authorityType: optionalString(data, "authority_type"),
				coordinatorId: optionalString(data, "coordinator_id"),
				groupId,
				manifestIssuerDeviceId: optionalString(data, "manifest_issuer_device_id"),
				membershipEpoch,
				manifestHash: optionalString(data, "manifest_hash"),
				status: optionalString(data, "status"),
			});
			return c.json({ ok: true, scope }, 201);
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
		} finally {
			await store.close();
		}
	});

	// PATCH /v1/admin/groups/:group_id/scopes/:scope_id — update Sharing domain metadata
	app.patch("/v1/admin/groups/:group_id/scopes/:scope_id", async (c) => {
		const adminAuth = authorizeAdmin(c.req.header(ADMIN_HEADER), runtime);
		if (!adminAuth.ok)
			return rateLimitedResponse(c, c.req.path, false) ?? c.json({ error: adminAuth.error }, 401);
		const limited = rateLimitedResponse(c, "admin", true);
		if (limited) return limited;

		const raw = await readRequestBytes(c);
		if (raw == null) return c.json({ error: "body_too_large" }, 413);
		const data = parseJsonObject(raw);
		if (!data) return c.json({ error: "invalid_json" }, 400);

		const groupId = String(c.req.param("group_id") ?? "").trim();
		const scopeId = String(c.req.param("scope_id") ?? "").trim();
		const membershipEpoch = optionalNumber(data, "membership_epoch");
		if (!scopeId) return c.json({ error: "scope_id_required" }, 400);
		if (Number.isNaN(membershipEpoch)) {
			return c.json({ error: "membership_epoch_must_be_number" }, 400);
		}

		const store = createStore();
		try {
			const lookup = await findAdminScope(store, groupId, scopeId, c);
			if (lookup.response) return lookup.response;
			const scope = await store.updateScope({
				scopeId,
				label: data.label === undefined ? undefined : optionalString(data, "label"),
				kind: data.kind === undefined ? undefined : optionalString(data, "kind"),
				authorityType:
					data.authority_type === undefined ? undefined : optionalString(data, "authority_type"),
				coordinatorId:
					data.coordinator_id === undefined ? undefined : optionalString(data, "coordinator_id"),
				groupId,
				manifestIssuerDeviceId:
					data.manifest_issuer_device_id === undefined
						? undefined
						: optionalString(data, "manifest_issuer_device_id"),
				membershipEpoch,
				manifestHash:
					data.manifest_hash === undefined ? undefined : optionalString(data, "manifest_hash"),
				status: data.status === undefined ? undefined : optionalString(data, "status"),
			});
			if (!scope) return c.json({ error: "scope_not_found" }, 404);
			return c.json({ ok: true, scope });
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
		} finally {
			await store.close();
		}
	});

	// GET /v1/admin/groups/:group_id/scopes/:scope_id/members — list explicit grants
	app.get("/v1/admin/groups/:group_id/scopes/:scope_id/members", async (c) => {
		const adminAuth = authorizeAdmin(c.req.header(ADMIN_HEADER), runtime);
		if (!adminAuth.ok)
			return rateLimitedResponse(c, c.req.path, false) ?? c.json({ error: adminAuth.error }, 401);
		const limited = rateLimitedResponse(c, "admin", true);
		if (limited) return limited;

		const groupId = String(c.req.param("group_id") ?? "").trim();
		const scopeId = String(c.req.param("scope_id") ?? "").trim();
		const store = createStore();
		try {
			const lookup = await findAdminScope(store, groupId, scopeId, c);
			if (lookup.response) return lookup.response;
			return c.json({
				items: await store.listScopeMemberships(scopeId, queryFlag(c.req.query("include_revoked"))),
			});
		} finally {
			await store.close();
		}
	});

	// POST /v1/admin/groups/:group_id/scopes/:scope_id/members — grant device access
	app.post("/v1/admin/groups/:group_id/scopes/:scope_id/members", async (c) => {
		const adminAuth = authorizeAdmin(c.req.header(ADMIN_HEADER), runtime);
		if (!adminAuth.ok)
			return rateLimitedResponse(c, c.req.path, false) ?? c.json({ error: adminAuth.error }, 401);
		const limited = rateLimitedResponse(c, "admin", true);
		if (limited) return limited;

		const raw = await readRequestBytes(c);
		if (raw == null) return c.json({ error: "body_too_large" }, 413);
		const data = parseJsonObject(raw);
		if (!data) return c.json({ error: "invalid_json" }, 400);

		const groupId = String(c.req.param("group_id") ?? "").trim();
		const scopeId = String(c.req.param("scope_id") ?? "").trim();
		const deviceId = optionalString(data, "device_id");
		const membershipEpoch = optionalNumber(data, "membership_epoch");
		if (!deviceId) return c.json({ error: "device_id_required" }, 400);
		if (Number.isNaN(membershipEpoch)) {
			return c.json({ error: "membership_epoch_must_be_number" }, 400);
		}

		const store = createStore();
		try {
			const lookup = await findAdminScope(store, groupId, scopeId, c);
			if (lookup.response) return lookup.response;
			if (lookup.scope?.status !== "active") return c.json({ error: "scope_not_active" }, 409);
			const enrollment = await store.getEnrollment(groupId, deviceId);
			if (!enrollment) return c.json({ error: "device_not_enrolled_for_scope_group" }, 404);
			const membership = await store.grantScopeMembership({
				scopeId,
				deviceId,
				role: optionalString(data, "role"),
				membershipEpoch,
				coordinatorId: optionalString(data, "coordinator_id"),
				groupId,
				manifestIssuerDeviceId: optionalString(data, "manifest_issuer_device_id"),
				manifestHash: optionalString(data, "manifest_hash"),
				signedManifestJson: optionalString(data, "signed_manifest_json"),
			});
			return c.json({ ok: true, membership }, 201);
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
		} finally {
			await store.close();
		}
	});

	// POST /v1/admin/groups/:group_id/scopes/:scope_id/members/:device_id/revoke
	app.post("/v1/admin/groups/:group_id/scopes/:scope_id/members/:device_id/revoke", async (c) => {
		const adminAuth = authorizeAdmin(c.req.header(ADMIN_HEADER), runtime);
		if (!adminAuth.ok)
			return rateLimitedResponse(c, c.req.path, false) ?? c.json({ error: adminAuth.error }, 401);
		const limited = rateLimitedResponse(c, "admin", true);
		if (limited) return limited;

		const raw = await readRequestBytes(c);
		if (raw == null) return c.json({ error: "body_too_large" }, 413);
		const data = raw.byteLength > 0 ? parseJsonObject(raw) : {};
		if (!data) return c.json({ error: "invalid_json" }, 400);

		const groupId = String(c.req.param("group_id") ?? "").trim();
		const scopeId = String(c.req.param("scope_id") ?? "").trim();
		const deviceId = String(c.req.param("device_id") ?? "").trim();
		const membershipEpoch = optionalNumber(data, "membership_epoch");
		if (!deviceId) return c.json({ error: "device_id_required" }, 400);
		if (Number.isNaN(membershipEpoch)) {
			return c.json({ error: "membership_epoch_must_be_number" }, 400);
		}

		const store = createStore();
		try {
			const lookup = await findAdminScope(store, groupId, scopeId, c);
			if (lookup.response) return lookup.response;
			const ok = await store.revokeScopeMembership({
				scopeId,
				deviceId,
				membershipEpoch,
				manifestHash: optionalString(data, "manifest_hash"),
				signedManifestJson: optionalString(data, "signed_manifest_json"),
			});
			if (!ok) return c.json({ error: "membership_not_found" }, 404);
			let revokedMembership: CoordinatorScopeMembership | undefined;
			try {
				revokedMembership = (await store.listScopeMemberships(scopeId, true)).find(
					(membership) => membership.device_id === deviceId,
				);
			} catch {
				revokedMembership = undefined;
			}
			return c.json({
				ok: true,
				scope_id: scopeId,
				device_id: deviceId,
				revocation: explainScopeMembershipRevocation({
					scopeId,
					deviceId,
					membershipEpoch: revokedMembership?.membership_epoch ?? membershipEpoch,
				}),
			});
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
		} finally {
			await store.close();
		}
	});

	// GET /v1/admin/devices — list enrolled devices
	app.get("/v1/admin/devices", async (c) => {
		const adminAuth = authorizeAdmin(c.req.header(ADMIN_HEADER), runtime);
		if (!adminAuth.ok)
			return rateLimitedResponse(c, c.req.path, false) ?? c.json({ error: adminAuth.error }, 401);
		const limited = rateLimitedResponse(c, "admin", true);
		if (limited) return limited;

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
		if (!adminAuth.ok)
			return rateLimitedResponse(c, c.req.path, false) ?? c.json({ error: adminAuth.error }, 401);
		const limited = rateLimitedResponse(c, "admin", true);
		if (limited) return limited;

		const raw = await readRequestBytes(c);
		if (raw == null) return c.json({ error: "body_too_large" }, 413);

		const data = parseJsonObject(raw);
		if (!data) {
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
			const device = await store.getEnrollment(groupId, deviceId);
			return c.json({ ok: true, device });
		} finally {
			await store.close();
		}
	});

	// POST /v1/admin/devices/disable
	app.post("/v1/admin/devices/disable", async (c) => {
		const adminAuth = authorizeAdmin(c.req.header(ADMIN_HEADER), runtime);
		if (!adminAuth.ok)
			return rateLimitedResponse(c, c.req.path, false) ?? c.json({ error: adminAuth.error }, 401);
		const limited = rateLimitedResponse(c, "admin", true);
		if (limited) return limited;

		const raw = await readRequestBytes(c);
		if (raw == null) return c.json({ error: "body_too_large" }, 413);

		const data = parseJsonObject(raw);
		if (!data) {
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

	// POST /v1/admin/devices/enable
	app.post("/v1/admin/devices/enable", async (c) => {
		const adminAuth = authorizeAdmin(c.req.header(ADMIN_HEADER), runtime);
		if (!adminAuth.ok)
			return rateLimitedResponse(c, c.req.path, false) ?? c.json({ error: adminAuth.error }, 401);
		const limited = rateLimitedResponse(c, "admin", true);
		if (limited) return limited;

		const raw = await readRequestBytes(c);
		if (raw == null) return c.json({ error: "body_too_large" }, 413);

		const data = parseJsonObject(raw);
		if (!data) {
			return c.json({ error: "invalid_json" }, 400);
		}

		const groupId = String(data.group_id ?? "").trim();
		const deviceId = String(data.device_id ?? "").trim();

		if (!groupId || !deviceId) {
			return c.json({ error: "group_id_and_device_id_required" }, 400);
		}

		const store = createStore();
		try {
			const ok = await store.setDeviceEnabled(groupId, deviceId, true);
			if (!ok) return c.json({ error: "device_not_found" }, 404);
			return c.json({ ok: true });
		} finally {
			await store.close();
		}
	});

	// POST /v1/admin/devices/remove
	app.post("/v1/admin/devices/remove", async (c) => {
		const adminAuth = authorizeAdmin(c.req.header(ADMIN_HEADER), runtime);
		if (!adminAuth.ok)
			return rateLimitedResponse(c, c.req.path, false) ?? c.json({ error: adminAuth.error }, 401);
		const limited = rateLimitedResponse(c, "admin", true);
		if (limited) return limited;

		const raw = await readRequestBytes(c);
		if (raw == null) return c.json({ error: "body_too_large" }, 413);

		const data = parseJsonObject(raw);
		if (!data) {
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
		if (!adminAuth.ok)
			return rateLimitedResponse(c, c.req.path, false) ?? c.json({ error: adminAuth.error }, 401);
		const limited = rateLimitedResponse(c, "admin", true);
		if (limited) return limited;

		const raw = await readRequestBytes(c);
		if (raw == null) return c.json({ error: "body_too_large" }, 413);

		const data = parseJsonObject(raw);
		if (!data) {
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
			if (group.archived_at) return c.json({ error: "group_archived" }, 409);

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
		if (!adminAuth.ok)
			return rateLimitedResponse(c, c.req.path, false) ?? c.json({ error: adminAuth.error }, 401);
		const limited = rateLimitedResponse(c, "admin", true);
		if (limited) return limited;

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

	app.get("/v1/admin/bootstrap-grants/:grantId", async (c) => {
		const adminAuth = authorizeAdmin(c.req.header(ADMIN_HEADER), runtime);
		if (!adminAuth.ok)
			return rateLimitedResponse(c, c.req.path, false) ?? c.json({ error: adminAuth.error }, 401);
		const limited = rateLimitedResponse(c, "admin", true);
		if (limited) return limited;

		const grantId = String(c.req.param("grantId") ?? "").trim();
		if (!grantId) return c.json({ error: "grant_id_required" }, 400);

		const store = createStore();
		try {
			const grant = await store.getBootstrapGrant(grantId);
			if (!grant) return c.json({ error: "grant_not_found" }, 404);
			const workerEnrollment = await store.getEnrollment(grant.group_id, grant.worker_device_id);
			if (!workerEnrollment) return c.json({ error: "worker_enrollment_not_found" }, 404);
			const payload: CoordinatorBootstrapGrantVerification = {
				grant,
				worker_enrollment: workerEnrollment,
			};
			return c.json(payload);
		} finally {
			await store.close();
		}
	});

	app.get("/v1/admin/bootstrap-grants", async (c) => {
		const adminAuth = authorizeAdmin(c.req.header(ADMIN_HEADER), runtime);
		if (!adminAuth.ok)
			return rateLimitedResponse(c, c.req.path, false) ?? c.json({ error: adminAuth.error }, 401);
		const limited = rateLimitedResponse(c, "admin", true);
		if (limited) return limited;

		const groupId = (c.req.query("group_id") ?? "").trim();
		if (!groupId) return c.json({ error: "group_id_required" }, 400);

		const store = createStore();
		try {
			return c.json({ items: await store.listBootstrapGrants(groupId) });
		} finally {
			await store.close();
		}
	});

	app.post("/v1/admin/bootstrap-grants/revoke", async (c) => {
		const adminAuth = authorizeAdmin(c.req.header(ADMIN_HEADER), runtime);
		if (!adminAuth.ok)
			return rateLimitedResponse(c, c.req.path, false) ?? c.json({ error: adminAuth.error }, 401);
		const limited = rateLimitedResponse(c, "admin", true);
		if (limited) return limited;

		const raw = await readRequestBytes(c);
		if (raw == null) return c.json({ error: "body_too_large" }, 413);
		const data = parseJsonObject(raw);
		if (!data) return c.json({ error: "invalid_json" }, 400);

		const grantId = String(data.grant_id ?? "").trim();
		if (!grantId) return c.json({ error: "grant_id_required" }, 400);

		const store = createStore();
		try {
			const ok = await store.revokeBootstrapGrant(grantId, runtime.now());
			if (!ok) return c.json({ error: "grant_not_found" }, 404);
			return c.json({ ok: true, grant_id: grantId });
		} finally {
			await store.close();
		}
	});

	// POST /v1/admin/join-requests/approve
	app.post("/v1/admin/join-requests/approve", async (c) => {
		return handleJoinRequestReview(c, true, { createStore, runtime, rateLimitedResponse });
	});

	// POST /v1/admin/join-requests/deny
	app.post("/v1/admin/join-requests/deny", async (c) => {
		return handleJoinRequestReview(c, false, { createStore, runtime, rateLimitedResponse });
	});

	// GET /v1/admin/join-requests — list join requests
	app.get("/v1/admin/join-requests", async (c) => {
		const adminAuth = authorizeAdmin(c.req.header(ADMIN_HEADER), runtime);
		if (!adminAuth.ok)
			return rateLimitedResponse(c, c.req.path, false) ?? c.json({ error: adminAuth.error }, 401);
		const limited = rateLimitedResponse(c, "admin", true);
		if (limited) return limited;

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
		const raw = await readRequestBytes(c);
		if (raw == null) return c.json({ error: "body_too_large" }, 413);

		const data = parseJsonObject(raw);
		if (!data) {
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
		if (fingerprintPublicKey(publicKey) !== fingerprint) {
			return c.json({ error: "fingerprint_mismatch" }, 400);
		}

		const store = createStore();
		try {
			const invite = await store.getInviteByToken(token);
			if (!invite) return c.json({ error: "invalid_token" }, 404);
			const group = await store.getGroup(String(invite.group_id));
			if (!group) return c.json({ error: "group_not_found" }, 404);
			if (group.archived_at) return c.json({ error: "group_archived" }, 409);

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
	deps: {
		createStore: () => CoordinatorStore;
		runtime: CoordinatorRuntimeDeps;
		rateLimitedResponse: (c: Context, key: string, authenticated: boolean) => Response | null;
	},
) {
	const adminAuth = authorizeAdmin(c.req.header(ADMIN_HEADER), deps.runtime);
	if (!adminAuth.ok)
		return (
			deps.rateLimitedResponse(c, c.req.path, false) ?? c.json({ error: adminAuth.error }, 401)
		);
	const limited = deps.rateLimitedResponse(c, "admin", true);
	if (limited) return limited;

	const raw = await (async () => {
		const contentLength = Number.parseInt(c.req.header("content-length") ?? "", 10);
		if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
			return null;
		}
		const stream = c.req.raw.body;
		if (!stream) return new Uint8Array();
		const reader = stream.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!value) continue;
				total += value.byteLength;
				if (total > MAX_BODY_BYTES) {
					await reader.cancel();
					return null;
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		const combined = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			combined.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return combined;
	})();
	if (raw == null) return c.json({ error: "body_too_large" }, 413);

	let data: Record<string, unknown> | null;
	try {
		const textDecoder = new TextDecoder();
		const parsed: unknown = JSON.parse(textDecoder.decode(raw));
		data =
			typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: null;
	} catch {
		data = null;
	}
	if (!data) {
		return c.json({ error: "invalid_json" }, 400);
	}

	const requestId = String(data.request_id ?? "").trim();
	const reviewedBy = String(data.reviewed_by ?? "").trim() || null;
	const bootstrapGrantSeedDeviceId = String(data.bootstrap_grant_seed_device_id ?? "").trim();
	const bootstrapGrantExpiresAt = String(data.bootstrap_grant_expires_at ?? "").trim();

	if (!requestId) return c.json({ error: "request_id_required" }, 400);
	const bootstrapGrantFields = [bootstrapGrantSeedDeviceId, bootstrapGrantExpiresAt].filter(
		Boolean,
	).length;
	if (bootstrapGrantFields > 0 && bootstrapGrantFields < 2) {
		return c.json(
			{ error: "bootstrap_grant_seed_device_id_and_expires_at_required_together" },
			400,
		);
	}

	const store = deps.createStore();
	try {
		const request = await store.reviewJoinRequest({
			requestId,
			approved,
			reviewedBy,
			bootstrapGrant:
				approved && bootstrapGrantSeedDeviceId && bootstrapGrantExpiresAt
					? {
							seedDeviceId: bootstrapGrantSeedDeviceId,
							expiresAt: bootstrapGrantExpiresAt,
							createdBy: reviewedBy,
						}
					: null,
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
