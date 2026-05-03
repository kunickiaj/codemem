/**
 * Sync routes — status, peers, actors, attempts, pairing, mutations.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import type {
	CoordinatorBootstrapGrantVerification,
	MaintenanceJobSnapshot,
	MemoryStore,
	ReplicationOp,
	SemanticIndexDiagnostics,
} from "@codemem/core";
import {
	addSyncScopeToBoundary,
	applyReplicationOps,
	buildBaseUrl,
	cleanupNonces,
	coordinatorArchiveGroupAction,
	coordinatorCreateGroupAction,
	coordinatorCreateInviteAction,
	coordinatorCreateScopeAction,
	coordinatorDisableDeviceAction,
	coordinatorEnableDeviceAction,
	coordinatorGrantScopeMembershipAction,
	coordinatorImportInviteAction,
	coordinatorListBootstrapGrantsAction,
	coordinatorListDevicesAction,
	coordinatorListGroupsAction,
	coordinatorListJoinRequestsAction,
	coordinatorListScopeMembershipsAction,
	coordinatorListScopesAction,
	coordinatorRemoveDeviceAction,
	coordinatorRenameDeviceAction,
	coordinatorRenameGroupAction,
	coordinatorReviewJoinRequestAction,
	coordinatorRevokeBootstrapGrantAction,
	coordinatorRevokeScopeMembershipAction,
	coordinatorStatusSnapshot,
	coordinatorUnarchiveGroupAction,
	coordinatorUpdateScopeAction,
	createCoordinatorReciprocalApproval,
	DEFAULT_TIME_WINDOW_S,
	ensureDeviceIdentity,
	extractReplicationOps,
	fingerprintPublicKey,
	getCoordinatorGroupPreference,
	getSemanticIndexDiagnostics,
	getSyncResetState,
	LOCAL_SYNC_CAPABILITY,
	listCoordinatorJoinRequests,
	listMaintenanceJobs,
	loadMemorySnapshotPageForPeer,
	loadReplicationOpsForPeer,
	lookupCoordinatorPeers,
	mergeAddresses,
	parseSyncScopeRequest,
	readCoordinatorSyncConfig,
	recordNonce,
	requestJson,
	runSyncPass,
	SYNC_SCOPE_QUERY_PARAM,
	schema,
	syncProjectAllowedByFilters,
	syncScopeResetRequiredPayload,
	syncVisibilityAllowed,
	updatePeerAddresses,
	upsertCoordinatorGroupPreference,
	verifySignature,
} from "@codemem/core";
import { and, count, desc, eq, max, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { type Context, Hono } from "hono";
import { queryBool, queryInt, safeJsonList } from "../helpers.js";
import type { InMemoryRequestRateLimiter } from "../request-rate-limit.js";

type StoreFactory = () => MemoryStore;
type SyncRuntimeStatus = {
	phase:
		| "starting"
		| "running"
		| "stopping"
		| "error"
		| "disabled"
		| "rebootstrapping"
		| "needs_attention"
		| null;
	detail?: string | null;
};

interface SyncProtocolRouteOptions {
	routeRateLimit?: {
		limiter: InMemoryRequestRateLimiter;
		readLimit: number;
		mutationLimit: number;
		unauthenticatedReadLimit: number;
		unauthenticatedMutationLimit: number;
	};
}

const SYNC_STALE_AFTER_SECONDS = 10 * 60;
const SYNC_PROTOCOL_VERSION = "2";
const LEGACY_SYNC_ACTOR_DISPLAY_NAME = "Legacy synced peer";
const LEGACY_SHARED_WORKSPACE_ID = "shared:legacy";

/**
 * Attempt to decode a pasted string as a device-pairing payload.
 *
 * Returns:
 *   - `{ kind: "pair", ... }` when the payload base64-decodes to JSON with
 *     the expected pairing shape AND the fingerprint matches the public
 *     key.
 *   - `{ kind: "invalid-pair", error }` when the payload looked like a
 *     pairing payload but failed validation — the caller should 400 this
 *     rather than falling back to coordinator-invite handling.
 *   - `null` when the string is not a pairing payload at all.
 */
function tryParsePairingPayload(value: string):
	| {
			kind: "pair";
			device_id: string;
			fingerprint: string;
			public_key: string;
			addresses: string[];
	  }
	| { kind: "invalid-pair"; error: string }
	| null {
	// Accept both shapes the CLI can emit:
	//   - raw JSON (`codemem sync pair --payload-only`)
	//   - base64-encoded JSON (the inner blob inside the shell pipe wrapper)
	let parsed: Record<string, unknown>;
	if (value.trimStart().startsWith("{")) {
		try {
			parsed = JSON.parse(value) as Record<string, unknown>;
		} catch {
			return null;
		}
	} else {
		let decoded: string;
		try {
			decoded = Buffer.from(value, "base64").toString("utf8");
		} catch {
			return null;
		}
		if (!decoded?.trimStart().startsWith("{")) return null;
		try {
			parsed = JSON.parse(decoded) as Record<string, unknown>;
		} catch {
			return null;
		}
	}
	const deviceId = String(parsed.device_id ?? "").trim();
	const fingerprint = String(parsed.fingerprint ?? "").trim();
	const publicKey = String(parsed.public_key ?? "").trim();
	// If the JSON doesn't carry any of the pairing discriminators, treat
	// it as a different kind of payload (e.g. a coordinator invite happened
	// to be JSON-encoded directly). Let the caller keep trying.
	if (!deviceId && !fingerprint && !publicKey) return null;
	const rawAddresses = Array.isArray(parsed.addresses) ? parsed.addresses : [];
	const addresses = rawAddresses
		.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		.map((item) => item.trim());
	if (!deviceId || !fingerprint || !publicKey || addresses.length === 0) {
		return {
			kind: "invalid-pair",
			error: "Pairing payload missing device_id, fingerprint, public_key, or addresses",
		};
	}
	if (fingerprintPublicKey(publicKey) !== fingerprint) {
		return { kind: "invalid-pair", error: "Pairing payload fingerprint mismatch" };
	}
	return {
		kind: "pair",
		device_id: deviceId,
		fingerprint,
		public_key: publicKey,
		addresses,
	};
}

type CoordinatorAdminReadiness = "not_configured" | "partial" | "ready";

function coordinatorAdminStatusPayload(config = readCoordinatorSyncConfig()) {
	const groups = config.syncCoordinatorGroups;
	const activeGroup = groups[0] ?? null;
	const hasUrl = Boolean(config.syncCoordinatorUrl);
	const hasGroups = groups.length > 0;
	const hasAdminSecret = Boolean(config.syncCoordinatorAdminSecret);
	let readiness: CoordinatorAdminReadiness = "ready";
	if (!hasUrl) readiness = "not_configured";
	else if (!hasGroups || !hasAdminSecret) readiness = "partial";
	return {
		readiness,
		coordinator_url: config.syncCoordinatorUrl || null,
		groups,
		active_group: activeGroup,
		has_admin_secret: hasAdminSecret,
		has_groups: hasGroups,
	};
}

function coordinatorAdminUnavailable(status: ReturnType<typeof coordinatorAdminStatusPayload>): {
	body: Record<string, unknown>;
	httpStatus: 400;
} | null {
	if (status.readiness === "not_configured") {
		return { body: { error: "coordinator_not_configured", status }, httpStatus: 400 };
	}
	if (!status.has_admin_secret) {
		return { body: { error: "coordinator_admin_secret_missing", status }, httpStatus: 400 };
	}
	return null;
}

async function parseViewerJsonBody(
	c: Context,
	options: { allowEmpty?: boolean } = {},
): Promise<Record<string, unknown> | null> {
	const raw = await c.req.text();
	if (!raw.trim()) return options.allowEmpty ? {} : null;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

function optionalViewerString(body: Record<string, unknown>, key: string): string | null {
	const value = body[key];
	if (value == null) return null;
	return String(value).trim() || null;
}

function optionalViewerNumber(body: Record<string, unknown>, key: string): number | null {
	const value = body[key];
	if (value == null || value === "") return null;
	const number = typeof value === "number" ? value : Number(value);
	return Number.isFinite(number) ? Math.trunc(number) : Number.NaN;
}

function coordinatorAdminMutationStatus(message: string): 400 | 404 | 409 | 502 {
	if (
		message.includes("scope_not_found") ||
		message.includes("membership_not_found") ||
		message.includes("group_not_found") ||
		message.includes("Group not found") ||
		message.includes("Scope not found") ||
		message.includes("device_not_enrolled_for_scope_group") ||
		message.includes("device must be enrolled")
	) {
		return 404;
	}
	if (
		message.includes("not active") ||
		message.includes("scope_not_active") ||
		message.includes("group_archived") ||
		message.includes("Group is archived")
	) {
		return 409;
	}
	if (
		message.includes("Remote coordinator request failed (5") ||
		message.includes("fetch failed") ||
		message.includes("network") ||
		message.includes("timed out")
	) {
		return 502;
	}
	return 400;
}

function pairingAdvertiseAddresses(config = readCoordinatorSyncConfig()): string[] {
	const advertise = String(config.syncAdvertise || "auto")
		.trim()
		.toLowerCase();
	if (advertise && advertise !== "auto" && advertise !== "default") {
		return mergeAddresses(
			[],
			String(config.syncAdvertise || "")
				.split(",")
				.map((item) => item.trim())
				.filter(Boolean),
		);
	}
	if (config.syncHost && config.syncHost !== "0.0.0.0") {
		return [`${config.syncHost}:${config.syncPort}`];
	}
	const addresses = Object.values(networkInterfaces())
		.flatMap((entries) => entries ?? [])
		.filter((entry) => !entry.internal)
		.map((entry) => entry.address)
		.filter((address) => address && address !== "127.0.0.1" && address !== "::1")
		.map((address) => `${address}:${config.syncPort}`);
	return [...new Set(addresses)];
}

function resolveCoordinatorAdminGroup(
	requestedGroup: string | null | undefined,
	status: ReturnType<typeof coordinatorAdminStatusPayload>,
): string | null {
	const explicit = String(requestedGroup ?? "").trim();
	if (explicit) return explicit;
	return status.active_group;
}

function parseInviteTtlHours(value: unknown): number | null {
	const ttlHours = Number(String(value ?? 24));
	if (!Number.isInteger(ttlHours) || ttlHours < 1) return null;
	return ttlHours;
}

function sortActiveMaintenanceJobs<
	T extends { started_at: string | null; updated_at: string; kind: string },
>(jobs: T[]): T[] {
	return [...jobs].sort((a, b) => {
		const aTime = a.started_at ?? a.updated_at;
		const bTime = b.started_at ?? b.updated_at;
		if (aTime !== bTime) return aTime.localeCompare(bTime);
		return a.kind.localeCompare(b.kind);
	});
}

function summarizeMaintenanceJobs(
	jobs: MaintenanceJobSnapshot[],
	showDiagnostics: boolean,
): Array<Record<string, unknown>> {
	return sortActiveMaintenanceJobs(
		jobs.filter((job) => ["pending", "running", "failed"].includes(String(job.status ?? ""))),
	).map((job) => ({
		kind: job.kind,
		title: job.title,
		status: job.status,
		progress: job.progress,
		...(showDiagnostics
			? {
					message: job.message,
					error: job.error,
					metadata: job.metadata,
				}
			: {}),
	}));
}

function redactSemanticIndexDiagnostics(
	diagnostics: SemanticIndexDiagnostics,
	showDiagnostics: boolean,
): SemanticIndexDiagnostics {
	if (showDiagnostics || !diagnostics.maintenance_job) {
		return diagnostics;
	}
	const summary =
		diagnostics.state === "pending"
			? "Semantic-index catch-up is pending"
			: diagnostics.state === "failed"
				? "Semantic-index catch-up failed"
				: diagnostics.state === "degraded"
					? "Semantic index is running in degraded mode"
					: diagnostics.summary;
	return {
		...diagnostics,
		summary,
		maintenance_job: {
			...diagnostics.maintenance_job,
			message: null,
			error: null,
		},
	};
}

function syncKeysDir(): string | undefined {
	return process.env.CODEMEM_KEYS_DIR?.trim() || undefined;
}

function intEnvOr(name: string, fallback: number): number {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(value) ? value : fallback;
}

const MAX_SYNC_BODY_BYTES = intEnvOr("CODEMEM_SYNC_MAX_BODY_BYTES", 1_048_576);
const MAX_SYNC_OPS = intEnvOr("CODEMEM_SYNC_MAX_OPS", 2000);

async function readBoundedRequestBytes(request: Request, maxBytes: number): Promise<Buffer | null> {
	const contentLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
	if (Number.isFinite(contentLength) && contentLength > maxBytes) {
		return null;
	}
	const stream = request.body;
	if (!stream) return Buffer.alloc(0);
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

const PAIRING_FILTER_HINT =
	"Run this on another device with codemem sync pair --accept '<payload>'. " +
	"On the accepting device, --include/--exclude control both what it sends and what it accepts from that peer.";

function pathWithQuery(url: string): string {
	const parsed = new URL(url);
	return parsed.search ? `${parsed.pathname}${parsed.search}` : parsed.pathname;
}

function unauthorizedPayload(reason: string, exposeReason = false): Record<string, string> {
	if (exposeReason && process.env.CODEMEM_SYNC_AUTH_DIAGNOSTICS === "1") {
		return { error: "unauthorized", reason };
	}
	return { error: "unauthorized" };
}

function authorizeSyncRequest(
	store: MemoryStore,
	request: { method: string; url: string; header(name: string): string | undefined },
	body: Buffer,
): { ok: boolean; reason: string; deviceId: string } {
	const deviceId = (request.header("X-Opencode-Device") ?? "").trim();
	const signature = request.header("X-Opencode-Signature") ?? "";
	const timestamp = request.header("X-Opencode-Timestamp") ?? "";
	const nonce = request.header("X-Opencode-Nonce") ?? "";
	if (!deviceId || !signature || !timestamp || !nonce) {
		return { ok: false, reason: "missing_headers", deviceId };
	}

	const peerRow = store.db
		.prepare(
			"SELECT pinned_fingerprint, public_key FROM sync_peers WHERE peer_device_id = ? LIMIT 1",
		)
		.get(deviceId) as { pinned_fingerprint: string | null; public_key: string | null } | undefined;
	if (!peerRow) {
		return { ok: false, reason: "unknown_peer", deviceId };
	}

	const pinnedFingerprint = String(peerRow.pinned_fingerprint ?? "").trim();
	const publicKey = String(peerRow.public_key ?? "").trim();
	if (!pinnedFingerprint || !publicKey) {
		return { ok: false, reason: "peer_record_incomplete", deviceId };
	}
	if (fingerprintPublicKey(publicKey) !== pinnedFingerprint) {
		return { ok: false, reason: "fingerprint_mismatch", deviceId };
	}

	let valid = false;
	try {
		valid = verifySignature({
			method: request.method,
			pathWithQuery: pathWithQuery(request.url),
			bodyBytes: body,
			timestamp,
			nonce,
			signature,
			publicKey,
			deviceId,
		});
	} catch {
		return { ok: false, reason: "signature_verification_error", deviceId };
	}

	if (!valid) {
		return { ok: false, reason: "invalid_signature", deviceId };
	}

	const createdAt = new Date().toISOString();
	if (!recordNonce(store.db, deviceId, nonce, createdAt)) {
		return { ok: false, reason: "nonce_replay", deviceId };
	}

	const cutoff = new Date(Date.now() - DEFAULT_TIME_WINDOW_S * 2 * 1000).toISOString();
	cleanupNonces(store.db, cutoff);
	return { ok: true, reason: "ok", deviceId };
}

async function authorizeBootstrapGrantRequest(
	store: MemoryStore,
	request: { method: string; url: string; header(name: string): string | undefined },
	body: Buffer,
): Promise<{ ok: boolean; reason: string; deviceId: string }> {
	const grantId = (request.header("X-Codemem-Bootstrap-Grant") ?? "").trim();
	const deviceId = (request.header("X-Opencode-Device") ?? "").trim();
	const signature = request.header("X-Opencode-Signature") ?? "";
	const timestamp = request.header("X-Opencode-Timestamp") ?? "";
	const nonce = request.header("X-Opencode-Nonce") ?? "";
	if (!grantId || !deviceId || !signature || !timestamp || !nonce) {
		return { ok: false, reason: "missing_bootstrap_grant_headers", deviceId };
	}

	const config = readCoordinatorSyncConfig();
	if (!config.syncCoordinatorUrl || !config.syncCoordinatorAdminSecret) {
		return { ok: false, reason: "bootstrap_grant_coordinator_not_configured", deviceId };
	}

	const [localDeviceId] = ensureDeviceIdentity(store.db, { keysDir: syncKeysDir() });
	let verification: CoordinatorBootstrapGrantVerification;
	try {
		const [status, payload] = await requestJson(
			"GET",
			`${buildBaseUrl(config.syncCoordinatorUrl)}/v1/admin/bootstrap-grants/${encodeURIComponent(grantId)}`,
			{
				headers: { "X-Codemem-Coordinator-Admin": config.syncCoordinatorAdminSecret },
				timeoutS: Math.max(1, config.syncCoordinatorTimeoutS),
			},
		);
		if (status !== 200 || !payload) {
			return { ok: false, reason: "bootstrap_grant_lookup_failed", deviceId };
		}
		verification = payload as unknown as CoordinatorBootstrapGrantVerification;
	} catch {
		return { ok: false, reason: "bootstrap_grant_lookup_failed", deviceId };
	}

	const grant = verification.grant;
	const workerEnrollment = verification.worker_enrollment;
	if (!grant || !workerEnrollment) {
		return { ok: false, reason: "bootstrap_grant_invalid_payload", deviceId };
	}
	if (grant.revoked_at) return { ok: false, reason: "bootstrap_grant_revoked", deviceId };
	if (String(workerEnrollment.device_id) !== String(grant.worker_device_id)) {
		return { ok: false, reason: "bootstrap_grant_worker_enrollment_mismatch", deviceId };
	}
	if (String(workerEnrollment.group_id) !== String(grant.group_id)) {
		return { ok: false, reason: "bootstrap_grant_group_mismatch", deviceId };
	}
	if (Number(workerEnrollment.enabled) !== 1) {
		return { ok: false, reason: "bootstrap_grant_worker_disabled", deviceId };
	}
	if (grant.worker_device_id !== deviceId) {
		return { ok: false, reason: "bootstrap_grant_worker_mismatch", deviceId };
	}
	if (grant.seed_device_id !== localDeviceId) {
		return { ok: false, reason: "bootstrap_grant_seed_mismatch", deviceId };
	}
	if (new Date(grant.expires_at) <= new Date()) {
		return { ok: false, reason: "bootstrap_grant_expired", deviceId };
	}

	let valid = false;
	try {
		valid = verifySignature({
			method: request.method,
			pathWithQuery: pathWithQuery(request.url),
			bodyBytes: body,
			timestamp,
			nonce,
			signature,
			publicKey: String(workerEnrollment.public_key),
			deviceId,
		});
	} catch {
		return { ok: false, reason: "bootstrap_grant_signature_verification_error", deviceId };
	}
	if (!valid) {
		return { ok: false, reason: "bootstrap_grant_invalid_signature", deviceId };
	}

	const createdAt = new Date().toISOString();
	if (!recordNonce(store.db, deviceId, nonce, createdAt)) {
		return { ok: false, reason: "nonce_replay", deviceId };
	}
	const cutoff = new Date(Date.now() - DEFAULT_TIME_WINDOW_S * 2 * 1000).toISOString();
	cleanupNonces(store.db, cutoff);
	return { ok: true, reason: "ok", deviceId };
}

function parseJsonList(value: unknown): string[] {
	if (value == null) return [];
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value) as unknown;
			if (!Array.isArray(parsed)) return [];
			return parsed.map((entry) => String(entry ?? "").trim()).filter(Boolean);
		} catch {
			return [];
		}
	}
	if (!Array.isArray(value)) return [];
	return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
}

function readPeerProjectFilters(
	store: MemoryStore,
	peerDeviceId: string,
): { include: string[]; exclude: string[] } {
	const globalConfig = readCoordinatorSyncConfig();
	const row = store.db
		.prepare(
			"SELECT projects_include_json, projects_exclude_json FROM sync_peers WHERE peer_device_id = ? LIMIT 1",
		)
		.get(peerDeviceId) as
		| { projects_include_json: string | null; projects_exclude_json: string | null }
		| undefined;
	if (!row) {
		return {
			include: globalConfig.syncProjectsInclude,
			exclude: globalConfig.syncProjectsExclude,
		};
	}
	const hasOverride = row.projects_include_json != null || row.projects_exclude_json != null;
	if (!hasOverride) {
		return {
			include: globalConfig.syncProjectsInclude,
			exclude: globalConfig.syncProjectsExclude,
		};
	}
	return {
		include: parseJsonList(row.projects_include_json),
		exclude: parseJsonList(row.projects_exclude_json),
	};
}

function currentProjectScope(
	row: Record<string, unknown>,
	effective?: { include: string[]; exclude: string[] },
): Record<string, unknown> {
	return {
		include: safeJsonList(row.projects_include_json as string | null),
		exclude: safeJsonList(row.projects_exclude_json as string | null),
		effective_include:
			effective?.include ?? safeJsonList(row.projects_include_json as string | null),
		effective_exclude:
			effective?.exclude ?? safeJsonList(row.projects_exclude_json as string | null),
		inherits_global: row.projects_include_json == null && row.projects_exclude_json == null,
	};
}

function ensureLocalActorRecord(store: MemoryStore): void {
	const d = drizzle(store.db, { schema });
	const existing = d
		.select({ actor_id: schema.actors.actor_id })
		.from(schema.actors)
		.where(eq(schema.actors.actor_id, store.actorId))
		.get();
	if (existing) return;
	const now = new Date().toISOString();
	d.insert(schema.actors)
		.values({
			actor_id: store.actorId,
			display_name: store.actorDisplayName,
			is_local: 1,
			status: "active",
			merged_into_actor_id: null,
			created_at: now,
			updated_at: now,
		})
		.run();
}

function findPeerDeviceIdForAddress(store: MemoryStore, address: string): string | null {
	const rows = store.db
		.prepare("SELECT peer_device_id, addresses_json FROM sync_peers")
		.all() as Array<{ peer_device_id: string; addresses_json: string | null }>;
	for (const row of rows) {
		const addresses = safeJsonList(row.addresses_json);
		if (addresses.includes(address)) return String(row.peer_device_id ?? "").trim() || null;
	}
	return null;
}

function claimLegacyDeviceAsSelf(store: MemoryStore, originDeviceId: string): number {
	const deviceId = String(originDeviceId || "").trim();
	if (!deviceId || deviceId === "unknown" || deviceId === store.deviceId) return 0;
	const personalWorkspaceId = `personal:${store.actorId}`;
	const result = store.db
		.prepare(
			`UPDATE memory_items
			 SET actor_id = ?,
			     actor_display_name = ?,
			     visibility = 'private',
			     workspace_id = ?,
			     workspace_kind = 'personal',
			     trust_state = 'trusted'
			 WHERE origin_device_id = ?
			   AND origin_device_id NOT IN (
			         SELECT peer_device_id FROM sync_peers WHERE peer_device_id IS NOT NULL
			   )
			   AND (
			         (
			             actor_id IS NULL
			          OR TRIM(actor_id) = ''
			          OR actor_id LIKE 'legacy-sync:%'
			          OR actor_id = ?
			         )
			     AND (
			             actor_id IS NULL
			          OR TRIM(actor_id) = ''
			          OR actor_id LIKE 'legacy-sync:%'
			          OR actor_display_name = ?
			          OR workspace_id = ?
			          OR trust_state = 'legacy_unknown'
			         )
			     )`,
		)
		.run(
			store.actorId,
			store.actorDisplayName,
			personalWorkspaceId,
			deviceId,
			store.actorId,
			LEGACY_SYNC_ACTOR_DISPLAY_NAME,
			LEGACY_SHARED_WORKSPACE_ID,
		);
	return Number(result.changes ?? 0);
}

function peerClaimedLocalActor(store: MemoryStore, peerDeviceId: string): boolean {
	const row = store.db
		.prepare("SELECT claimed_local_actor FROM sync_peers WHERE peer_device_id = ? LIMIT 1")
		.get(peerDeviceId) as { claimed_local_actor: number | null } | undefined;
	return Boolean(row?.claimed_local_actor);
}

function parseOpPayload(op: { payload_json: string | null }): Record<string, unknown> | null {
	if (!op.payload_json || !String(op.payload_json).trim()) return null;
	try {
		const parsed = JSON.parse(op.payload_json) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

function redactCoordinatorStatus(
	coordinator: Record<string, unknown>,
	showDiag: boolean,
): Record<string, unknown> {
	if (showDiag) return coordinator;
	const discovered = Array.isArray(coordinator.discovered_devices)
		? coordinator.discovered_devices.map((item) => {
				if (!item || typeof item !== "object") return item;
				const record = item as Record<string, unknown>;
				return {
					device_id: record.device_id,
					display_name: record.display_name ?? null,
					groups: Array.isArray(record.groups) ? record.groups : [],
					last_seen_at: record.last_seen_at ?? null,
					expires_at: record.expires_at ?? null,
					stale: Boolean(record.stale),
					needs_local_approval: Boolean(record.needs_local_approval),
					waiting_for_peer_approval: Boolean(record.waiting_for_peer_approval),
					incoming_reciprocal_request_id: record.incoming_reciprocal_request_id ?? null,
					outgoing_reciprocal_request_id: record.outgoing_reciprocal_request_id ?? null,
					fingerprint: null,
					addresses: [],
				};
			})
		: [];
	return {
		...coordinator,
		discovered_devices: discovered,
	};
}

interface AcceptDiscoveredPeerOptions {
	peerDeviceId: string;
	fingerprint: string;
	// Optional per-peer scope override. When undefined the group's scope
	// template is applied if auto_seed_scope is enabled; otherwise the peer
	// is enrolled with no scope filters.
	// Per-field: `undefined` = "inherit from template", `null` = "explicit empty",
	// `string[]` = "use this list". This avoids silently wiping the template's
	// exclude list when the caller only overrides include (or vice versa).
	scopeOverride?: {
		projects_include?: string[] | null;
		projects_exclude?: string[] | null;
	};
	// When provided and the caller is the admin-groups endpoint, this group
	// must be one of the match's coordinator groups. When undefined (legacy
	// /api/sync/peers/accept-discovered path) the match must belong to
	// exactly one group and that one is used.
	expectedGroupId?: string;
}

async function acceptDiscoveredPeer(
	store: MemoryStore,
	input: AcceptDiscoveredPeerOptions,
): Promise<
	| {
			ok: true;
			peer_device_id: string;
			created: boolean;
			updated: boolean;
			name: string | null;
			group_id: string;
	  }
	| { ok: false; status: number; error: string; detail: string }
> {
	const config = readCoordinatorSyncConfig();
	if (
		!config.syncEnabled ||
		!config.syncCoordinatorUrl ||
		config.syncCoordinatorGroups.length === 0
	) {
		return {
			ok: false,
			status: 400,
			error: "coordinator_not_configured",
			detail: "Coordinator must be configured before accepting discovered peers.",
		};
	}
	const discovered = await lookupCoordinatorPeers(store, config);
	const match = discovered.find(
		(peer) =>
			String(peer.device_id ?? "").trim() === input.peerDeviceId &&
			String(peer.fingerprint ?? "").trim() === input.fingerprint,
	);
	if (!match) {
		return {
			ok: false,
			status: 404,
			error: "discovered_peer_not_found",
			detail: "That discovered device is no longer available. Refresh sync status and try again.",
		};
	}
	const nextFingerprint = String(match.fingerprint ?? "").trim();
	const nextPublicKey = String(match.public_key ?? "").trim();
	const nextName = String(match.display_name ?? "").trim() || null;
	const nextAddresses = Array.isArray(match.addresses)
		? match.addresses.filter((value): value is string => typeof value === "string")
		: [];
	if (!nextPublicKey) {
		return {
			ok: false,
			status: 409,
			error: "discovered_peer_missing_public_key",
			detail:
				"This discovered device is missing its coordinator public key. Refresh sync status and try again.",
		};
	}

	const groupIds = Array.isArray(match.groups)
		? match.groups.map((value) => String(value ?? "").trim()).filter(Boolean)
		: [];
	let groupId: string;
	if (input.expectedGroupId) {
		if (!groupIds.includes(input.expectedGroupId)) {
			return {
				ok: false,
				status: 409,
				error: "peer_not_in_group",
				detail:
					"This discovered device is not visible through the specified coordinator group. Refresh sync status and try again.",
			};
		}
		groupId = input.expectedGroupId;
	} else {
		if (groupIds.length !== 1) {
			return {
				ok: false,
				status: 409,
				error: "ambiguous_coordinator_group",
				detail:
					groupIds.length > 1
						? "This device is visible through multiple coordinator groups. Review the team setup before approving it here."
						: "This device is missing coordinator group context. Refresh sync status and try again.",
			};
		}
		groupId = groupIds[0] as string;
	}
	const d = drizzle(store.db, { schema });
	const existing = d
		.select({
			peer_device_id: schema.syncPeers.peer_device_id,
			pinned_fingerprint: schema.syncPeers.pinned_fingerprint,
			public_key: schema.syncPeers.public_key,
			addresses_json: schema.syncPeers.addresses_json,
			discovered_via_group_id: schema.syncPeers.discovered_via_group_id,
		})
		.from(schema.syncPeers)
		.where(eq(schema.syncPeers.peer_device_id, input.peerDeviceId))
		.get();
	const existingFingerprint = String(existing?.pinned_fingerprint ?? "").trim();
	if (existing && existingFingerprint && existingFingerprint !== nextFingerprint) {
		return {
			ok: false as const,
			status: 409,
			error: "peer_conflict",
			detail:
				"An existing peer with this device id is pinned to a different fingerprint. Remove or repair the old peer before accepting this discovered device.",
		};
	}
	const existingAddresses = (() => {
		try {
			const raw = JSON.parse(String(existing?.addresses_json ?? "[]"));
			return Array.isArray(raw)
				? raw.filter((value): value is string => typeof value === "string")
				: [];
		} catch {
			return [];
		}
	})();
	const addressesJson = JSON.stringify(mergeAddresses(existingAddresses, nextAddresses));
	await createCoordinatorReciprocalApproval(store, config, {
		groupId,
		requestedDeviceId: input.peerDeviceId,
	});

	// Resolve project-scope seed. On first enrollment (no existing row), apply
	// the group's scope template if auto_seed_scope is enabled. Per-field
	// overrides fall back to the template when undefined, so passing only
	// `projects_include` does not silently wipe the template's exclude list.
	// Existing peers are not re-scoped — the template is a seed, not a live link.
	const coordinatorUrl = config.syncCoordinatorUrl || null;
	let scopeInclude: string | null | undefined;
	let scopeExclude: string | null | undefined;
	if (!existing) {
		let templateInclude: string[] | null = null;
		let templateExclude: string[] | null = null;
		if (coordinatorUrl) {
			const prefs = getCoordinatorGroupPreference(store.db, coordinatorUrl, groupId);
			if (prefs?.auto_seed_scope) {
				templateInclude = prefs.projects_include ?? null;
				templateExclude = prefs.projects_exclude ?? null;
			}
		}
		const overrideInclude = input.scopeOverride?.projects_include;
		const overrideExclude = input.scopeOverride?.projects_exclude;
		const resolvedInclude = overrideInclude === undefined ? templateInclude : overrideInclude;
		const resolvedExclude = overrideExclude === undefined ? templateExclude : overrideExclude;
		scopeInclude = resolvedInclude ? JSON.stringify(resolvedInclude) : null;
		scopeExclude = resolvedExclude ? JSON.stringify(resolvedExclude) : null;
	}

	const now = new Date().toISOString();
	const result = store.db.transaction(() => {
		if (!existing) {
			d.insert(schema.syncPeers)
				.values({
					peer_device_id: input.peerDeviceId,
					name: nextName,
					pinned_fingerprint: nextFingerprint || null,
					public_key: nextPublicKey,
					addresses_json: addressesJson,
					projects_include_json: scopeInclude ?? null,
					projects_exclude_json: scopeExclude ?? null,
					created_at: now,
					last_seen_at: now,
					discovered_via_coordinator_id: coordinatorUrl,
					discovered_via_group_id: groupId,
				})
				.run();
			return {
				ok: true as const,
				peer_device_id: input.peerDeviceId,
				created: true,
				updated: false,
				name: nextName,
				group_id: groupId,
			};
		}
		d.update(schema.syncPeers)
			.set({
				name: nextName,
				pinned_fingerprint: nextFingerprint || existing.pinned_fingerprint || null,
				public_key: nextPublicKey || existing.public_key || null,
				addresses_json: addressesJson,
				last_seen_at: now,
				// Backfill group-discovery attribution on existing rows if we know
				// it now and it wasn't stamped before. Don't overwrite a non-null
				// group reference — that would silently move the peer between
				// teams and invalidate any template-seeded scope.
				...((existing as { discovered_via_group_id?: string | null }).discovered_via_group_id
					? {}
					: { discovered_via_group_id: groupId, discovered_via_coordinator_id: coordinatorUrl }),
			})
			.where(eq(schema.syncPeers.peer_device_id, input.peerDeviceId))
			.run();
		return {
			ok: true as const,
			peer_device_id: input.peerDeviceId,
			created: false,
			updated: true,
			name: nextName,
			group_id: groupId,
		};
	})();
	return result;
}

function filterOpsForPeer(
	store: MemoryStore,
	peerDeviceId: string,
	ops: ReplicationOp[],
): { allowed: ReplicationOp[]; skipped: number } {
	const filters = readPeerProjectFilters(store, peerDeviceId);
	const allowPrivate = peerClaimedLocalActor(store, peerDeviceId);
	const allowed: ReplicationOp[] = [];
	let skipped = 0;
	for (const op of ops) {
		if (op.entity_type !== "memory_item") {
			allowed.push(op);
			continue;
		}
		const payload = parseOpPayload(op);
		if (!allowPrivate && !syncVisibilityAllowed(payload)) {
			skipped++;
			continue;
		}
		const project = payload && typeof payload.project === "string" ? payload.project : null;
		if (!syncProjectAllowedByFilters(project, filters)) {
			skipped++;
			continue;
		}
		allowed.push(op);
	}
	return { allowed, skipped };
}

// ---------------------------------------------------------------------------
// Peer row mapping — deduplicated helper (fix #4)
// ---------------------------------------------------------------------------

/**
 * Map a raw sync_peers DB row to the API response shape.
 * When showDiag is false, sensitive fields (fingerprint, last_error, addresses)
 * are redacted.
 */
function mapPeerRow(
	store: MemoryStore,
	row: Record<string, unknown>,
	showDiag: boolean,
	recentOpsByPeer?: Map<string, { in: number; out: number }>,
): Record<string, unknown> {
	const peerId = String(row.peer_device_id ?? "");
	const recentOps = recentOpsByPeer?.get(peerId) ?? { in: 0, out: 0 };
	return {
		peer_device_id: row.peer_device_id,
		name: row.name,
		fingerprint: showDiag ? row.pinned_fingerprint : null,
		pinned: Boolean(row.pinned_fingerprint),
		addresses: showDiag ? safeJsonList(row.addresses_json as string | null) : [],
		last_seen_at: row.last_seen_at,
		last_sync_at: row.last_sync_at,
		last_error: showDiag ? row.last_error : null,
		has_error: Boolean(row.last_error),
		claimed_local_actor: Boolean(row.claimed_local_actor),
		actor_id: row.actor_id ?? null,
		actor_display_name: row.actor_display_name ?? null,
		project_scope: {
			...currentProjectScope(row, readPeerProjectFilters(store, String(row.peer_device_id ?? ""))),
		},
		recent_ops: { in: recentOps.in, out: recentOps.out },
		discovered_via_coordinator_id:
			typeof row.discovered_via_coordinator_id === "string"
				? row.discovered_via_coordinator_id
				: null,
		discovered_via_group_id:
			typeof row.discovered_via_group_id === "string" ? row.discovered_via_group_id : null,
	};
}

// Aggregate ops_in / ops_out across recent successful sync_attempts per peer.
// Window: last 24 hours. Feeds the per-peer direction glyph on the Sync tab
// (↕ bidirectional, ↑ publishing, ↓ subscribed) off real traffic instead of
// an invented peer-role field.
const SYNC_DIRECTION_WINDOW_SECONDS = 24 * 60 * 60;

function recentPeerOps(store: MemoryStore): Map<string, { in: number; out: number }> {
	const cutoff = new Date(Date.now() - SYNC_DIRECTION_WINDOW_SECONDS * 1000).toISOString();
	const rows = store.db
		.prepare(
			`SELECT peer_device_id,
			        COALESCE(SUM(ops_in), 0) AS ops_in,
			        COALESCE(SUM(ops_out), 0) AS ops_out
			   FROM sync_attempts
			  WHERE ok = 1 AND finished_at IS NOT NULL AND finished_at >= ?
			  GROUP BY peer_device_id`,
		)
		.all(cutoff) as Array<{
		peer_device_id: string | null;
		ops_in: number | null;
		ops_out: number | null;
	}>;
	const map = new Map<string, { in: number; out: number }>();
	for (const row of rows) {
		const id = String(row.peer_device_id ?? "").trim();
		if (!id) continue;
		map.set(id, { in: Number(row.ops_in ?? 0), out: Number(row.ops_out ?? 0) });
	}
	return map;
}

// ---------------------------------------------------------------------------
// Peer status helpers
// ---------------------------------------------------------------------------

function isRecentIso(value: unknown, windowS = SYNC_STALE_AFTER_SECONDS): boolean {
	const raw = String(value ?? "").trim();
	if (!raw) return false;
	const normalized = raw.replace("Z", "+00:00");
	const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
	const ts = new Date(hasOffset ? normalized : `${normalized}+00:00`);
	if (Number.isNaN(ts.getTime())) return false;
	const ageS = (Date.now() - ts.getTime()) / 1000;
	return ageS >= 0 && ageS <= windowS;
}

function peerStatus(peer: Record<string, unknown>): Record<string, unknown> {
	const lastSyncAt = peer.last_sync_at;
	const lastPingAt = peer.last_seen_at;
	const hasError = Boolean(peer.has_error);

	const syncFresh = isRecentIso(lastSyncAt);
	const pingFresh = isRecentIso(lastPingAt);

	let peerState: string;
	if (hasError && !(syncFresh || pingFresh)) peerState = "offline";
	else if (hasError) peerState = "degraded";
	else if (syncFresh || pingFresh) peerState = "online";
	else if (lastSyncAt || lastPingAt) peerState = "stale";
	else peerState = "unknown";

	const syncStatus = hasError ? "error" : syncFresh ? "ok" : lastSyncAt ? "stale" : "unknown";
	const pingStatus = pingFresh ? "ok" : lastPingAt ? "stale" : "unknown";

	return {
		sync_status: syncStatus,
		ping_status: pingStatus,
		peer_state: peerState,
		fresh: syncFresh || pingFresh,
		last_sync_at: lastSyncAt,
		last_ping_at: lastPingAt,
	};
}

function attemptStatus(attempt: Record<string, unknown>): string {
	if (attempt.ok) return "ok";
	if (attempt.error) return "error";
	return "unknown";
}

function readViewerBinding(dbPath: string): { host: string; port: number } | null {
	try {
		const raw = readFileSync(join(dirname(dbPath), "viewer.pid"), "utf8");
		const parsed = JSON.parse(raw) as Partial<{ host: string; port: number }>;
		if (typeof parsed.host === "string" && typeof parsed.port === "number") {
			return { host: parsed.host, port: parsed.port };
		}
	} catch {
		// ignore missing/malformed pidfile
	}
	return null;
}

const PEERS_QUERY = `
	SELECT p.peer_device_id, p.name, p.pinned_fingerprint, p.addresses_json,
	       p.last_seen_at, p.last_sync_at, p.last_error,
	       p.projects_include_json, p.projects_exclude_json, p.claimed_local_actor,
	       p.actor_id, a.display_name AS actor_display_name
	FROM sync_peers AS p
	LEFT JOIN actors AS a ON a.actor_id = p.actor_id
	ORDER BY name, peer_device_id
`;

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Peer-to-peer sync protocol routes (/v1/*).
 *
 * These are mounted on the sync listener (0.0.0.0:7337) and are
 * network-accessible. All requests are auth-gated via signature
 * verification so unauthenticated callers are rejected.
 */
export function syncProtocolRoutes(getStore: StoreFactory, opts: SyncProtocolRouteOptions = {}) {
	const app = new Hono();
	const routeRateLimit = opts.routeRateLimit ?? null;

	function rateLimitedResponse(c: Context, key: string, authenticated: boolean) {
		if (!routeRateLimit) return null;
		const isRead = c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS";
		const result = routeRateLimit.limiter.check(
			`${c.req.method}:${authenticated ? "auth" : "anon"}:${key}`,
			authenticated
				? isRead
					? routeRateLimit.readLimit
					: routeRateLimit.mutationLimit
				: isRead
					? routeRateLimit.unauthenticatedReadLimit
					: routeRateLimit.unauthenticatedMutationLimit,
		);
		if (result.allowed) return null;
		c.header("Retry-After", String(result.retryAfterS));
		return c.json({ error: "rate_limited", retry_after_s: result.retryAfterS }, 429);
	}

	// GET /v1/status (peer sync protocol)
	app.get("/v1/status", (c) => {
		const store = getStore();
		return (async () => {
			let auth = authorizeSyncRequest(store, c.req, Buffer.alloc(0));
			let preauthChecked = false;
			let bootstrapAttempted = false;
			if (!auth.ok) {
				const bootstrapGrantId = (c.req.header("X-Codemem-Bootstrap-Grant") ?? "").trim();
				if (bootstrapGrantId) {
					preauthChecked = true;
					// Use unauthenticated bucket with stable key — grant is not yet verified,
					// so caller-controlled headers must not influence rate-limit identity.
					const bootstrapLimited = rateLimitedResponse(c, c.req.path, false);
					if (bootstrapLimited) return bootstrapLimited;
				} else {
					preauthChecked = true;
					const unauthLimited = rateLimitedResponse(c, c.req.path, false);
					if (unauthLimited) return unauthLimited;
				}
				auth = await authorizeBootstrapGrantRequest(store, c.req, Buffer.alloc(0));
				bootstrapAttempted = true;
			}
			if (!auth.ok) {
				// Specific reasons are logged server-side; wire responses use a generic
				// reason to prevent info-disclosure.
				if (bootstrapAttempted) {
					console.warn(
						`[sync] bootstrap grant auth failed: reason=${auth.reason} grant=${(c.req.header("X-Codemem-Bootstrap-Grant") ?? "").trim()} path=${c.req.path}`,
					);
				}
				const wireReason = bootstrapAttempted ? "bootstrap_grant_invalid" : auth.reason;
				return (
					(preauthChecked ? null : rateLimitedResponse(c, c.req.path, false)) ??
					c.json(unauthorizedPayload(wireReason), 401)
				);
			}
			const limited = rateLimitedResponse(c, auth.deviceId, true);
			if (limited) return limited;

			try {
				const [deviceId, fingerprint] = ensureDeviceIdentity(store.db, {
					keysDir: syncKeysDir(),
				});
				const syncReset = getSyncResetState(store.db);
				return c.json({
					device_id: deviceId,
					protocol_version: SYNC_PROTOCOL_VERSION,
					fingerprint,
					sync_reset: addSyncScopeToBoundary(syncReset, null),
					sync_capability: LOCAL_SYNC_CAPABILITY,
				});
			} catch {
				return c.json({ error: "internal_error" }, 500);
			}
		})();
	});

	// GET /v1/ops (peer sync protocol)
	app.get("/v1/ops", (c) => {
		const store = getStore();
		const auth = authorizeSyncRequest(store, c.req, Buffer.alloc(0));
		if (!auth.ok)
			return (
				rateLimitedResponse(c, c.req.path, false) ?? c.json(unauthorizedPayload(auth.reason), 401)
			);
		const limited = rateLimitedResponse(c, auth.deviceId, true);
		if (limited) return limited;
		const peerDeviceId = auth.deviceId;

		try {
			const rawScopeId = c.req.query(SYNC_SCOPE_QUERY_PARAM);
			const scopeRequest = parseSyncScopeRequest(rawScopeId, rawScopeId !== undefined);
			if (!scopeRequest.ok) {
				return c.json(
					syncScopeResetRequiredPayload(
						getSyncResetState(store.db),
						scopeRequest.reason,
						LOCAL_SYNC_CAPABILITY,
					),
					409,
				);
			}
			const since = c.req.query("since") ?? null;
			const rawLimit = Number.parseInt(c.req.query("limit") ?? "200", 10);
			const rawGeneration = c.req.query("generation");
			const generation =
				rawGeneration != null && rawGeneration.trim().length > 0
					? Number.parseInt(rawGeneration, 10)
					: null;
			const snapshotId = c.req.query("snapshot_id") ?? null;
			const baselineCursor = c.req.query("baseline_cursor") ?? null;
			const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 1000)) : 200;
			const [localDeviceId] = ensureDeviceIdentity(store.db, { keysDir: syncKeysDir() });
			const result = loadReplicationOpsForPeer(store.db, {
				since,
				limit,
				deviceId: localDeviceId,
				generation: Number.isFinite(generation) ? generation : null,
				snapshotId,
				baselineCursor,
			});
			if (result.reset_required) {
				return c.json(
					{
						error: "reset_required",
						sync_capability: LOCAL_SYNC_CAPABILITY,
						...addSyncScopeToBoundary(result.reset, scopeRequest.scope_id),
					},
					409,
				);
			}
			const { ops, nextCursor, boundary } = result;
			const filtered = filterOpsForPeer(store, peerDeviceId, ops);
			return c.json({
				reset_required: false,
				sync_capability: LOCAL_SYNC_CAPABILITY,
				scope_id: scopeRequest.scope_id,
				generation: boundary.generation,
				snapshot_id: boundary.snapshot_id,
				baseline_cursor: boundary.baseline_cursor,
				retained_floor_cursor: boundary.retained_floor_cursor,
				ops: filtered.allowed,
				next_cursor: nextCursor,
				skipped: filtered.skipped,
			});
		} catch {
			return c.json({ error: "internal_error" }, 500);
		}
	});

	// GET /v1/snapshot (peer sync protocol — bootstrap snapshot pages)
	app.get("/v1/snapshot", (c) => {
		const store = getStore();
		return (async () => {
			let auth = authorizeSyncRequest(store, c.req, Buffer.alloc(0));
			let preauthChecked = false;
			let bootstrapAttempted = false;
			if (!auth.ok) {
				const bootstrapGrantId = (c.req.header("X-Codemem-Bootstrap-Grant") ?? "").trim();
				if (bootstrapGrantId) {
					preauthChecked = true;
					// Use unauthenticated bucket with stable key — grant is not yet verified,
					// so caller-controlled headers must not influence rate-limit identity.
					const bootstrapLimited = rateLimitedResponse(c, c.req.path, false);
					if (bootstrapLimited) return bootstrapLimited;
				} else {
					preauthChecked = true;
					const unauthLimited = rateLimitedResponse(c, c.req.path, false);
					if (unauthLimited) return unauthLimited;
				}
				auth = await authorizeBootstrapGrantRequest(store, c.req, Buffer.alloc(0));
				bootstrapAttempted = true;
			}
			if (!auth.ok) {
				// Specific reasons are logged server-side; wire responses use a generic
				// reason to prevent info-disclosure.
				if (bootstrapAttempted) {
					console.warn(
						`[sync] bootstrap grant auth failed: reason=${auth.reason} grant=${(c.req.header("X-Codemem-Bootstrap-Grant") ?? "").trim()} path=${c.req.path}`,
					);
				}
				const wireReason = bootstrapAttempted ? "bootstrap_grant_invalid" : auth.reason;
				return (
					(preauthChecked ? null : rateLimitedResponse(c, c.req.path, false)) ??
					c.json(unauthorizedPayload(wireReason), 401)
				);
			}
			const limited = rateLimitedResponse(c, auth.deviceId, true);
			if (limited) return limited;

			try {
				const rawScopeId = c.req.query(SYNC_SCOPE_QUERY_PARAM);
				const scopeRequest = parseSyncScopeRequest(rawScopeId, rawScopeId !== undefined);
				if (!scopeRequest.ok) {
					return c.json(
						syncScopeResetRequiredPayload(
							getSyncResetState(store.db),
							scopeRequest.reason,
							LOCAL_SYNC_CAPABILITY,
						),
						409,
					);
				}
				const rawGeneration = c.req.query("generation");
				const generation =
					rawGeneration != null && rawGeneration.trim().length > 0
						? Number.parseInt(rawGeneration, 10)
						: null;
				const snapshotId = c.req.query("snapshot_id") ?? null;
				const baselineCursor = c.req.query("baseline_cursor") ?? null;
				const pageToken = c.req.query("page_token") ?? null;
				const rawLimit = Number.parseInt(c.req.query("limit") ?? "200", 10);
				// Cap raised to 5000 to support elevated bootstrap page sizes (default 2000).
				const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 5000)) : 200;

				if (generation == null || !Number.isFinite(generation)) {
					return c.json({ error: "missing_generation" }, 400);
				}
				if (!snapshotId) {
					return c.json({ error: "missing_snapshot_id" }, 400);
				}

				const result = loadMemorySnapshotPageForPeer(store.db, {
					generation,
					snapshotId,
					baselineCursor,
					pageToken,
					limit,
					peerDeviceId: auth.deviceId,
				});

				return c.json({
					scope_id: scopeRequest.scope_id,
					generation: result.boundary.generation,
					snapshot_id: result.boundary.snapshot_id,
					baseline_cursor: result.boundary.baseline_cursor,
					retained_floor_cursor: result.boundary.retained_floor_cursor,
					sync_capability: LOCAL_SYNC_CAPABILITY,
					items: result.items,
					next_page_token: result.nextPageToken,
					has_more: result.hasMore,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : "";
				if (message === "generation_mismatch" || message === "boundary_mismatch") {
					return c.json({ error: message }, 409);
				}
				return c.json({ error: "internal_error" }, 500);
			}
		})();
	});

	// POST /v1/ops (peer sync protocol)
	app.post("/v1/ops", async (c) => {
		const store = getStore();
		const raw = await readBoundedRequestBytes(c.req.raw, MAX_SYNC_BODY_BYTES);
		if (raw == null) {
			return c.json({ error: "payload_too_large" }, 413);
		}

		const auth = authorizeSyncRequest(store, c.req, raw);
		if (!auth.ok)
			return (
				rateLimitedResponse(c, c.req.path, false) ?? c.json(unauthorizedPayload(auth.reason), 401)
			);
		const limited = rateLimitedResponse(c, auth.deviceId, true);
		if (limited) return limited;
		const peerDeviceId = auth.deviceId;

		let body: Record<string, unknown>;
		try {
			const parsed = JSON.parse(raw.toString("utf-8")) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				return c.json({ error: "invalid_json" }, 400);
			}
			body = parsed as Record<string, unknown>;
		} catch {
			return c.json({ error: "invalid_json" }, 400);
		}

		const scopeRequest = parseSyncScopeRequest(body.scope_id, Object.hasOwn(body, "scope_id"));
		if (!scopeRequest.ok) {
			return c.json(
				syncScopeResetRequiredPayload(
					getSyncResetState(store.db),
					scopeRequest.reason,
					LOCAL_SYNC_CAPABILITY,
				),
				409,
			);
		}
		if (!Array.isArray(body.ops)) {
			return c.json({ error: "invalid_ops" }, 400);
		}
		if (body.ops.length > MAX_SYNC_OPS) {
			return c.json({ error: "too_many_ops" }, 413);
		}

		const normalizedOps = extractReplicationOps(body);
		for (const op of normalizedOps) {
			if (op.device_id !== peerDeviceId || op.clock_device_id !== peerDeviceId) {
				return c.json(
					{
						error: "invalid_op_device",
						reason: "device_id_mismatch",
						op_id: op.op_id,
					},
					400,
				);
			}
		}
		const [localDeviceId] = ensureDeviceIdentity(store.db, { keysDir: syncKeysDir() });

		const filteredInbound = filterOpsForPeer(store, peerDeviceId, normalizedOps);
		const result = applyReplicationOps(
			store.db,
			filteredInbound.allowed,
			localDeviceId,
			store.scanner,
		);
		return c.json({
			...result,
			sync_capability: LOCAL_SYNC_CAPABILITY,
			scope_id: scopeRequest.scope_id,
			skipped: result.skipped + filteredInbound.skipped,
		});
	});

	return app;
}

/**
 * Viewer-facing sync management routes (/api/sync/*).
 *
 * These are mounted on the viewer listener (127.0.0.1:38888) and
 * provide sync status, peer management, and coordinator UI for the
 * local viewer.
 */
export function syncRoutes(
	getStore: StoreFactory,
	getSyncRuntimeStatus?: () => SyncRuntimeStatus | null,
) {
	const app = new Hono();

	// GET /api/sync/status
	app.get("/api/sync/status", async (c) => {
		const store = getStore();
		{
			const traceSync = <T>(label: string, fn: () => T): T => {
				if (process.env.CODEMEM_TRACE_SYNC_STATUS !== "1") return fn();
				const startedAt = Date.now();
				console.warn(`[codemem sync-status] ${label} start`);
				try {
					return fn();
				} finally {
					console.warn(`[codemem sync-status] ${label} ${Date.now() - startedAt}ms`);
				}
			};
			const showDiag = queryBool(c.req.query("includeDiagnostics"));
			const includeJoinRequests = queryBool(c.req.query("includeJoinRequests"));
			const project = c.req.query("project") || null;
			const config = traceSync("readCoordinatorSyncConfig", () => readCoordinatorSyncConfig());
			const syncReset = traceSync("getSyncResetState", () => getSyncResetState(store.db));

			const d = drizzle(store.db, { schema });

			const deviceRow = traceSync("deviceRow", () =>
				d
					.select({
						device_id: schema.syncDevice.device_id,
						fingerprint: schema.syncDevice.fingerprint,
					})
					.from(schema.syncDevice)
					.limit(1)
					.get(),
			);

			const daemonState = traceSync("daemonState", () =>
				d.select().from(schema.syncDaemonState).where(eq(schema.syncDaemonState.id, 1)).get(),
			);

			const peerCountRow = traceSync("peerCountRow", () =>
				d.select({ total: count() }).from(schema.syncPeers).get(),
			);
			let retentionState:
				| {
						last_run_at?: string | null;
						last_duration_ms?: number | null;
						last_deleted_ops?: number | null;
						last_estimated_bytes_before?: number | null;
						last_estimated_bytes_after?: number | null;
						retained_floor_cursor?: string | null;
						last_error?: string | null;
						last_error_at?: string | null;
				  }
				| undefined;
			try {
				retentionState = traceSync("retentionState", () =>
					d
						.select()
						.from(schema.syncRetentionState)
						.where(eq(schema.syncRetentionState.id, 1))
						.get(),
				);
			} catch {
				retentionState = undefined;
			}

			const lastSyncRow = traceSync("lastSyncRow", () =>
				d
					.select({ last_sync_at: max(schema.syncPeers.last_sync_at) })
					.from(schema.syncPeers)
					.get(),
			);
			// Always take the fast COUNT(DISTINCT) path. The slow
			// per-memory vec0 probe blocks the event loop for seconds on
			// larger DBs, which hangs every concurrent request — not
			// acceptable from a status endpoint. See codemem-00jn.
			const semanticIndex = traceSync("semanticIndex", () =>
				redactSemanticIndexDiagnostics(getSemanticIndexDiagnostics(store.db), showDiag),
			);

			const lastError = daemonState?.last_error as string | null;
			const lastErrorAt = daemonState?.last_error_at as string | null;
			const lastOkAt = daemonState?.last_ok_at as string | null;
			const viewerBinding = traceSync("readViewerBinding", () => readViewerBinding(store.dbPath));
			// The sync daemon runs inside the viewer-server process itself, so
			// if this request is being served, the daemon is by definition
			// running — the viewer is serving us right now. The prior
			// `portOpen` self-probe occasionally timed out under GC / socket
			// backlog pressure and mis-reported "stopped · unreachable" while
			// every other request kept succeeding. Trust the pidfile's
			// existence (a record was written at startup) and skip the loopback
			// probe.
			const daemonRunning = Boolean(viewerBinding);
			const daemonDetail = viewerBinding
				? `viewer pidfile at ${viewerBinding.host}:${viewerBinding.port}`
				: null;

			let daemonStateValue = "ok";
			if (!config.syncEnabled) {
				daemonStateValue = "disabled";
			} else if (lastError && (!lastOkAt || String(lastOkAt) < String(lastErrorAt ?? ""))) {
				daemonStateValue = "error";
			} else if (!daemonRunning) {
				daemonStateValue = "stopped";
			}

			const statusPayload: Record<string, unknown> = {
				enabled: config.syncEnabled,
				interval_s: config.syncIntervalS,
				retention: {
					enabled: config.syncRetentionEnabled,
					max_age_days: config.syncRetentionMaxAgeDays,
					max_size_mb: config.syncRetentionMaxSizeMb,
					retained_floor_cursor:
						syncReset.retained_floor_cursor ??
						(retentionState?.retained_floor_cursor as string | null) ??
						null,
					last_run_at: (retentionState?.last_run_at as string | null) ?? null,
					last_duration_ms:
						typeof retentionState?.last_duration_ms === "number"
							? retentionState.last_duration_ms
							: null,
					last_deleted_ops:
						typeof retentionState?.last_deleted_ops === "number"
							? retentionState.last_deleted_ops
							: null,
					last_estimated_bytes_before:
						typeof retentionState?.last_estimated_bytes_before === "number"
							? retentionState.last_estimated_bytes_before
							: null,
					last_estimated_bytes_after:
						typeof retentionState?.last_estimated_bytes_after === "number"
							? retentionState.last_estimated_bytes_after
							: null,
					last_error: (retentionState?.last_error as string | null) ?? null,
					last_error_at: (retentionState?.last_error_at as string | null) ?? null,
				},
				semantic_index: semanticIndex,
				peer_count: Number(peerCountRow?.total ?? 0),
				last_sync_at: lastSyncRow?.last_sync_at ?? null,
				daemon_state: daemonStateValue,
				daemon_running: daemonRunning,
				daemon_detail: daemonDetail,
				project_filter_active:
					config.syncProjectsInclude.length > 0 || config.syncProjectsExclude.length > 0,
				project_filter: {
					include: config.syncProjectsInclude,
					exclude: config.syncProjectsExclude,
				},
				redacted: !showDiag,
			};

			if (showDiag) {
				statusPayload.device_id = deviceRow?.device_id ?? null;
				statusPayload.fingerprint = deviceRow?.fingerprint ?? null;
				statusPayload.bind = `${config.syncHost}:${config.syncPort}`;
				statusPayload.daemon_last_error = lastError;
				statusPayload.daemon_last_error_at = lastErrorAt;
				statusPayload.daemon_last_ok_at = lastOkAt;
			}

			const runtimeStatus = getSyncRuntimeStatus?.() ?? null;
			if (runtimeStatus?.phase && runtimeStatus.phase !== "running") {
				daemonStateValue = runtimeStatus.phase;
				statusPayload.daemon_state = daemonStateValue;
				statusPayload.daemon_running = runtimeStatus.phase === "starting" || daemonRunning;
				statusPayload.daemon_detail = runtimeStatus.detail ?? daemonDetail;
			}

			// Build peers list using deduplicated mapPeerRow
			const peerRows = traceSync(
				"peerRows",
				() => store.db.prepare(PEERS_QUERY).all() as Record<string, unknown>[],
			);
			const recentOpsByPeer = traceSync("recentPeerOps", () => recentPeerOps(store));
			const peersItems = peerRows.map((row) => {
				const peer = mapPeerRow(store, row, showDiag, recentOpsByPeer);
				peer.status = peerStatus(peer);
				return peer;
			});

			const peersMap: Record<string, unknown> = {};
			for (const peer of peersItems) {
				peersMap[String(peer.peer_device_id)] = peer.status;
			}

			// Attempts
			const attemptRows = traceSync("attemptRows", () =>
				d
					.select({
						peer_device_id: schema.syncAttempts.peer_device_id,
						ok: schema.syncAttempts.ok,
						error: schema.syncAttempts.error,
						started_at: schema.syncAttempts.started_at,
						finished_at: schema.syncAttempts.finished_at,
						ops_in: schema.syncAttempts.ops_in,
						ops_out: schema.syncAttempts.ops_out,
						local_sync_capability: schema.syncAttempts.local_sync_capability,
						peer_sync_capability: schema.syncAttempts.peer_sync_capability,
						negotiated_sync_capability: schema.syncAttempts.negotiated_sync_capability,
					})
					.from(schema.syncAttempts)
					.orderBy(desc(schema.syncAttempts.finished_at))
					.limit(25)
					.all(),
			);
			const peerAddressMap = new Map<string, string[]>();
			const peerAddressRows = traceSync(
				"peerAddressRows",
				() =>
					store.db.prepare("SELECT peer_device_id, addresses_json FROM sync_peers").all() as Array<{
						peer_device_id: string | null;
						addresses_json: string | null;
					}>,
			);
			peerAddressRows.forEach((peerRow) => {
				const addrs = safeJsonList(peerRow.addresses_json as string | null);
				if (addrs.length) peerAddressMap.set(String(peerRow.peer_device_id ?? ""), addrs);
			});
			const attemptsItems = attemptRows.map((row) => {
				const addrs = showDiag ? peerAddressMap.get(String(row.peer_device_id ?? "")) : undefined;
				return {
					...row,
					status: attemptStatus(row),
					address: addrs?.length ? addrs[0] : null,
				};
			});
			const latestAttemptError = String(attemptsItems[0]?.error || "").trim();

			const statusBlock: Record<string, unknown> = {
				...statusPayload,
				background_maintenance: summarizeMaintenanceJobs(listMaintenanceJobs(store.db), showDiag),
				peers: peersMap,
				pending: 0,
				sync: {},
				ping: {},
			};
			const legacyDevices = traceSync("legacyDevices", () => store.claimableLegacyDeviceIds());
			const sharingReview = traceSync("sharingReview", () => store.sharingReviewSummary(project));
			const coordinatorSnapshot = await coordinatorStatusSnapshot(store, config);
			const coordinator = traceSync("coordinator", () =>
				redactCoordinatorStatus(coordinatorSnapshot, showDiag),
			);
			let joinRequests: Record<string, unknown>[] = [];
			if (includeJoinRequests && showDiag && config.syncCoordinatorAdminSecret) {
				try {
					joinRequests = await listCoordinatorJoinRequests(config);
				} catch {
					joinRequests = [];
				}
			}

			if (daemonStateValue === "ok" && latestAttemptError.startsWith("needs_attention:")) {
				daemonStateValue = "needs_attention";
				statusPayload.daemon_state = daemonStateValue;
				statusPayload.daemon_detail = latestAttemptError.replace(/^needs_attention:/, "");
				statusBlock.daemon_state = daemonStateValue;
				statusBlock.daemon_detail = latestAttemptError.replace(/^needs_attention:/, "");
			}

			if (daemonStateValue === "ok") {
				const peerStates = new Set(
					peersItems.map((peer) =>
						String((peer.status as Record<string, unknown> | undefined)?.peer_state ?? ""),
					),
				);
				const latestFailedRecently = Boolean(
					attemptsItems[0] &&
						attemptsItems[0].status === "error" &&
						isRecentIso(attemptsItems[0].finished_at),
				);
				const allOffline =
					peersItems.length > 0 &&
					peersItems.every(
						(peer) =>
							String((peer.status as Record<string, unknown>)?.peer_state ?? "") === "offline",
					);
				if (latestFailedRecently) {
					const hasLivePeer = peerStates.has("online") || peerStates.has("degraded");
					if (hasLivePeer) daemonStateValue = "degraded";
					else if (allOffline) daemonStateValue = "offline-peers";
					else if (peersItems.length > 0) daemonStateValue = "stale";
				} else if (peerStates.has("degraded")) {
					daemonStateValue = "degraded";
				} else if (allOffline) {
					daemonStateValue = "offline-peers";
				} else if (peersItems.length > 0 && !peerStates.has("online")) {
					daemonStateValue = "stale";
				}
				statusPayload.daemon_state = daemonStateValue;
				statusBlock.daemon_state = daemonStateValue;
			}

			const responsePayload: Record<string, unknown> = {
				...statusPayload,
				status: statusBlock,
				peers: peersItems,
				attempts: attemptsItems.slice(0, 5),
				legacy_devices: legacyDevices,
				sharing_review: sharingReview,
				coordinator,
			};
			if (includeJoinRequests && showDiag) {
				responsePayload.join_requests = joinRequests;
			}
			return c.json(responsePayload);
		}
	});

	// GET /api/sync/peers
	app.get("/api/sync/peers", (c) => {
		const store = getStore();
		{
			const showDiag = queryBool(c.req.query("includeDiagnostics"));
			const rows = store.db.prepare(PEERS_QUERY).all() as Record<string, unknown>[];
			const recentOpsByPeer = recentPeerOps(store);
			// Use deduplicated mapPeerRow helper (fix #4)
			const peers = rows.map((row) => mapPeerRow(store, row, showDiag, recentOpsByPeer));
			return c.json({ items: peers, redacted: !showDiag });
		}
	});

	// GET /api/sync/actors
	app.get("/api/sync/actors", (c) => {
		const store = getStore();
		{
			ensureLocalActorRecord(store);
			const d = drizzle(store.db, { schema });
			const includeMerged = queryBool(c.req.query("includeMerged"));
			const query = d.select().from(schema.actors);
			const rows = includeMerged
				? query.orderBy(schema.actors.display_name).all()
				: query
						.where(and(ne(schema.actors.status, "merged"), ne(schema.actors.status, "deactivated")))
						.orderBy(schema.actors.display_name)
						.all();
			return c.json({ items: rows });
		}
	});

	// GET /api/sync/attempts
	app.get("/api/sync/attempts", (c) => {
		const store = getStore();
		{
			const d = drizzle(store.db, { schema });
			let limit = queryInt(c.req.query("limit"), 25);
			if (limit <= 0) return c.json({ error: "invalid_limit" }, 400);
			limit = Math.min(limit, 500);
			const rows = d
				.select({
					peer_device_id: schema.syncAttempts.peer_device_id,
					ok: schema.syncAttempts.ok,
					error: schema.syncAttempts.error,
					started_at: schema.syncAttempts.started_at,
					finished_at: schema.syncAttempts.finished_at,
					ops_in: schema.syncAttempts.ops_in,
					ops_out: schema.syncAttempts.ops_out,
					local_sync_capability: schema.syncAttempts.local_sync_capability,
					peer_sync_capability: schema.syncAttempts.peer_sync_capability,
					negotiated_sync_capability: schema.syncAttempts.negotiated_sync_capability,
				})
				.from(schema.syncAttempts)
				.orderBy(desc(schema.syncAttempts.finished_at))
				.limit(limit)
				.all();
			return c.json({ items: rows });
		}
	});

	// GET /api/sync/pairing — uses ensureDeviceIdentity from core (fix #5 context)
	//
	// The pairing payload is not redacted by the generic diagnostics toggle:
	// it is the actual command the user shares with their own other devices,
	// and the UI already hides it inside a "Show pairing command" disclosure
	// that they explicitly open. Redacting the payload here broke the
	// happy-path pairing flow because the UI had nothing to render as the
	// command when diagnostics were off.
	app.get("/api/sync/pairing", (c) => {
		const store = getStore();
		{
			const config = readCoordinatorSyncConfig();
			const d = drizzle(store.db, { schema });
			const deviceRow = d
				.select({
					device_id: schema.syncDevice.device_id,
					public_key: schema.syncDevice.public_key,
					fingerprint: schema.syncDevice.fingerprint,
				})
				.from(schema.syncDevice)
				.limit(1)
				.get();

			let deviceId: string | undefined;
			let publicKey: string | undefined;
			let fingerprint: string | undefined;

			if (deviceRow) {
				deviceId = String(deviceRow.device_id);
				publicKey = String(deviceRow.public_key);
				fingerprint = String(deviceRow.fingerprint);
			} else {
				// Fall back to ensureDeviceIdentity if no row exists
				try {
					const [id, fp] = ensureDeviceIdentity(store.db, { keysDir: syncKeysDir() });
					deviceId = id;
					fingerprint = fp;
					const newRow = d
						.select({ public_key: schema.syncDevice.public_key })
						.from(schema.syncDevice)
						.where(eq(schema.syncDevice.device_id, id))
						.get();
					publicKey = newRow?.public_key ?? "";
				} catch {
					return c.json({ error: "device identity unavailable" }, 500);
				}
			}

			if (!deviceId || !fingerprint) {
				return c.json({ error: "public key missing" }, 500);
			}

			return c.json({
				device_id: deviceId,
				fingerprint,
				public_key: publicKey ?? null,
				pairing_filter_hint: PAIRING_FILTER_HINT,
				addresses: pairingAdvertiseAddresses(config),
			});
		}
	});

	// ------------------------------------------------------------------
	// POST mutations
	// ------------------------------------------------------------------

	// POST /api/sync/peers/rename
	app.post("/api/sync/peers/rename", async (c) => {
		const store = getStore();
		{
			const d = drizzle(store.db, { schema });
			const body = await c.req.json<Record<string, unknown>>();
			const peerDeviceId = String(body.peer_device_id ?? "").trim();
			const name = String(body.name ?? "").trim();
			if (!peerDeviceId) return c.json({ error: "peer_device_id required" }, 400);
			if (!name) return c.json({ error: "name required" }, 400);
			const exists = d
				.select({ peer_device_id: schema.syncPeers.peer_device_id })
				.from(schema.syncPeers)
				.where(eq(schema.syncPeers.peer_device_id, peerDeviceId))
				.get();
			if (!exists) return c.json({ error: "peer not found" }, 404);
			d.update(schema.syncPeers)
				.set({ name })
				.where(eq(schema.syncPeers.peer_device_id, peerDeviceId))
				.run();
			return c.json({ ok: true });
		}
	});

	app.post("/api/sync/run", async (c) => {
		const store = getStore();
		let body: Record<string, unknown> = {};
		try {
			body = await c.req.json<Record<string, unknown>>();
		} catch {
			body = {};
		}
		const config = readCoordinatorSyncConfig();
		if (!config.syncEnabled) {
			return c.json({ error: "sync_disabled" }, 403);
		}
		const address =
			typeof body.address === "string" && body.address.trim() ? body.address.trim() : null;
		const requestedPeerId =
			typeof body.peer_device_id === "string" && body.peer_device_id.trim()
				? body.peer_device_id.trim()
				: null;
		let peerIds: string[];
		if (address) {
			const peerId = findPeerDeviceIdForAddress(store, address);
			if (!peerId) return c.json({ error: "unknown peer address" }, 404);
			peerIds = [peerId];
		} else if (requestedPeerId) {
			const requestedPeerRows = store.db
				.prepare("SELECT peer_device_id FROM sync_peers WHERE peer_device_id = ?")
				.all(requestedPeerId) as Array<{ peer_device_id: string | null }>;
			peerIds = requestedPeerRows
				.map((row) => String(row.peer_device_id ?? "").trim())
				.filter(Boolean);
		} else {
			const allPeerRows = store.db.prepare("SELECT peer_device_id FROM sync_peers").all() as Array<{
				peer_device_id: string | null;
			}>;
			peerIds = allPeerRows.map((row) => String(row.peer_device_id ?? "").trim()).filter(Boolean);
		}
		const items = [] as Array<Record<string, unknown>>;
		for (const peerId of peerIds) {
			const result = await runSyncPass(store.db, peerId, { scanner: store.scanner });
			items.push({ peer_device_id: peerId, ...result });
		}
		return c.json({ items });
	});

	app.post("/api/sync/peers/scope", async (c) => {
		const store = getStore();
		let body: Record<string, unknown>;
		try {
			body = await c.req.json<Record<string, unknown>>();
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		const peerDeviceId = String(body.peer_device_id ?? "").trim();
		if (!peerDeviceId) return c.json({ error: "peer_device_id required" }, 400);
		const include = Array.isArray(body.include)
			? body.include
					.filter((value): value is string => typeof value === "string")
					.map((value) => value.trim())
					.filter(Boolean)
			: null;
		const exclude = Array.isArray(body.exclude)
			? body.exclude
					.filter((value): value is string => typeof value === "string")
					.map((value) => value.trim())
					.filter(Boolean)
			: null;
		const inheritGlobal = Boolean(body.inherit_global);
		const d = drizzle(store.db, { schema });
		const exists = d
			.select({ peer_device_id: schema.syncPeers.peer_device_id })
			.from(schema.syncPeers)
			.where(eq(schema.syncPeers.peer_device_id, peerDeviceId))
			.get();
		if (!exists) return c.json({ error: "peer not found" }, 404);
		d.update(schema.syncPeers)
			.set({
				projects_include_json: inheritGlobal ? null : JSON.stringify(include ?? []),
				projects_exclude_json: inheritGlobal ? null : JSON.stringify(exclude ?? []),
			})
			.where(eq(schema.syncPeers.peer_device_id, peerDeviceId))
			.run();
		const row = d
			.select({
				projects_include_json: schema.syncPeers.projects_include_json,
				projects_exclude_json: schema.syncPeers.projects_exclude_json,
			})
			.from(schema.syncPeers)
			.where(eq(schema.syncPeers.peer_device_id, peerDeviceId))
			.get() as Record<string, unknown> | undefined;
		if (!row) return c.json({ error: "peer not found" }, 404);
		return c.json({
			ok: true,
			project_scope: currentProjectScope(row, readPeerProjectFilters(store, peerDeviceId)),
		});
	});

	app.post("/api/sync/peers/identity", async (c) => {
		const store = getStore();
		ensureLocalActorRecord(store);
		let body: Record<string, unknown>;
		try {
			body = await c.req.json<Record<string, unknown>>();
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		const peerDeviceId = String(body.peer_device_id ?? "").trim();
		if (!peerDeviceId) return c.json({ error: "peer_device_id required" }, 400);
		const requestedActorId =
			body.actor_id == null ? undefined : String(body.actor_id ?? "").trim() || null;
		const claimedLocalActor =
			typeof body.claimed_local_actor === "boolean" ? body.claimed_local_actor : undefined;
		const d = drizzle(store.db, { schema });
		const peer = d
			.select({
				peer_device_id: schema.syncPeers.peer_device_id,
				actor_id: schema.syncPeers.actor_id,
				claimed_local_actor: schema.syncPeers.claimed_local_actor,
			})
			.from(schema.syncPeers)
			.where(eq(schema.syncPeers.peer_device_id, peerDeviceId))
			.get();
		if (!peer) return c.json({ error: "peer not found" }, 404);

		let nextActorId = peer.actor_id ?? null;
		let nextClaimedLocalActor = Boolean(peer.claimed_local_actor);
		if (requestedActorId !== undefined) {
			nextActorId = requestedActorId;
			if (requestedActorId) {
				const actor = d
					.select({
						actor_id: schema.actors.actor_id,
						is_local: schema.actors.is_local,
						status: schema.actors.status,
					})
					.from(schema.actors)
					.where(eq(schema.actors.actor_id, requestedActorId))
					.get();
				if (!actor) return c.json({ error: "actor not found" }, 404);
				if (actor.status !== "active") return c.json({ error: "actor not active" }, 409);
				nextClaimedLocalActor = claimedLocalActor ?? Boolean(actor.is_local);
			} else {
				nextClaimedLocalActor = claimedLocalActor ?? false;
			}
		} else if (claimedLocalActor !== undefined) {
			nextClaimedLocalActor = claimedLocalActor;
			if (claimedLocalActor) {
				nextActorId = store.actorId;
			} else if (nextActorId === store.actorId) {
				nextActorId = null;
			}
		}

		d.update(schema.syncPeers)
			.set({
				actor_id: nextActorId,
				claimed_local_actor: nextClaimedLocalActor ? 1 : 0,
			})
			.where(eq(schema.syncPeers.peer_device_id, peerDeviceId))
			.run();
		return c.json({ ok: true, actor_id: nextActorId, claimed_local_actor: nextClaimedLocalActor });
	});

	app.post("/api/sync/actors", async (c) => {
		const store = getStore();
		ensureLocalActorRecord(store);
		let body: Record<string, unknown>;
		try {
			body = await c.req.json<Record<string, unknown>>();
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		const displayName = String(body.display_name ?? "").trim();
		if (!displayName) return c.json({ error: "display_name required" }, 400);
		const d = drizzle(store.db, { schema });
		const now = new Date().toISOString();
		const actor = {
			actor_id: randomUUID(),
			display_name: displayName,
			is_local: 0,
			status: "active",
			merged_into_actor_id: null,
			created_at: now,
			updated_at: now,
		};
		d.insert(schema.actors).values(actor).run();
		return c.json(actor);
	});

	app.post("/api/sync/actors/rename", async (c) => {
		const store = getStore();
		ensureLocalActorRecord(store);
		let body: Record<string, unknown>;
		try {
			body = await c.req.json<Record<string, unknown>>();
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		const actorId = String(body.actor_id ?? "").trim();
		const displayName = String(body.display_name ?? "").trim();
		if (!actorId) return c.json({ error: "actor_id required" }, 400);
		if (!displayName) return c.json({ error: "display_name required" }, 400);
		const d = drizzle(store.db, { schema });
		const actor = d.select().from(schema.actors).where(eq(schema.actors.actor_id, actorId)).get();
		if (!actor) return c.json({ error: "actor not found" }, 404);
		const updatedAt = new Date().toISOString();
		d.update(schema.actors)
			.set({ display_name: displayName, updated_at: updatedAt })
			.where(eq(schema.actors.actor_id, actorId))
			.run();
		return c.json({ ...actor, display_name: displayName, updated_at: updatedAt });
	});

	app.post("/api/sync/actors/merge", async (c) => {
		const store = getStore();
		ensureLocalActorRecord(store);
		let body: Record<string, unknown>;
		try {
			body = await c.req.json<Record<string, unknown>>();
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		const primaryActorId = String(body.primary_actor_id ?? "").trim();
		const secondaryActorId = String(body.secondary_actor_id ?? "").trim();
		if (!primaryActorId) return c.json({ error: "primary_actor_id required" }, 400);
		if (!secondaryActorId) return c.json({ error: "secondary_actor_id required" }, 400);
		if (primaryActorId === secondaryActorId) return c.json({ error: "actor ids must differ" }, 400);
		const d = drizzle(store.db, { schema });
		const primary = d
			.select()
			.from(schema.actors)
			.where(eq(schema.actors.actor_id, primaryActorId))
			.get();
		const secondary = d
			.select()
			.from(schema.actors)
			.where(eq(schema.actors.actor_id, secondaryActorId))
			.get();
		if (!primary || !secondary) return c.json({ error: "actor not found" }, 404);
		if (primary.status !== "active") return c.json({ error: "primary actor not active" }, 409);
		if (secondary.status !== "active") return c.json({ error: "secondary actor not active" }, 409);
		if (secondary.is_local && secondary.actor_id === store.actorId) {
			return c.json({ error: "cannot merge this device's own local actor" }, 409);
		}
		const now = new Date().toISOString();
		const mergedCount = store.db.transaction(() => {
			const peerUpdate = d
				.update(schema.syncPeers)
				.set({ actor_id: primaryActorId })
				.where(eq(schema.syncPeers.actor_id, secondaryActorId))
				.run();
			if (primary.is_local) {
				d.update(schema.syncPeers)
					.set({ claimed_local_actor: 1 })
					.where(eq(schema.syncPeers.actor_id, primaryActorId))
					.run();
			}
			d.update(schema.actors)
				.set({ status: "merged", merged_into_actor_id: primaryActorId, updated_at: now })
				.where(eq(schema.actors.actor_id, secondaryActorId))
				.run();
			return Number(peerUpdate.changes ?? 0);
		})();
		return c.json({ merged_count: mergedCount });
	});

	app.post("/api/sync/actors/deactivate", async (c) => {
		const store = getStore();
		let body: Record<string, unknown>;
		try {
			body = await c.req.json<Record<string, unknown>>();
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		const actorId = String(body.actor_id ?? "").trim();
		if (!actorId) return c.json({ error: "actor_id required" }, 400);
		if (actorId === store.actorId) {
			return c.json({ error: "cannot deactivate this device's own local actor" }, 409);
		}
		const d = drizzle(store.db, { schema });
		const actor = d.select().from(schema.actors).where(eq(schema.actors.actor_id, actorId)).get();
		if (!actor) return c.json({ error: "actor not found" }, 404);
		if (actor.status !== "active") return c.json({ error: "actor not active" }, 409);
		const now = new Date().toISOString();
		d.update(schema.actors)
			.set({ status: "deactivated", updated_at: now })
			.where(eq(schema.actors.actor_id, actorId))
			.run();
		d.update(schema.syncPeers)
			.set({ actor_id: null })
			.where(eq(schema.syncPeers.actor_id, actorId))
			.run();
		return c.json({ ok: true });
	});

	app.post("/api/sync/legacy-devices/claim", async (c) => {
		const store = getStore();
		let body: Record<string, unknown>;
		try {
			body = await c.req.json<Record<string, unknown>>();
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		const originDeviceId = String(body.origin_device_id ?? "").trim();
		if (!originDeviceId) return c.json({ error: "origin_device_id required" }, 400);
		const updated = claimLegacyDeviceAsSelf(store, originDeviceId);
		if (updated <= 0) return c.json({ error: "legacy device not found" }, 404);
		return c.json({ ok: true, origin_device_id: originDeviceId, updated });
	});

	app.post("/api/sync/peers/accept-discovered", async (c) => {
		const store = getStore();
		let body: Record<string, unknown>;
		try {
			body = await c.req.json<Record<string, unknown>>();
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		const peerDeviceId = String(body.peer_device_id ?? "").trim();
		const fingerprint = String(body.fingerprint ?? "").trim();
		if (!peerDeviceId) return c.json({ error: "peer_device_id required" }, 400);
		if (!fingerprint) return c.json({ error: "fingerprint required" }, 400);
		try {
			const result = await acceptDiscoveredPeer(store, { peerDeviceId, fingerprint });
			if (!result.ok) {
				return c.json(
					{ error: result.error, detail: result.detail },
					{ status: result.status as 400 | 404 | 409 },
				);
			}
			return c.json({
				ok: true,
				peer_device_id: result.peer_device_id,
				created: result.created,
				updated: result.updated,
				name: result.name,
				needs_scope_review: true,
			});
		} catch (error) {
			return c.json(
				{
					error: "coordinator_lookup_failed",
					detail: error instanceof Error ? error.message : String(error),
				},
				{ status: 502 },
			);
		}
	});

	app.post("/api/sync/invites/create", async (c) => {
		let body: Record<string, unknown>;
		try {
			body = await c.req.json<Record<string, unknown>>();
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		const groupId = String(body.group_id ?? "").trim();
		const coordinatorUrl = body.coordinator_url == null ? null : String(body.coordinator_url ?? "");
		const policy = String(body.policy ?? "auto_admit").trim();
		const ttlHours = parseInviteTtlHours(body.ttl_hours);
		if (!groupId) return c.json({ error: "group_id required" }, 400);
		if (body.coordinator_url != null && typeof body.coordinator_url !== "string") {
			return c.json({ error: "coordinator_url must be string" }, 400);
		}
		if (!["auto_admit", "approval_required"].includes(policy)) {
			return c.json({ error: "policy must be auto_admit or approval_required" }, 400);
		}
		if (ttlHours == null) return c.json({ error: "ttl_hours must be an integer >= 1" }, 400);
		try {
			const config = readCoordinatorSyncConfig();
			const result = await coordinatorCreateInviteAction({
				groupId,
				coordinatorUrl,
				policy,
				ttlHours,
				createdBy: null,
				remoteUrl: config.syncCoordinatorUrl || null,
				adminSecret: config.syncCoordinatorAdminSecret || null,
			});
			return c.json(result);
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
		}
	});

	// POST /api/sync/invites/import accepts both team invites (coordinator
	// invite envelope or codemem:// link) and device-pairing payloads
	// (base64 JSON with { device_id, fingerprint, public_key, addresses }).
	// The server discriminates by decoding the pasted text — UI callers get
	// one textarea for both flows. Response carries `type: "team_join"` or
	// `type: "pair"` so the UI can render the right success message.
	app.post("/api/sync/invites/import", async (c) => {
		const store = getStore();
		let body: Record<string, unknown>;
		try {
			body = await c.req.json<Record<string, unknown>>();
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		const rawValue = String(body.invite ?? "").trim();
		if (!rawValue) return c.json({ error: "invite required" }, 400);

		// Users often paste the whole shell command emitted by the Pairing
		// diagnostics disclosure (`echo '<b64>' | base64 -d | codemem sync
		// pair --accept-file -`). Peel the base64 out if we see that shape.
		const shellMatch = rawValue.match(
			/echo\s+['"]([A-Za-z0-9+/=]+)['"]\s*\|\s*base64\s+-d\s*\|\s*codemem/,
		);
		const normalized = shellMatch?.[1]?.trim() || rawValue;

		const pairingResult = tryParsePairingPayload(normalized);
		if (pairingResult?.kind === "invalid-pair") {
			return c.json({ error: pairingResult.error }, 400);
		}
		if (pairingResult?.kind === "pair") {
			try {
				updatePeerAddresses(store.db, pairingResult.device_id, pairingResult.addresses, {
					pinnedFingerprint: pairingResult.fingerprint,
					publicKey: pairingResult.public_key,
				});
				return c.json({
					ok: true,
					type: "pair",
					peer_device_id: pairingResult.device_id,
				});
			} catch (error) {
				return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
			}
		}

		try {
			const result = await coordinatorImportInviteAction({
				inviteValue: rawValue,
				dbPath: store.dbPath,
			});
			return c.json({ ...result, type: "team_join" });
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
		}
	});

	app.get("/api/coordinator/admin/status", async (c) => {
		const status = coordinatorAdminStatusPayload();
		return c.json(status);
	});

	app.get("/api/coordinator/admin/groups", async (c) => {
		const config = readCoordinatorSyncConfig();
		const status = coordinatorAdminStatusPayload(config);
		if (status.readiness === "not_configured") {
			return c.json({ error: "coordinator_not_configured", status }, 400);
		}
		if (!status.has_admin_secret) {
			return c.json({ error: "coordinator_admin_secret_missing", status }, 400);
		}
		const includeArchived = queryBool(c.req.query("include_archived"));
		try {
			const items = await coordinatorListGroupsAction({
				includeArchived,
				remoteUrl: config.syncCoordinatorUrl || null,
				adminSecret: config.syncCoordinatorAdminSecret || null,
			});
			return c.json({ items, status });
		} catch (error) {
			const message = error instanceof Error ? error.message : "unknown";
			return c.json({ error: message, status }, coordinatorAdminMutationStatus(message));
		}
	});

	app.post("/api/coordinator/admin/groups", async (c) => {
		const config = readCoordinatorSyncConfig();
		const status = coordinatorAdminStatusPayload(config);
		if (status.readiness === "not_configured") {
			return c.json({ error: "coordinator_not_configured", status }, 400);
		}
		if (!status.has_admin_secret) {
			return c.json({ error: "coordinator_admin_secret_missing", status }, 400);
		}
		let body: Record<string, unknown>;
		try {
			body = await c.req.json<Record<string, unknown>>();
		} catch {
			return c.json({ error: "invalid json", status }, 400);
		}
		const groupId = String(body.group_id ?? "").trim();
		const displayName = String(body.display_name ?? "").trim() || null;
		if (!groupId) return c.json({ error: "group_id required", status }, 400);
		try {
			const group = await coordinatorCreateGroupAction({
				groupId,
				displayName,
				remoteUrl: config.syncCoordinatorUrl || null,
				adminSecret: config.syncCoordinatorAdminSecret || null,
			});
			return c.json({ ok: true, group, status });
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error), status }, 400);
		}
	});

	app.post("/api/coordinator/admin/groups/:group_id/rename", async (c) => {
		const config = readCoordinatorSyncConfig();
		const status = coordinatorAdminStatusPayload(config);
		if (status.readiness === "not_configured") {
			return c.json({ error: "coordinator_not_configured", status }, 400);
		}
		if (!status.has_admin_secret) {
			return c.json({ error: "coordinator_admin_secret_missing", status }, 400);
		}
		const groupId = String(c.req.param("group_id") ?? "").trim();
		if (!groupId) return c.json({ error: "group_id required", status }, 400);
		let body: Record<string, unknown>;
		try {
			body = await c.req.json<Record<string, unknown>>();
		} catch {
			return c.json({ error: "invalid json", status }, 400);
		}
		const displayName = String(body.display_name ?? "").trim();
		if (!displayName) return c.json({ error: "display_name required", status }, 400);
		try {
			const group = await coordinatorRenameGroupAction({
				groupId,
				displayName,
				remoteUrl: config.syncCoordinatorUrl || null,
				adminSecret: config.syncCoordinatorAdminSecret || null,
			});
			if (!group) return c.json({ error: "group_not_found", status }, 404);
			return c.json({ ok: true, group, status });
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error), status }, 400);
		}
	});

	app.post("/api/coordinator/admin/groups/:group_id/archive", async (c) => {
		const config = readCoordinatorSyncConfig();
		const status = coordinatorAdminStatusPayload(config);
		if (status.readiness === "not_configured") {
			return c.json({ error: "coordinator_not_configured", status }, 400);
		}
		if (!status.has_admin_secret) {
			return c.json({ error: "coordinator_admin_secret_missing", status }, 400);
		}
		const groupId = String(c.req.param("group_id") ?? "").trim();
		if (!groupId) return c.json({ error: "group_id required", status }, 400);
		try {
			const group = await coordinatorArchiveGroupAction({
				groupId,
				remoteUrl: config.syncCoordinatorUrl || null,
				adminSecret: config.syncCoordinatorAdminSecret || null,
			});
			if (!group) return c.json({ error: "group_not_found_or_already_archived", status }, 404);
			return c.json({ ok: true, group, status });
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error), status }, 400);
		}
	});

	app.post("/api/coordinator/admin/groups/:group_id/unarchive", async (c) => {
		const config = readCoordinatorSyncConfig();
		const status = coordinatorAdminStatusPayload(config);
		if (status.readiness === "not_configured") {
			return c.json({ error: "coordinator_not_configured", status }, 400);
		}
		if (!status.has_admin_secret) {
			return c.json({ error: "coordinator_admin_secret_missing", status }, 400);
		}
		const groupId = String(c.req.param("group_id") ?? "").trim();
		if (!groupId) return c.json({ error: "group_id required", status }, 400);
		try {
			const group = await coordinatorUnarchiveGroupAction({
				groupId,
				remoteUrl: config.syncCoordinatorUrl || null,
				adminSecret: config.syncCoordinatorAdminSecret || null,
			});
			if (!group) return c.json({ error: "group_not_found_or_not_archived", status }, 404);
			return c.json({ ok: true, group, status });
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error), status }, 400);
		}
	});

	app.get("/api/coordinator/admin/groups/:group_id/scopes", async (c) => {
		const config = readCoordinatorSyncConfig();
		const status = coordinatorAdminStatusPayload(config);
		const unavailable = coordinatorAdminUnavailable(status);
		if (unavailable) return c.json(unavailable.body, unavailable.httpStatus);
		const groupId = String(c.req.param("group_id") ?? "").trim();
		if (!groupId) return c.json({ error: "group_id required", status }, 400);
		try {
			const items = await coordinatorListScopesAction({
				groupId,
				includeInactive: queryBool(c.req.query("include_inactive")),
				remoteUrl: config.syncCoordinatorUrl || null,
				adminSecret: config.syncCoordinatorAdminSecret || null,
			});
			return c.json({ items, group_id: groupId, status });
		} catch (error) {
			const message = error instanceof Error ? error.message : "unknown";
			return c.json({ error: message, status }, coordinatorAdminMutationStatus(message));
		}
	});

	app.post("/api/coordinator/admin/groups/:group_id/scopes", async (c) => {
		const config = readCoordinatorSyncConfig();
		const status = coordinatorAdminStatusPayload(config);
		const unavailable = coordinatorAdminUnavailable(status);
		if (unavailable) return c.json(unavailable.body, unavailable.httpStatus);
		const groupId = String(c.req.param("group_id") ?? "").trim();
		if (!groupId) return c.json({ error: "group_id required", status }, 400);
		const body = await parseViewerJsonBody(c);
		if (!body) return c.json({ error: "invalid json", status }, 400);
		const scopeId = optionalViewerString(body, "scope_id");
		const label = optionalViewerString(body, "label");
		const membershipEpoch = optionalViewerNumber(body, "membership_epoch");
		if (!scopeId || !label) return c.json({ error: "scope_id and label required", status }, 400);
		if (Number.isNaN(membershipEpoch)) {
			return c.json({ error: "membership_epoch must be number", status }, 400);
		}
		try {
			const scope = await coordinatorCreateScopeAction({
				groupId,
				scopeId,
				label,
				kind: optionalViewerString(body, "kind"),
				authorityType: optionalViewerString(body, "authority_type"),
				coordinatorId: optionalViewerString(body, "coordinator_id"),
				manifestIssuerDeviceId: optionalViewerString(body, "manifest_issuer_device_id"),
				membershipEpoch,
				manifestHash: optionalViewerString(body, "manifest_hash"),
				status: optionalViewerString(body, "status"),
				remoteUrl: config.syncCoordinatorUrl || null,
				adminSecret: config.syncCoordinatorAdminSecret || null,
			});
			return c.json({ ok: true, scope, group_id: groupId, status });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return c.json({ error: message, status }, coordinatorAdminMutationStatus(message));
		}
	});

	app.patch("/api/coordinator/admin/groups/:group_id/scopes/:scope_id", async (c) => {
		const config = readCoordinatorSyncConfig();
		const status = coordinatorAdminStatusPayload(config);
		const unavailable = coordinatorAdminUnavailable(status);
		if (unavailable) return c.json(unavailable.body, unavailable.httpStatus);
		const groupId = String(c.req.param("group_id") ?? "").trim();
		const scopeId = String(c.req.param("scope_id") ?? "").trim();
		if (!groupId) return c.json({ error: "group_id required", status }, 400);
		if (!scopeId) return c.json({ error: "scope_id required", status }, 400);
		const body = await parseViewerJsonBody(c);
		if (!body) return c.json({ error: "invalid json", status }, 400);
		const membershipEpoch = optionalViewerNumber(body, "membership_epoch");
		if (Number.isNaN(membershipEpoch)) {
			return c.json({ error: "membership_epoch must be number", status }, 400);
		}
		try {
			const scope = await coordinatorUpdateScopeAction({
				groupId,
				scopeId,
				label: body.label === undefined ? undefined : optionalViewerString(body, "label"),
				kind: body.kind === undefined ? undefined : optionalViewerString(body, "kind"),
				authorityType:
					body.authority_type === undefined
						? undefined
						: optionalViewerString(body, "authority_type"),
				coordinatorId:
					body.coordinator_id === undefined
						? undefined
						: optionalViewerString(body, "coordinator_id"),
				manifestIssuerDeviceId:
					body.manifest_issuer_device_id === undefined
						? undefined
						: optionalViewerString(body, "manifest_issuer_device_id"),
				membershipEpoch,
				manifestHash:
					body.manifest_hash === undefined
						? undefined
						: optionalViewerString(body, "manifest_hash"),
				status: body.status === undefined ? undefined : optionalViewerString(body, "status"),
				remoteUrl: config.syncCoordinatorUrl || null,
				adminSecret: config.syncCoordinatorAdminSecret || null,
			});
			if (!scope) return c.json({ error: "scope_not_found", status }, 404);
			return c.json({ ok: true, scope, group_id: groupId, status });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return c.json({ error: message, status }, coordinatorAdminMutationStatus(message));
		}
	});

	app.get("/api/coordinator/admin/groups/:group_id/scopes/:scope_id/members", async (c) => {
		const config = readCoordinatorSyncConfig();
		const status = coordinatorAdminStatusPayload(config);
		const unavailable = coordinatorAdminUnavailable(status);
		if (unavailable) return c.json(unavailable.body, unavailable.httpStatus);
		const groupId = String(c.req.param("group_id") ?? "").trim();
		const scopeId = String(c.req.param("scope_id") ?? "").trim();
		if (!groupId) return c.json({ error: "group_id required", status }, 400);
		if (!scopeId) return c.json({ error: "scope_id required", status }, 400);
		try {
			const items = await coordinatorListScopeMembershipsAction({
				groupId,
				scopeId,
				includeRevoked: queryBool(c.req.query("include_revoked")),
				remoteUrl: config.syncCoordinatorUrl || null,
				adminSecret: config.syncCoordinatorAdminSecret || null,
			});
			return c.json({ items, group_id: groupId, scope_id: scopeId, status });
		} catch (error) {
			const message = error instanceof Error ? error.message : "unknown";
			return c.json({ error: message, status }, coordinatorAdminMutationStatus(message));
		}
	});

	app.post("/api/coordinator/admin/groups/:group_id/scopes/:scope_id/members", async (c) => {
		const config = readCoordinatorSyncConfig();
		const status = coordinatorAdminStatusPayload(config);
		const unavailable = coordinatorAdminUnavailable(status);
		if (unavailable) return c.json(unavailable.body, unavailable.httpStatus);
		const groupId = String(c.req.param("group_id") ?? "").trim();
		const scopeId = String(c.req.param("scope_id") ?? "").trim();
		if (!groupId) return c.json({ error: "group_id required", status }, 400);
		if (!scopeId) return c.json({ error: "scope_id required", status }, 400);
		const body = await parseViewerJsonBody(c);
		if (!body) return c.json({ error: "invalid json", status }, 400);
		const deviceId = optionalViewerString(body, "device_id");
		const membershipEpoch = optionalViewerNumber(body, "membership_epoch");
		if (!deviceId) return c.json({ error: "device_id required", status }, 400);
		if (Number.isNaN(membershipEpoch)) {
			return c.json({ error: "membership_epoch must be number", status }, 400);
		}
		try {
			const membership = await coordinatorGrantScopeMembershipAction({
				groupId,
				scopeId,
				deviceId,
				role: optionalViewerString(body, "role"),
				membershipEpoch,
				coordinatorId: optionalViewerString(body, "coordinator_id"),
				manifestIssuerDeviceId: optionalViewerString(body, "manifest_issuer_device_id"),
				manifestHash: optionalViewerString(body, "manifest_hash"),
				signedManifestJson: optionalViewerString(body, "signed_manifest_json"),
				remoteUrl: config.syncCoordinatorUrl || null,
				adminSecret: config.syncCoordinatorAdminSecret || null,
			});
			return c.json({ ok: true, membership, group_id: groupId, scope_id: scopeId, status });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return c.json({ error: message, status }, coordinatorAdminMutationStatus(message));
		}
	});

	app.post(
		"/api/coordinator/admin/groups/:group_id/scopes/:scope_id/members/:device_id/revoke",
		async (c) => {
			const config = readCoordinatorSyncConfig();
			const status = coordinatorAdminStatusPayload(config);
			const unavailable = coordinatorAdminUnavailable(status);
			if (unavailable) return c.json(unavailable.body, unavailable.httpStatus);
			const groupId = String(c.req.param("group_id") ?? "").trim();
			const scopeId = String(c.req.param("scope_id") ?? "").trim();
			const deviceId = String(c.req.param("device_id") ?? "").trim();
			if (!groupId) return c.json({ error: "group_id required", status }, 400);
			if (!scopeId) return c.json({ error: "scope_id required", status }, 400);
			if (!deviceId) return c.json({ error: "device_id required", status }, 400);
			const body = await parseViewerJsonBody(c, { allowEmpty: true });
			if (!body) return c.json({ error: "invalid json", status }, 400);
			const membershipEpoch = optionalViewerNumber(body, "membership_epoch");
			if (Number.isNaN(membershipEpoch)) {
				return c.json({ error: "membership_epoch must be number", status }, 400);
			}
			try {
				const ok = await coordinatorRevokeScopeMembershipAction({
					groupId,
					scopeId,
					deviceId,
					membershipEpoch,
					manifestHash: optionalViewerString(body, "manifest_hash"),
					signedManifestJson: optionalViewerString(body, "signed_manifest_json"),
					remoteUrl: config.syncCoordinatorUrl || null,
					adminSecret: config.syncCoordinatorAdminSecret || null,
				});
				if (!ok) return c.json({ error: "membership_not_found", status }, 404);
				return c.json({
					ok: true,
					group_id: groupId,
					scope_id: scopeId,
					device_id: deviceId,
					status,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return c.json({ error: message, status }, coordinatorAdminMutationStatus(message));
			}
		},
	);

	app.post("/api/coordinator/admin/invites", async (c) => {
		const config = readCoordinatorSyncConfig();
		const status = coordinatorAdminStatusPayload(config);
		if (status.readiness === "not_configured") {
			return c.json({ error: "coordinator_not_configured", status }, 400);
		}
		if (!status.has_admin_secret) {
			return c.json({ error: "coordinator_admin_secret_missing", status }, 400);
		}
		let body: Record<string, unknown>;
		try {
			body = await c.req.json<Record<string, unknown>>();
		} catch {
			return c.json({ error: "invalid json", status }, 400);
		}
		const groupId = resolveCoordinatorAdminGroup(String(body.group_id ?? "").trim(), status);
		const coordinatorUrl = body.coordinator_url == null ? null : String(body.coordinator_url ?? "");
		const policy = String(body.policy ?? "auto_admit").trim();
		const ttlHours = parseInviteTtlHours(body.ttl_hours);
		if (!groupId) return c.json({ error: "group_id required", status }, 400);
		if (body.coordinator_url != null && typeof body.coordinator_url !== "string") {
			return c.json({ error: "coordinator_url must be string", status }, 400);
		}
		if (!["auto_admit", "approval_required"].includes(policy)) {
			return c.json({ error: "policy must be auto_admit or approval_required", status }, 400);
		}
		if (ttlHours == null) {
			return c.json({ error: "ttl_hours must be an integer >= 1", status }, 400);
		}
		try {
			const result = await coordinatorCreateInviteAction({
				groupId,
				coordinatorUrl,
				policy,
				ttlHours,
				createdBy: null,
				remoteUrl: config.syncCoordinatorUrl || null,
				adminSecret: config.syncCoordinatorAdminSecret || null,
			});
			return c.json({ ...result, status });
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error), status }, 400);
		}
	});

	app.get("/api/coordinator/admin/join-requests", async (c) => {
		const config = readCoordinatorSyncConfig();
		const status = coordinatorAdminStatusPayload(config);
		if (status.readiness === "not_configured") {
			return c.json({ error: "coordinator_not_configured", status }, 400);
		}
		if (!status.has_admin_secret) {
			return c.json({ error: "coordinator_admin_secret_missing", status }, 400);
		}
		const groupId = resolveCoordinatorAdminGroup(c.req.query("group_id"), status);
		if (!groupId) return c.json({ error: "group_id_required", status }, 400);
		try {
			const items = await coordinatorListJoinRequestsAction({
				groupId,
				remoteUrl: status.coordinator_url,
				adminSecret: config.syncCoordinatorAdminSecret || null,
			});
			return c.json({ items, group_id: groupId, status });
		} catch (error) {
			const message = error instanceof Error ? error.message : "unknown";
			return c.json({ error: message, status }, coordinatorAdminMutationStatus(message));
		}
	});

	app.post("/api/coordinator/admin/join-requests/:request_id/approve", async (c) => {
		const config = readCoordinatorSyncConfig();
		const status = coordinatorAdminStatusPayload(config);
		if (status.readiness === "not_configured") {
			return c.json({ error: "coordinator_not_configured", status }, 400);
		}
		if (!status.has_admin_secret) {
			return c.json({ error: "coordinator_admin_secret_missing", status }, 400);
		}
		const requestId = String(c.req.param("request_id") ?? "").trim();
		if (!requestId) return c.json({ error: "request_id required", status }, 400);
		try {
			const result = await coordinatorReviewJoinRequestAction({
				requestId,
				approve: true,
				reviewedBy: null,
				remoteUrl: config.syncCoordinatorUrl || null,
				adminSecret: config.syncCoordinatorAdminSecret || null,
			});
			if (!result) return c.json({ error: "join request not found", status }, 404);
			return c.json({ ok: true, request: result, status });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return c.json(
				{ error: message, status },
				message.includes("request_not_found") || message.includes("not found") ? 404 : 400,
			);
		}
	});

	app.post("/api/coordinator/admin/join-requests/:request_id/deny", async (c) => {
		const config = readCoordinatorSyncConfig();
		const status = coordinatorAdminStatusPayload(config);
		if (status.readiness === "not_configured") {
			return c.json({ error: "coordinator_not_configured", status }, 400);
		}
		if (!status.has_admin_secret) {
			return c.json({ error: "coordinator_admin_secret_missing", status }, 400);
		}
		const requestId = String(c.req.param("request_id") ?? "").trim();
		if (!requestId) return c.json({ error: "request_id required", status }, 400);
		try {
			const result = await coordinatorReviewJoinRequestAction({
				requestId,
				approve: false,
				reviewedBy: null,
				remoteUrl: config.syncCoordinatorUrl || null,
				adminSecret: config.syncCoordinatorAdminSecret || null,
			});
			if (!result) return c.json({ error: "join request not found", status }, 404);
			return c.json({ ok: true, request: result, status });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return c.json(
				{ error: message, status },
				message.includes("request_not_found") || message.includes("not found") ? 404 : 400,
			);
		}
	});

	app.get("/api/coordinator/admin/devices", async (c) => {
		const config = readCoordinatorSyncConfig();
		const status = coordinatorAdminStatusPayload(config);
		if (status.readiness === "not_configured") {
			return c.json({ error: "coordinator_not_configured", status }, 400);
		}
		if (!status.has_admin_secret) {
			return c.json({ error: "coordinator_admin_secret_missing", status }, 400);
		}
		const groupId = resolveCoordinatorAdminGroup(c.req.query("group_id"), status);
		if (!groupId) return c.json({ error: "group_id_required", status }, 400);
		try {
			const items = await coordinatorListDevicesAction({
				groupId,
				includeDisabled: queryBool(c.req.query("include_disabled")),
				remoteUrl: status.coordinator_url,
				adminSecret: config.syncCoordinatorAdminSecret || null,
			});
			return c.json({ items, group_id: groupId, status });
		} catch (error) {
			const message = error instanceof Error ? error.message : "unknown";
			return c.json({ error: message, status }, coordinatorAdminMutationStatus(message));
		}
	});

	app.post("/api/coordinator/admin/devices/:device_id/rename", async (c) => {
		const config = readCoordinatorSyncConfig();
		const status = coordinatorAdminStatusPayload(config);
		if (status.readiness === "not_configured") {
			return c.json({ error: "coordinator_not_configured", status }, 400);
		}
		if (!status.has_admin_secret) {
			return c.json({ error: "coordinator_admin_secret_missing", status }, 400);
		}
		const deviceId = String(c.req.param("device_id") ?? "").trim();
		if (!deviceId) return c.json({ error: "device_id required", status }, 400);
		let body: Record<string, unknown>;
		try {
			body = await c.req.json<Record<string, unknown>>();
		} catch {
			return c.json({ error: "invalid json", status }, 400);
		}
		const groupId = resolveCoordinatorAdminGroup(String(body.group_id ?? "").trim(), status);
		const displayName = String(body.display_name ?? "").trim();
		if (!groupId) return c.json({ error: "group_id required", status }, 400);
		if (!displayName) return c.json({ error: "display_name required", status }, 400);
		try {
			const device = await coordinatorRenameDeviceAction({
				groupId,
				deviceId,
				displayName,
				remoteUrl: config.syncCoordinatorUrl || null,
				adminSecret: config.syncCoordinatorAdminSecret || null,
			});
			if (!device) return c.json({ error: "device_not_found", status }, 404);
			return c.json({ ok: true, device, status });
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error), status }, 400);
		}
	});

	app.post("/api/coordinator/admin/devices/:device_id/disable", async (c) => {
		const config = readCoordinatorSyncConfig();
		const status = coordinatorAdminStatusPayload(config);
		if (status.readiness === "not_configured") {
			return c.json({ error: "coordinator_not_configured", status }, 400);
		}
		if (!status.has_admin_secret) {
			return c.json({ error: "coordinator_admin_secret_missing", status }, 400);
		}
		const deviceId = String(c.req.param("device_id") ?? "").trim();
		if (!deviceId) return c.json({ error: "device_id required", status }, 400);
		const groupId = resolveCoordinatorAdminGroup(c.req.query("group_id"), status);
		if (!groupId) return c.json({ error: "group_id required", status }, 400);
		try {
			const ok = await coordinatorDisableDeviceAction({
				groupId,
				deviceId,
				remoteUrl: config.syncCoordinatorUrl || null,
				adminSecret: config.syncCoordinatorAdminSecret || null,
			});
			if (!ok) return c.json({ error: "device_not_found", status }, 404);
			return c.json({ ok: true, device_id: deviceId, status });
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error), status }, 400);
		}
	});

	app.post("/api/coordinator/admin/devices/:device_id/enable", async (c) => {
		const config = readCoordinatorSyncConfig();
		const status = coordinatorAdminStatusPayload(config);
		if (status.readiness === "not_configured") {
			return c.json({ error: "coordinator_not_configured", status }, 400);
		}
		if (!status.has_admin_secret) {
			return c.json({ error: "coordinator_admin_secret_missing", status }, 400);
		}
		const deviceId = String(c.req.param("device_id") ?? "").trim();
		if (!deviceId) return c.json({ error: "device_id required", status }, 400);
		const groupId = resolveCoordinatorAdminGroup(c.req.query("group_id"), status);
		if (!groupId) return c.json({ error: "group_id required", status }, 400);
		try {
			const ok = await coordinatorEnableDeviceAction({
				groupId,
				deviceId,
				remoteUrl: config.syncCoordinatorUrl || null,
				adminSecret: config.syncCoordinatorAdminSecret || null,
			});
			if (!ok) return c.json({ error: "device_not_found", status }, 404);
			return c.json({ ok: true, device_id: deviceId, status });
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error), status }, 400);
		}
	});

	// Unified peer-enrollment entry point. Mode is chosen by an explicit
	// body field so a legitimate coordinator group named (for example)
	// `none` cannot collide with the manual-pairing path:
	//   - `mode: "discovered"` (default) → promote a coordinator-discovered
	//     device, seed scope from the :group_id group's template when
	//     auto_seed_scope is true and the caller didn't pass an override.
	//   - `mode: "manual"` → manual pairing. Accepts peer_public_key +
	//     optional name/fingerprint/addresses; :group_id path param is
	//     ignored and both discovery columns are left null.
	// See docs/plans/2026-04-22-multi-team-coordinator-groups-design.md.
	app.post("/api/coordinator/admin/groups/:group_id/enroll-peer", async (c) => {
		const config = readCoordinatorSyncConfig();
		const status = coordinatorAdminStatusPayload(config);
		if (status.readiness === "not_configured") {
			return c.json({ error: "coordinator_not_configured", status }, 400);
		}
		// Admin-secret gating happens inside the discovered branch below —
		// manual pairing only writes a local sync_peers row and doesn't need
		// coordinator-admin privileges, matching the pre-existing /peers/accept
		// path.
		const rawGroupId = String(c.req.param("group_id") ?? "").trim();
		if (!rawGroupId) return c.json({ error: "group_id required" }, 400);
		let body: Record<string, unknown>;
		try {
			body = await c.req.json<Record<string, unknown>>();
		} catch {
			return c.json({ error: "invalid_json" }, 400);
		}
		const rawMode = String(body.mode ?? "")
			.trim()
			.toLowerCase();
		if (rawMode && rawMode !== "manual" && rawMode !== "discovered") {
			return c.json(
				{ error: "invalid_mode", detail: `mode must be 'discovered' or 'manual', got ${rawMode}` },
				400,
			);
		}
		const mode: "discovered" | "manual" = rawMode === "manual" ? "manual" : "discovered";
		// Per-field normalization: distinguish "caller did not specify" from
		// "caller set empty". `undefined` = inherit (template); `null` or empty
		// array = explicit clear; non-empty array = use as-is.
		const normalizeOverride = (value: unknown): string[] | null | undefined => {
			if (value === undefined) return undefined;
			if (value === null) return null;
			if (!Array.isArray(value)) return undefined;
			const cleaned = value
				.map((item) => String(item ?? "").trim())
				.filter((item) => item.length > 0);
			return cleaned.length === 0 ? null : cleaned;
		};
		const overrideInclude = normalizeOverride(body.projects_include);
		const overrideExclude = normalizeOverride(body.projects_exclude);
		const scopeOverride =
			overrideInclude === undefined && overrideExclude === undefined
				? undefined
				: { projects_include: overrideInclude, projects_exclude: overrideExclude };
		const store = getStore();

		if (mode === "manual") {
			const peerDeviceId = String(body.peer_device_id ?? "").trim();
			const publicKey = String(body.peer_public_key ?? "").trim();
			const name = String(body.name ?? "").trim() || null;
			const fingerprint = String(body.fingerprint ?? "").trim() || null;
			const addressesInput = Array.isArray(body.peer_addresses) ? body.peer_addresses : [];
			const addresses = addressesInput
				.map((item) => String(item ?? "").trim())
				.filter((item) => item.length > 0);
			if (!peerDeviceId || !publicKey) {
				return c.json({ error: "peer_device_id_and_public_key_required" }, 400);
			}
			const manualInclude =
				overrideInclude && overrideInclude.length > 0 ? JSON.stringify(overrideInclude) : null;
			const manualExclude =
				overrideExclude && overrideExclude.length > 0 ? JSON.stringify(overrideExclude) : null;
			const now = new Date().toISOString();
			const d = drizzle(store.db, { schema });
			// Wrap the duplicate check + insert in a transaction so two concurrent
			// enrolls for the same peer cannot both clear the check. SQLite
			// serializes transactions on the write lock, so the second one sees
			// the committed row and returns 409 instead of racing past.
			try {
				const created = store.db.transaction(() => {
					const existing = d
						.select({ peer_device_id: schema.syncPeers.peer_device_id })
						.from(schema.syncPeers)
						.where(eq(schema.syncPeers.peer_device_id, peerDeviceId))
						.get();
					if (existing) return false;
					d.insert(schema.syncPeers)
						.values({
							peer_device_id: peerDeviceId,
							name,
							pinned_fingerprint: fingerprint,
							public_key: publicKey,
							addresses_json: JSON.stringify(addresses),
							projects_include_json: manualInclude,
							projects_exclude_json: manualExclude,
							created_at: now,
							last_seen_at: now,
							discovered_via_coordinator_id: null,
							discovered_via_group_id: null,
						})
						.run();
					return true;
				})();
				if (!created) {
					return c.json({ error: "peer_exists", detail: "Peer is already enrolled." }, 409);
				}
			} catch (error) {
				// Primary-key constraint collision is the expected race signal; the
				// first writer wins, the second gets "peer_exists".
				const msg = error instanceof Error ? error.message.toLowerCase() : "";
				if (msg.includes("unique") || msg.includes("primary key")) {
					return c.json({ error: "peer_exists", detail: "Peer is already enrolled." }, 409);
				}
				throw error;
			}
			return c.json({
				ok: true,
				peer_device_id: peerDeviceId,
				created: true,
				updated: false,
				name,
				group_id: null,
			});
		}

		// Discovered mode calls out to the coordinator for reciprocal approval,
		// so it needs the admin secret. Manual mode never leaves this process.
		if (!status.has_admin_secret) {
			return c.json({ error: "coordinator_admin_secret_missing", status }, 400);
		}
		const peerDeviceId = String(body.peer_device_id ?? body.discovered_device_id ?? "").trim();
		const fingerprint = String(body.fingerprint ?? "").trim();
		if (!peerDeviceId || !fingerprint) {
			return c.json({ error: "peer_device_id_and_fingerprint_required" }, 400);
		}
		try {
			const result = await acceptDiscoveredPeer(store, {
				peerDeviceId,
				fingerprint,
				expectedGroupId: rawGroupId,
				scopeOverride,
			});
			if (result.ok) {
				return c.json(result);
			}
			return c.json(
				{ error: result.error, detail: result.detail },
				result.status as 400 | 404 | 409,
			);
		} catch (error) {
			// acceptDiscoveredPeer shells out to the coordinator for reciprocal
			// approval and can throw on timeout / network / auth failures. Map
			// those to a structured 502 so clients get the same shape as the
			// legacy /api/sync/peers/accept-discovered path.
			return c.json(
				{
					error: "coordinator_lookup_failed",
					detail: error instanceof Error ? error.message : String(error),
				},
				502,
			);
		}
	});

	// Local-only preferences for a coordinator group — project-scope template
	// + auto-seed toggle applied when peers are enrolled through the group.
	// See docs/plans/2026-04-22-multi-team-coordinator-groups-design.md.
	// Local-only preferences — these rows live in the viewer's own DB and never
	// cross the wire to the coordinator. No admin-secret gate: the admin secret
	// authorizes remote coordinator mutations, not local settings.
	app.get("/api/coordinator/admin/groups/:group_id/preferences", (c) => {
		const config = readCoordinatorSyncConfig();
		const status = coordinatorAdminStatusPayload(config);
		if (status.readiness === "not_configured") {
			return c.json({ error: "coordinator_not_configured", status }, 400);
		}
		const groupId = String(c.req.param("group_id") ?? "").trim();
		if (!groupId) return c.json({ error: "group_id required", status }, 400);
		const coordinatorId = status.coordinator_url;
		if (!coordinatorId) return c.json({ error: "coordinator_not_configured", status }, 400);
		const store = getStore();
		const existing = getCoordinatorGroupPreference(store.db, coordinatorId, groupId);
		if (existing) return c.json({ preferences: existing, status });
		return c.json({
			preferences: {
				coordinator_id: coordinatorId,
				group_id: groupId,
				projects_include: null,
				projects_exclude: null,
				auto_seed_scope: true,
				updated_at: null,
			},
			status,
		});
	});

	app.put("/api/coordinator/admin/groups/:group_id/preferences", async (c) => {
		const config = readCoordinatorSyncConfig();
		const status = coordinatorAdminStatusPayload(config);
		if (status.readiness === "not_configured") {
			return c.json({ error: "coordinator_not_configured", status }, 400);
		}
		const groupId = String(c.req.param("group_id") ?? "").trim();
		if (!groupId) return c.json({ error: "group_id required", status }, 400);
		const coordinatorId = status.coordinator_url;
		if (!coordinatorId) return c.json({ error: "coordinator_not_configured", status }, 400);
		let body: Record<string, unknown>;
		try {
			body = await c.req.json<Record<string, unknown>>();
		} catch {
			return c.json({ error: "invalid_json", status }, 400);
		}
		const normalizeList = (value: unknown): string[] | null | undefined => {
			if (value === undefined) return undefined;
			if (value === null) return null;
			if (!Array.isArray(value)) return undefined;
			const cleaned = value
				.map((item) => String(item ?? "").trim())
				.filter((item) => item.length > 0);
			return cleaned.length === 0 ? null : cleaned;
		};
		const autoSeed = typeof body.auto_seed_scope === "boolean" ? body.auto_seed_scope : undefined;
		const store = getStore();
		try {
			const preferences = upsertCoordinatorGroupPreference(store.db, {
				coordinator_id: coordinatorId,
				group_id: groupId,
				projects_include: normalizeList(body.projects_include),
				projects_exclude: normalizeList(body.projects_exclude),
				auto_seed_scope: autoSeed,
			});
			return c.json({ preferences, status });
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return c.json({ error: msg, status }, 400);
		}
	});

	app.post("/api/coordinator/admin/devices/:device_id/remove", async (c) => {
		const config = readCoordinatorSyncConfig();
		const status = coordinatorAdminStatusPayload(config);
		if (status.readiness === "not_configured") {
			return c.json({ error: "coordinator_not_configured", status }, 400);
		}
		if (!status.has_admin_secret) {
			return c.json({ error: "coordinator_admin_secret_missing", status }, 400);
		}
		const deviceId = String(c.req.param("device_id") ?? "").trim();
		if (!deviceId) return c.json({ error: "device_id required", status }, 400);
		const groupId = resolveCoordinatorAdminGroup(c.req.query("group_id"), status);
		if (!groupId) return c.json({ error: "group_id required", status }, 400);
		try {
			const ok = await coordinatorRemoveDeviceAction({
				groupId,
				deviceId,
				remoteUrl: config.syncCoordinatorUrl || null,
				adminSecret: config.syncCoordinatorAdminSecret || null,
			});
			if (!ok) return c.json({ error: "device_not_found", status }, 404);
			return c.json({ ok: true, device_id: deviceId, status });
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error), status }, 400);
		}
	});

	app.get("/api/sync/bootstrap-grants", async (c) => {
		const groupId = String(c.req.query("group_id") ?? "").trim();
		if (!groupId) return c.json({ error: "group_id_required" }, 400);
		const config = readCoordinatorSyncConfig();
		try {
			const items = await coordinatorListBootstrapGrantsAction({
				groupId,
				remoteUrl: config.syncCoordinatorUrl || null,
				adminSecret: config.syncCoordinatorAdminSecret || null,
			});
			return c.json({ items });
		} catch (error) {
			const message = error instanceof Error ? error.message : "unknown";
			return c.json({ error: message }, 500);
		}
	});

	app.post("/api/sync/bootstrap-grants/revoke", async (c) => {
		let body: Record<string, unknown>;
		try {
			body = await c.req.json<Record<string, unknown>>();
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		const grantId = String(body.grant_id ?? "").trim();
		if (!grantId) return c.json({ error: "grant_id_required" }, 400);
		const config = readCoordinatorSyncConfig();
		try {
			const ok = await coordinatorRevokeBootstrapGrantAction({
				grantId,
				remoteUrl: config.syncCoordinatorUrl || null,
				adminSecret: config.syncCoordinatorAdminSecret || null,
			});
			if (!ok) return c.json({ error: "grant_not_found" }, 404);
			return c.json({ ok: true, grant_id: grantId });
		} catch (error) {
			const message = error instanceof Error ? error.message : "unknown";
			return c.json({ error: message }, 500);
		}
	});

	// DELETE /api/sync/peers/:peer_device_id
	app.delete("/api/sync/peers/:peer_device_id", (c) => {
		const store = getStore();
		{
			const d = drizzle(store.db, { schema });
			const peerDeviceId = c.req.param("peer_device_id")?.trim();
			if (!peerDeviceId) return c.json({ error: "peer_device_id required" }, 400);
			const exists = d
				.select({ peer_device_id: schema.syncPeers.peer_device_id })
				.from(schema.syncPeers)
				.where(eq(schema.syncPeers.peer_device_id, peerDeviceId))
				.get();
			if (!exists) return c.json({ error: "peer not found" }, 404);
			d.delete(schema.replicationCursors)
				.where(eq(schema.replicationCursors.peer_device_id, peerDeviceId))
				.run();
			d.delete(schema.syncPeers).where(eq(schema.syncPeers.peer_device_id, peerDeviceId)).run();
			return c.json({ ok: true });
		}
	});

	return app;
}
