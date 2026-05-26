/**
 * Sync routes — status, peers, actors, attempts, pairing, mutations.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import type {
	CoordinatorBootstrapGrantVerification,
	CoordinatorScope,
	CoordinatorScopeMembership,
	MaintenanceJobSnapshot,
	MemoryStore,
	ProjectScopeGuardrailWarning,
	ReplicationOp,
	SemanticIndexDiagnostics,
} from "@codemem/core";
import {
	addSyncScopeToBoundary,
	analyzeProjectScopeMappingChangeGuardrails,
	applyReplicationOps,
	buildBaseUrl,
	canonicalWorkspaceIdentity,
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
	defaultSpaceScopeIdForGroup,
	deleteProjectScopeSettingsMapping,
	ensureDeviceIdentity,
	extractReplicationOps,
	type FilterReplicationSkipped,
	filterReplicationOpsForSyncWithStatus,
	fingerprintPublicKey,
	formatHostPort,
	getCoordinatorGroupPreference,
	getSemanticIndexDiagnostics,
	getSyncResetState,
	type InboundScopeRejectionPeerSummary,
	isScopedSyncCapability,
	LEGACY_SHARED_REVIEW_SCOPE_ID,
	LOCAL_DEFAULT_SCOPE_ID,
	LOCAL_SYNC_CAPABILITY,
	listAuthorizedScopesForPeer,
	listCoordinatorJoinRequests,
	listInboundScopeRejections,
	listMaintenanceJobs,
	listPerPeerScopeSyncState,
	listProjectScopeCandidates,
	listProjectScopeInventory,
	listProjectScopeSettingsMappings,
	listSharingDomainSettingsScopes,
	loadMemorySnapshotPageForPeer,
	loadReplicationOpsForPeer,
	lookupCoordinatorPeers,
	mergeAddresses,
	negotiateSyncCapability,
	normalizeAddress,
	normalizeSyncCapability,
	parseSyncScopeRequest,
	personalScopeGrantStatusForPeer,
	readCodememConfigFile,
	readCoordinatorSyncConfig,
	reassignProjectScopeInventoryProject,
	recordNonce,
	rejectInboundScopeFailures,
	requestJson,
	runSyncPass,
	SYNC_CAPABILITY_HEADER,
	SYNC_SCOPE_QUERY_PARAM,
	schema,
	summarizeInboundScopeRejections,
	syncScopeResetRequiredPayload,
	updatePeerAddresses,
	upsertCoordinatorGroupPreference,
	upsertProjectScopeSettingsMapping,
	verifySignature,
	writeCodememConfigFile,
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

type SafeSkippedSyncDetail = Pick<
	FilterReplicationSkipped,
	"reason" | "skipped_count" | "scope_id" | "project" | "visibility"
>;

function safeSkippedSyncDetail(
	detail: FilterReplicationSkipped | null | undefined,
): SafeSkippedSyncDetail | null {
	if (!detail) return null;
	return {
		reason: detail.reason,
		skipped_count: detail.skipped_count,
		scope_id: detail.scope_id ?? null,
		project: detail.project ?? null,
		visibility: detail.visibility ?? null,
	};
}

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

async function ensureDefaultSpaceForTeam(opts: {
	store: MemoryStore;
	config: ReturnType<typeof readCoordinatorSyncConfig>;
	groupId: string;
	displayName: string | null;
}): Promise<{
	scope: CoordinatorScope | null;
	membership: CoordinatorScopeMembership | null;
	preferences: ReturnType<typeof upsertCoordinatorGroupPreference>;
}> {
	const coordinatorId = opts.config.syncCoordinatorUrl || null;
	if (!coordinatorId) throw new Error("coordinator_not_configured");
	const scopeId = defaultSpaceScopeIdForGroup(opts.groupId);
	const label = opts.displayName || opts.groupId;
	const existingScopes = await coordinatorListScopesAction({
		groupId: opts.groupId,
		includeInactive: false,
		remoteUrl: opts.config.syncCoordinatorUrl || null,
		adminSecret: opts.config.syncCoordinatorAdminSecret || null,
	});
	const existingScope = existingScopes.find((scope) => scope.scope_id === scopeId) ?? null;
	const scope =
		existingScope ??
		(await coordinatorCreateScopeAction({
			groupId: opts.groupId,
			scopeId,
			label,
			kind: "team_default",
			authorityType: "coordinator",
			coordinatorId,
			membershipEpoch: 1,
			status: "active",
			remoteUrl: opts.config.syncCoordinatorUrl || null,
			adminSecret: opts.config.syncCoordinatorAdminSecret || null,
		}));
	const [deviceId] = ensureDeviceIdentity(opts.store.db, { keysDir: syncKeysDir() });
	const membership = await coordinatorGrantScopeMembershipAction({
		groupId: opts.groupId,
		scopeId,
		deviceId,
		role: "admin",
		membershipEpoch: 1,
		coordinatorId,
		remoteUrl: opts.config.syncCoordinatorUrl || null,
		adminSecret: opts.config.syncCoordinatorAdminSecret || null,
	});
	const preferences = upsertCoordinatorGroupPreference(opts.store.db, {
		coordinator_id: coordinatorId,
		group_id: opts.groupId,
		default_space_scope_id: scopeId,
		auto_grant_default_space_on_join: true,
	});
	return { scope, membership, preferences };
}

async function maybeGrantDefaultSpaceOnJoin(opts: {
	store: MemoryStore;
	config: ReturnType<typeof readCoordinatorSyncConfig>;
	groupId: string;
	deviceId: string;
}): Promise<CoordinatorScopeMembership | null> {
	const coordinatorId = opts.config.syncCoordinatorUrl || null;
	if (!coordinatorId) return null;
	const preferences = getCoordinatorGroupPreference(opts.store.db, coordinatorId, opts.groupId);
	if (!preferences?.auto_grant_default_space_on_join) return null;
	const scopeId = preferences.default_space_scope_id?.trim();
	if (!scopeId) return null;
	if (scopeId !== defaultSpaceScopeIdForGroup(opts.groupId)) return null;
	const scopes = await coordinatorListScopesAction({
		groupId: opts.groupId,
		includeInactive: false,
		remoteUrl: opts.config.syncCoordinatorUrl || null,
		adminSecret: opts.config.syncCoordinatorAdminSecret || null,
	});
	const defaultScope = scopes.find((scope) => scope.scope_id === scopeId) ?? null;
	if (!defaultScope || defaultScope.kind !== "team_default") return null;
	return await coordinatorGrantScopeMembershipAction({
		groupId: opts.groupId,
		scopeId,
		deviceId: opts.deviceId,
		role: "member",
		membershipEpoch: 1,
		coordinatorId,
		remoteUrl: opts.config.syncCoordinatorUrl || null,
		adminSecret: opts.config.syncCoordinatorAdminSecret || null,
	});
}

function removeConfiguredCoordinatorGroup(groupId: string): string[] {
	const targetGroup = groupId.trim();
	if (!targetGroup) return [];
	const config = readCodememConfigFile();
	const rawGroups = config.sync_coordinator_groups;
	const groups = Array.isArray(rawGroups)
		? rawGroups.map((group) => String(group).trim()).filter(Boolean)
		: typeof rawGroups === "string"
			? rawGroups
					.split(",")
					.map((group) => group.trim())
					.filter(Boolean)
			: typeof config.sync_coordinator_group === "string" && config.sync_coordinator_group.trim()
				? [config.sync_coordinator_group.trim()]
				: [];
	const nextGroups = groups.filter((group) => group !== targetGroup);
	if (nextGroups.length === groups.length) return groups;
	config.sync_coordinator_groups = nextGroups;
	if (nextGroups.length) config.sync_coordinator_group = nextGroups[0];
	else delete config.sync_coordinator_group;
	writeCodememConfigFile(config);
	return nextGroups;
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

function optionalViewerStrictString(body: Record<string, unknown>, key: string): string | null {
	const value = body[key];
	if (value == null) return null;
	if (typeof value !== "string") throw new Error(`${key} must be string`);
	return value.trim() || null;
}

function optionalViewerStringList(body: Record<string, unknown>, key: string): string[] {
	const value = body[key];
	if (value == null) return [];
	if (!Array.isArray(value)) throw new Error(`${key} must be an array of strings`);
	return [
		...new Set(
			value
				.map((item) => {
					if (typeof item !== "string") throw new Error(`${key} must be an array of strings`);
					return item.trim();
				})
				.filter(Boolean),
		),
	];
}

function optionalViewerNumber(body: Record<string, unknown>, key: string): number | null {
	const value = body[key];
	if (value == null || value === "") return null;
	const number = typeof value === "number" ? value : Number(value);
	return Number.isFinite(number) ? Math.trunc(number) : Number.NaN;
}

function optionalViewerInteger(body: Record<string, unknown>, key: string): number | null {
	const value = body[key];
	if (value == null || value === "") return null;
	const number = typeof value === "number" ? value : Number(value);
	return Number.isInteger(number) ? number : Number.NaN;
}

function missingGuardrailConfirmations(
	warnings: ProjectScopeGuardrailWarning[],
	confirmedTokens: string[],
): ProjectScopeGuardrailWarning[] {
	const confirmed = new Set(confirmedTokens);
	return warnings.filter(
		(warning) =>
			warning.requires_confirmation &&
			(!warning.confirmation_token || !confirmed.has(warning.confirmation_token)),
	);
}

function parseViewerProjectMappingInput(body: Record<string, unknown>) {
	const id = optionalViewerInteger(body, "id");
	const priority = optionalViewerInteger(body, "priority");
	if (Number.isNaN(id)) throw new Error("id must be an integer");
	if (Number.isNaN(priority)) throw new Error("priority must be an integer");
	return {
		id,
		workspace_identity: optionalViewerStrictString(body, "workspace_identity"),
		project_pattern: optionalViewerStrictString(body, "project_pattern"),
		scope_id: optionalViewerStrictString(body, "scope_id") ?? "",
		priority,
		source: optionalViewerStrictString(body, "source") ?? "user",
	};
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
			{ defaultHttpPort: config.syncPort },
		);
	}
	if (config.syncHost && config.syncHost !== "0.0.0.0") {
		return [normalizeAddress(formatHostPort(config.syncHost, config.syncPort))].filter(Boolean);
	}
	const addresses = Object.values(networkInterfaces())
		.flatMap((entries) => entries ?? [])
		.filter((entry) => !entry.internal)
		.map((entry) => entry.address)
		.filter((address) => address && address !== "127.0.0.1" && address !== "::1")
		.map((address) => normalizeAddress(formatHostPort(address, config.syncPort)))
		.filter(Boolean);
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

const SYNC_AUTH_STORE_BUSY_REASON = "sync_auth_store_busy";

type SyncAuthResult = { ok: boolean; reason: string; deviceId: string };

function isSqliteBusy(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const code = "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
	const message = err instanceof Error ? err.message : "";
	return code === "SQLITE_BUSY" || message.includes("database is locked");
}

function recordSyncAuthNonce(
	store: MemoryStore,
	deviceId: string,
	nonce: string,
	createdAt: string,
): SyncAuthResult | null {
	try {
		if (!recordNonce(store.db, deviceId, nonce, createdAt)) {
			return { ok: false, reason: "nonce_replay", deviceId };
		}
	} catch (err) {
		if (isSqliteBusy(err)) {
			return { ok: false, reason: SYNC_AUTH_STORE_BUSY_REASON, deviceId };
		}
		throw err;
	}

	const cutoff = new Date(Date.now() - DEFAULT_TIME_WINDOW_S * 2 * 1000).toISOString();
	try {
		cleanupNonces(store.db, cutoff);
	} catch (err) {
		if (!isSqliteBusy(err)) throw err;
		// Nonce cleanup is best-effort. A lock here should not fail a request
		// after its nonce was already recorded; the next request can prune.
	}
	return null;
}

function isSyncAuthStoreBusy(auth: SyncAuthResult): boolean {
	return !auth.ok && auth.reason === SYNC_AUTH_STORE_BUSY_REASON;
}

function syncAuthStoreBusyResponse(c: Context) {
	c.header("Retry-After", "1");
	return c.json({ error: SYNC_AUTH_STORE_BUSY_REASON }, 503);
}

function authorizeSyncRequest(
	store: MemoryStore,
	request: { method: string; url: string; header(name: string): string | undefined },
	body: Buffer,
): SyncAuthResult {
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
	const nonceResult = recordSyncAuthNonce(store, deviceId, nonce, createdAt);
	if (nonceResult) return nonceResult;
	return { ok: true, reason: "ok", deviceId };
}

async function authorizeBootstrapGrantRequest(
	store: MemoryStore,
	request: { method: string; url: string; header(name: string): string | undefined },
	body: Buffer,
): Promise<SyncAuthResult> {
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
	const nonceResult = recordSyncAuthNonce(store, deviceId, nonce, createdAt);
	if (nonceResult) return nonceResult;
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

function cleanPeerScopeText(value: unknown): string | null {
	const text = String(value ?? "").trim();
	return text || null;
}

function peerAuthorizedScopes(store: MemoryStore, peerDeviceId: string): Record<string, unknown>[] {
	const deviceId = peerDeviceId.trim();
	if (!deviceId) return [];
	const rows = store.db
		.prepare(
			`SELECT
				rs.scope_id,
				rs.label,
				rs.kind,
				rs.authority_type,
				rs.coordinator_id,
				rs.group_id,
				sm.role,
				sm.membership_epoch,
				sm.updated_at
			 FROM scope_memberships sm
			 JOIN replication_scopes rs ON rs.scope_id = sm.scope_id
			 WHERE sm.device_id = ?
			   AND sm.status = 'active'
			   AND rs.status = 'active'
			   AND sm.membership_epoch >= rs.membership_epoch
			 ORDER BY CASE WHEN rs.authority_type = 'local' THEN 1 ELSE 0 END,
			          rs.label COLLATE NOCASE,
			          rs.scope_id`,
		)
		.all(deviceId) as Array<Record<string, unknown>>;
	return rows.map((row) => ({
		scope_id: String(row.scope_id ?? ""),
		label: String(row.label ?? row.scope_id ?? ""),
		kind: String(row.kind ?? "user"),
		authority_type: String(row.authority_type ?? "local"),
		coordinator_id: cleanPeerScopeText(row.coordinator_id),
		group_id: cleanPeerScopeText(row.group_id),
		role: String(row.role ?? "member"),
		membership_epoch: Number(row.membership_epoch ?? 0),
		updated_at: cleanPeerScopeText(row.updated_at),
	}));
}

function ensureLocalActorRecord(store: MemoryStore): void {
	const d = drizzle(store.db, { schema });
	const now = new Date().toISOString();
	// Invariant: exactly one row in `actors` has is_local=1, and it is the
	// row whose actor_id matches store.actorId. Stale is_local=1 rows can
	// appear when a device's actor_id changes (config edit, regenerated
	// device keys, DB copied from another machine). Demote any such rows
	// before ensuring the canonical local row exists.
	d.update(schema.actors)
		.set({ is_local: 0, updated_at: now })
		.where(and(eq(schema.actors.is_local, 1), ne(schema.actors.actor_id, store.actorId)))
		.run();
	const existing = d
		.select({ actor_id: schema.actors.actor_id })
		.from(schema.actors)
		.where(eq(schema.actors.actor_id, store.actorId))
		.get();
	if (existing) {
		// Row already exists for the canonical local actor id; the demotion
		// above guarantees it is the only is_local=1 row, but the row itself
		// may have been previously set to is_local=0 (e.g. via a stale demote
		// from an even earlier identity). Re-mark it as local idempotently.
		d.update(schema.actors)
			.set({ is_local: 1, updated_at: now })
			.where(eq(schema.actors.actor_id, store.actorId))
			.run();
		return;
	}
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

function redactCoordinatorStatus(
	coordinator: Record<string, unknown>,
	showDiag: boolean,
): Record<string, unknown> {
	if (showDiag) return coordinator;
	const discovered = Array.isArray(coordinator.discovered_devices)
		? coordinator.discovered_devices.map((item) => {
				if (!item || typeof item !== "object") return item;
				const record = item as Record<string, unknown>;
				const addressCount = Array.isArray(record.addresses) ? record.addresses.length : 0;
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
					address_count: addressCount,
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
	fingerprint?: string;
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

type AcceptDiscoveredPeerNotConfiguredReason =
	| "coordinator_url_missing"
	| "coordinator_groups_empty"
	| "sync_disabled";

function detailForNotConfiguredReason(reason: AcceptDiscoveredPeerNotConfiguredReason): string {
	switch (reason) {
		case "coordinator_url_missing":
			return "Configure a coordinator URL before pairing with discovered peers.";
		case "coordinator_groups_empty":
			return "Join a coordinator team before pairing with discovered peers.";
		case "sync_disabled":
			return "Enable sync on this device before pairing with discovered peers.";
	}
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
	| {
			ok: false;
			status: number;
			error: string;
			detail: string;
			reason?: AcceptDiscoveredPeerNotConfiguredReason;
	  }
> {
	const config = readCoordinatorSyncConfig();
	// Order: address the most foundational gap first so the detail string
	// guides the user through setup in the correct sequence.
	let notConfiguredReason: AcceptDiscoveredPeerNotConfiguredReason | null = null;
	if (!config.syncCoordinatorUrl) {
		notConfiguredReason = "coordinator_url_missing";
	} else if (config.syncCoordinatorGroups.length === 0) {
		notConfiguredReason = "coordinator_groups_empty";
	} else if (!config.syncEnabled) {
		notConfiguredReason = "sync_disabled";
	}
	if (notConfiguredReason) {
		return {
			ok: false,
			status: 400,
			error: "coordinator_not_configured",
			reason: notConfiguredReason,
			detail: detailForNotConfiguredReason(notConfiguredReason),
		};
	}
	const discovered = await lookupCoordinatorPeers(store, config);
	const inputFingerprint = String(input.fingerprint ?? "").trim();
	const candidates = discovered.filter(
		(peer) => String(peer.device_id ?? "").trim() === input.peerDeviceId,
	);
	const matchingCandidates = inputFingerprint
		? candidates.filter((peer) => String(peer.fingerprint ?? "").trim() === inputFingerprint)
		: candidates;
	const uniqueFingerprints = new Set(
		matchingCandidates.map((peer) => String(peer.fingerprint ?? "").trim()).filter(Boolean),
	);
	if (!inputFingerprint && uniqueFingerprints.size > 1) {
		return {
			ok: false,
			status: 409,
			error: "ambiguous_discovered_peer",
			detail:
				"That discovered device has multiple coordinator fingerprints. Enable diagnostics, refresh sync status, and choose the intended device before trusting it.",
		};
	}
	const match = matchingCandidates[0];
	if (!match) {
		return {
			ok: false,
			status: 404,
			error: "discovered_peer_not_found",
			detail: "That discovered device is no longer available. Refresh sync status and try again.",
		};
	}
	const expiresAt = String(match.expires_at ?? "").trim();
	const expired = expiresAt ? Date.parse(expiresAt) <= Date.now() : false;
	if (match.stale || expired) {
		return {
			ok: false,
			status: 409,
			error: "discovered_peer_stale",
			detail:
				"This discovered device's coordinator presence is stale. Wait for it to come online and refresh sync status before trusting it.",
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
	if (!nextFingerprint || fingerprintPublicKey(nextPublicKey) !== nextFingerprint) {
		return {
			ok: false,
			status: 409,
			error: "discovered_peer_fingerprint_mismatch",
			detail:
				"This discovered device's coordinator public key does not match its fingerprint. Refresh sync status or re-enroll the device before trusting it.",
		};
	}

	const groupIds = Array.isArray(match.groups)
		? match.groups.map((value) => String(value ?? "").trim()).filter(Boolean)
		: [];
	const freshGroupIds = Array.isArray(match.fresh_groups)
		? match.fresh_groups.map((value) => String(value ?? "").trim()).filter(Boolean)
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
		if (!freshGroupIds.includes(input.expectedGroupId)) {
			return {
				ok: false,
				status: 409,
				error: "discovered_peer_stale",
				detail:
					"This discovered device's coordinator presence is stale for the specified group. Wait for it to come online and refresh sync status before trusting it.",
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
	const addressesJson = JSON.stringify(mergeAddresses(nextAddresses, existingAddresses));
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
	localDeviceId: string | null,
	ops: ReplicationOp[],
	options: { applyScopeFilter?: boolean } = {},
): { allowed: ReplicationOp[]; skipped: number; skippedDetail: SafeSkippedSyncDetail | null } {
	const [allowed, , skipped] = filterReplicationOpsForSyncWithStatus(store.db, ops, peerDeviceId, {
		localDeviceId,
		applyScopeFilter: options.applyScopeFilter,
	});
	return {
		allowed,
		skipped: skipped?.skipped_count ?? 0,
		skippedDetail: skipped ? safeSkippedSyncDetail(skipped) : null,
	};
}

// ---------------------------------------------------------------------------
// Peer row mapping — deduplicated helper (fix #4)
// ---------------------------------------------------------------------------

function claimedLocalActorScopeStatus(
	store: MemoryStore,
	row: Record<string, unknown>,
): Record<string, unknown> | null {
	if (!row.claimed_local_actor) return null;
	const peerDeviceId = String(row.peer_device_id ?? "").trim();
	const actorId = String(row.actor_id ?? store.actorId).trim() || store.actorId;
	const grant = personalScopeGrantStatusForPeer(store.db, { peerDeviceId, actorId });
	return {
		scope_id: grant.scope_id,
		authorized: grant.authorized,
		state: grant.state,
		action_required: !grant.authorized,
	};
}

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
	scopeRejectionsByPeer?: Map<string, InboundScopeRejectionPeerSummary>,
	localDeviceId?: string | null,
): Record<string, unknown> {
	const peerId = String(row.peer_device_id ?? "");
	const recentOps = recentOpsByPeer?.get(peerId) ?? { in: 0, out: 0 };
	const scopeRejections = scopeRejectionsByPeer?.get(peerId);
	const addresses = safeJsonList(row.addresses_json as string | null);
	const perScopeSync = listPerPeerScopeSyncState(store.db, {
		localDeviceId: localDeviceId ?? null,
		peerDeviceId: peerId,
	});
	return {
		peer_device_id: row.peer_device_id,
		name: row.name,
		fingerprint: showDiag ? row.pinned_fingerprint : null,
		pinned: Boolean(row.pinned_fingerprint),
		addresses: showDiag ? addresses : [],
		address_count: addresses.length,
		last_seen_at: row.last_seen_at,
		last_sync_at: row.last_sync_at,
		last_error: showDiag ? row.last_error : null,
		has_error: Boolean(row.last_error),
		claimed_local_actor: Boolean(row.claimed_local_actor),
		claimed_local_actor_scope: claimedLocalActorScopeStatus(store, row),
		actor_id: row.actor_id ?? null,
		actor_display_name: row.actor_display_name ?? null,
		authorized_scopes: peerAuthorizedScopes(store, peerId),
		// Per-Space sync state intersecting local + peer membership and joining
		// per-scope replication cursor data. Use this surface to render
		// per-Space progress in CLI/UI without exposing the legacy `status=ok`
		// shorthand that hid scoped sync gaps in 0.32.x.
		per_scope_sync: perScopeSync,
		project_scope: {
			...currentProjectScope(row, readPeerProjectFilters(store, String(row.peer_device_id ?? ""))),
		},
		recent_ops: { in: recentOps.in, out: recentOps.out },
		scope_rejections: {
			total: scopeRejections?.total ?? 0,
			by_reason: scopeRejections?.by_reason ?? {},
			last_at: scopeRejections?.last_at ?? null,
		},
		discovered_via_coordinator_id:
			typeof row.discovered_via_coordinator_id === "string"
				? row.discovered_via_coordinator_id
				: null,
		discovered_via_group_id:
			typeof row.discovered_via_group_id === "string" ? row.discovered_via_group_id : null,
	};
}

function redactSyncAttemptError(error: unknown): string | null {
	const text = String(error ?? "").trim();
	if (!text) return null;
	return "sync attempt failed; enable diagnostics for details";
}

function mapSyncAttemptRow(
	row: Record<string, unknown>,
	showDiag: boolean,
	addresses?: string[],
): Record<string, unknown> {
	const redactedError = redactSyncAttemptError(row.error);
	return {
		...row,
		error: showDiag ? row.error : redactedError,
		error_redacted: !showDiag && redactedError != null,
		status: attemptStatus(row),
		address: showDiag && addresses?.length ? addresses[0] : null,
	};
}

const SYNC_SCOPE_REJECTION_WINDOW_SECONDS = 24 * 60 * 60;

function recentScopeRejectionsByPeer(
	store: MemoryStore,
): Map<string, InboundScopeRejectionPeerSummary> {
	const cutoff = new Date(Date.now() - SYNC_SCOPE_REJECTION_WINDOW_SECONDS * 1000).toISOString();
	const summaries = summarizeInboundScopeRejections(store.db, { sinceIso: cutoff });
	const map = new Map<string, InboundScopeRejectionPeerSummary>();
	for (const summary of summaries) {
		const id = String(summary.peer_device_id ?? "").trim();
		if (!id) continue;
		map.set(id, summary);
	}
	return map;
}

function legacySharedReviewSummary(store: MemoryStore): Record<string, unknown> {
	const rows = legacySharedReviewRows(store);
	const memoryCount = rows.length;
	const lastUpdatedAt = rows.reduce<string | null>(
		(current, row) =>
			row.updated_at && (!current || row.updated_at > current) ? row.updated_at : current,
		null,
	);
	const ownedBySelf = store.buildOwnershipPredicate();
	const candidatesByIdentity = new Map(
		listProjectScopeCandidates(store.db, { limit: null }).map((candidate) => [
			candidate.workspace_identity,
			candidate,
		]),
	);
	const groupsByIdentity = new Map<
		string,
		{
			workspace_identity: string;
			identity_source: string;
			display_project: string;
			memory_count: number;
			reassignable_memory_count: number;
			peer_owned_memory_count: number;
			last_updated_at: string | null;
			memory_samples: LegacySharedReviewMemorySample[];
			suggested_scope_id: string | null;
			suggestion_reason: string | null;
		}
	>();
	for (const row of rows) {
		const identity = canonicalWorkspaceIdentity({
			cwd: row.cwd,
			gitBranch: row.git_branch,
			gitRemote: row.git_remote,
			project: row.project,
			workspaceId: row.workspace_id,
		});
		const candidate = candidatesByIdentity.get(identity.value);
		const resolvedScope = candidate?.resolved_scope_id ?? null;
		const suggestedScope =
			resolvedScope &&
			resolvedScope !== LOCAL_DEFAULT_SCOPE_ID &&
			resolvedScope !== LEGACY_SHARED_REVIEW_SCOPE_ID
				? resolvedScope
				: candidate?.suggested_scope_id;
		const existing = groupsByIdentity.get(identity.value);
		const isOwnedBySelf = ownedBySelf(row as unknown as Record<string, unknown>);
		const rowUpdatedAt = row.updated_at ?? null;
		if (existing) {
			existing.memory_count += 1;
			if (isOwnedBySelf) existing.reassignable_memory_count += 1;
			else existing.peer_owned_memory_count += 1;
			if (rowUpdatedAt && (!existing.last_updated_at || rowUpdatedAt > existing.last_updated_at)) {
				existing.last_updated_at = rowUpdatedAt;
			}
			if (existing.memory_samples.length < LEGACY_SHARED_REVIEW_SAMPLE_LIMIT) {
				existing.memory_samples.push(legacySharedReviewMemorySample(row, isOwnedBySelf));
			}
			continue;
		}
		groupsByIdentity.set(identity.value, {
			workspace_identity: identity.value,
			identity_source: identity.source,
			display_project: identity.displayProject ?? row.project ?? row.cwd ?? identity.value,
			memory_count: 1,
			reassignable_memory_count: isOwnedBySelf ? 1 : 0,
			peer_owned_memory_count: isOwnedBySelf ? 0 : 1,
			last_updated_at: rowUpdatedAt,
			memory_samples: [legacySharedReviewMemorySample(row, isOwnedBySelf)],
			suggested_scope_id: suggestedScope ?? null,
			suggestion_reason: suggestedScope
				? (candidate?.suggestion_reason ??
					"Existing project mapping can be reviewed as a destination, but legacy data is not promoted automatically.")
				: null,
		});
	}
	const totalGroupCount = groupsByIdentity.size;
	const groups = [...groupsByIdentity.values()].sort(
		(left, right) =>
			right.memory_count - left.memory_count ||
			(right.last_updated_at ?? "").localeCompare(left.last_updated_at ?? "") ||
			left.workspace_identity.localeCompare(right.workspace_identity),
	);
	const targetScopes = listSharingDomainSettingsScopes(store.db)
		.filter(
			(scope) =>
				scope.scope_id !== LOCAL_DEFAULT_SCOPE_ID &&
				scope.scope_id !== LEGACY_SHARED_REVIEW_SCOPE_ID,
		)
		.map((scope) => ({
			authority_type: scope.authority_type,
			label: scope.label || scope.scope_id,
			scope_id: scope.scope_id,
		}));
	return {
		scope_id: LEGACY_SHARED_REVIEW_SCOPE_ID,
		memory_count: memoryCount,
		has_data: memoryCount > 0,
		last_updated_at: lastUpdatedAt,
		groups,
		total_group_count: totalGroupCount,
		target_scopes: targetScopes,
	};
}

interface LegacySharedReviewReassignmentMemoryRow {
	id: number;
	rev: number | null;
	active: number | null;
	deleted_at: string | null;
	created_at: string | null;
	updated_at: string | null;
	scope_id: string | null;
	kind: string | null;
	title: string | null;
	body_text: string | null;
	project: string | null;
	cwd: string | null;
	git_remote: string | null;
	git_branch: string | null;
	workspace_id: string | null;
	actor_id: string | null;
	origin_device_id: string | null;
	metadata_json: string | null;
}

const LEGACY_SHARED_REVIEW_SAMPLE_LIMIT = 3;
const LEGACY_SHARED_REVIEW_BODY_PREVIEW_SQL_LIMIT = 360;

interface LegacySharedReviewMemorySample {
	id: number;
	kind: string | null;
	title: string;
	body_preview: string | null;
	created_at: string | null;
	updated_at: string | null;
	ownership: "local" | "peer";
	project: string | null;
	cwd: string | null;
	git_remote: string | null;
}

function previewText(value: string | null | undefined, limit = 180): string | null {
	const normalized = value?.replace(/\s+/g, " ").trim();
	if (!normalized) return null;
	return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function legacySharedReviewMemorySample(
	row: LegacySharedReviewReassignmentMemoryRow,
	isOwnedBySelf: boolean,
): LegacySharedReviewMemorySample {
	return {
		id: row.id,
		kind: row.kind,
		title: previewText(row.title, 120) ?? `Memory ${row.id}`,
		body_preview: previewText(row.body_text),
		created_at: row.created_at ?? null,
		updated_at: row.updated_at ?? null,
		ownership: isOwnedBySelf ? "local" : "peer",
		project: row.project ?? null,
		cwd: row.cwd ?? null,
		git_remote: row.git_remote ?? null,
	};
}

function legacySharedReviewRows(store: MemoryStore): LegacySharedReviewReassignmentMemoryRow[] {
	return store.db
		.prepare(
			`SELECT m.id,
			        m.rev,
			        m.active,
			        m.deleted_at,
			        m.created_at,
			        m.updated_at,
			        m.scope_id,
			        m.kind,
			        m.title,
				        substr(m.body_text, 1, ?) AS body_text,
			        s.project,
			        s.cwd,
			        s.git_remote,
			        s.git_branch,
			        m.workspace_id,
			        m.actor_id,
			        m.origin_device_id,
			        m.metadata_json
			 FROM memory_items m
			 LEFT JOIN sessions s ON s.id = m.session_id
			 WHERE m.scope_id = ?
			   AND m.active = 1
			   AND m.deleted_at IS NULL
			 ORDER BY COALESCE(m.updated_at, m.created_at, '') DESC, m.id DESC`,
		)
		.all(
			LEGACY_SHARED_REVIEW_BODY_PREVIEW_SQL_LIMIT,
			LEGACY_SHARED_REVIEW_SCOPE_ID,
		) as LegacySharedReviewReassignmentMemoryRow[];
}

function legacySharedReviewConfirmationToken(input: {
	rows: LegacySharedReviewReassignmentMemoryRow[];
	scopeId: string;
	store: MemoryStore;
	workspaceIdentity: string;
}): string {
	const ownedBySelf = input.store.buildOwnershipPredicate();
	const payload = input.rows
		.map((row) => {
			const ownership = ownedBySelf(row as unknown as Record<string, unknown>) ? "local" : "peer";
			return `${row.id}:${row.rev ?? 0}:${row.scope_id ?? ""}:${ownership}`;
		})
		.sort()
		.join(",");
	return Buffer.from(`${input.workspaceIdentity}|${input.scopeId}|${payload}`, "utf8").toString(
		"base64url",
	);
}

interface LegacySharedReviewReassignmentPreview {
	confirmation_token: string;
	workspace_identity: string;
	scope_id: string;
	target_scope_label: string;
	memory_count: number;
	reassignable_memory_count: number;
	skipped_memory_count: number;
	affected_peer_device_count: number;
	affected_peer_device_ids: string[];
	warning: string;
}

interface ProjectInventoryMemoryRow {
	id: number;
	rev: number | null;
	project: string | null;
	cwd: string | null;
	git_remote: string | null;
	git_branch: string | null;
	workspace_id: string | null;
	actor_id: string | null;
	origin_device_id: string | null;
	metadata_json: string | null;
}

function projectInventoryRowsForWorkspace(
	store: MemoryStore,
	workspaceIdentity: string,
): ProjectInventoryMemoryRow[] {
	const rows = store.db
		.prepare(
			`SELECT m.id,
			        m.rev,
			        s.project,
			        s.cwd,
			        s.git_remote,
			        s.git_branch,
			        m.workspace_id,
			        m.actor_id,
			        m.origin_device_id,
			        m.metadata_json
			 FROM memory_items m
			 LEFT JOIN sessions s ON s.id = m.session_id
			 WHERE m.active = 1
			   AND m.deleted_at IS NULL`,
		)
		.all() as ProjectInventoryMemoryRow[];
	return rows.filter((row) => {
		const identity = canonicalWorkspaceIdentity({
			cwd: row.cwd,
			gitBranch: row.git_branch,
			gitRemote: row.git_remote,
			project: row.project,
			workspaceId: row.workspace_id,
		});
		return identity.value === workspaceIdentity;
	});
}

function projectForgetConfirmationToken(
	store: MemoryStore,
	rows: ProjectInventoryMemoryRow[],
): string {
	const ownedBySelf = store.buildOwnershipPredicate();
	const payload = rows
		.map((row) => {
			const ownership = ownedBySelf(row as unknown as Record<string, unknown>) ? "local" : "peer";
			return `${row.id}:${row.rev ?? 0}:${ownership}`;
		})
		.sort()
		.join(",");
	return Buffer.from(payload, "utf8").toString("base64url");
}

function forgetProjectInventoryLocalMemories(
	store: MemoryStore,
	input: { confirmationToken?: string | null; confirmed: boolean; workspaceIdentity: string },
): Record<string, unknown> {
	if (!input.workspaceIdentity.trim()) {
		throw new Error("workspace_identity must be a non-empty string");
	}
	const rows = projectInventoryRowsForWorkspace(store, input.workspaceIdentity);
	if (rows.length === 0) throw new Error("project identity not found");
	const ownedBySelf = store.buildOwnershipPredicate();
	const localRows = rows.filter((row) => ownedBySelf(row as unknown as Record<string, unknown>));
	const confirmationToken = projectForgetConfirmationToken(store, rows);
	const preview = {
		confirmation_token: confirmationToken,
		local_owned_memory_count: localRows.length,
		peer_owned_memory_count: rows.length - localRows.length,
		workspace_identity: input.workspaceIdentity,
	};
	if (!input.confirmed) {
		return { confirmed: false, ...preview };
	}
	if (input.confirmationToken !== confirmationToken) {
		throw new Error("project memories changed before cleanup; refresh and try again");
	}
	store.db.transaction(() => {
		for (const row of localRows) store.forget(row.id);
	})();
	return { confirmed: true, forgotten_memory_count: localRows.length, ...preview };
}

function assertLocalDeviceScopeMembership(store: MemoryStore, scopeId: string): void {
	if (scopeId === LOCAL_DEFAULT_SCOPE_ID) return;
	const row = store.db
		.prepare(
			`SELECT 1
			 FROM scope_memberships sm
			 JOIN replication_scopes rs ON rs.scope_id = sm.scope_id
			 WHERE sm.scope_id = ?
			   AND sm.device_id = ?
			   AND sm.status = 'active'
			   AND rs.status = 'active'
			   AND sm.membership_epoch >= rs.membership_epoch
			 LIMIT 1`,
		)
		.get(scopeId, store.deviceId);
	if (!row) throw new Error(`local device is not a member of Sharing domain ${scopeId}`);
}

function legacySharedReviewRowsForWorkspace(
	store: MemoryStore,
	workspaceIdentity: string,
): LegacySharedReviewReassignmentMemoryRow[] {
	return legacySharedReviewRows(store).filter((row) => {
		const identity = canonicalWorkspaceIdentity({
			cwd: row.cwd,
			gitBranch: row.git_branch,
			gitRemote: row.git_remote,
			project: row.project,
			workspaceId: row.workspace_id,
		});
		return identity.value === workspaceIdentity;
	});
}

function reassignableLegacySharedReviewRows(
	store: MemoryStore,
	rows: LegacySharedReviewReassignmentMemoryRow[],
): LegacySharedReviewReassignmentMemoryRow[] {
	const reassignableRows = rows.filter((row) =>
		store.memoryOwnedBySelf(row as unknown as Record<string, unknown>),
	);
	if (reassignableRows.length === 0) {
		throw new Error(
			"This legacy review group contains only peer-owned memories; this device cannot reassign them to a Sharing domain.",
		);
	}
	const currentRows = store.db
		.prepare(
			`SELECT id, scope_id, active, deleted_at
			 FROM memory_items
			 WHERE id IN (${reassignableRows.map(() => "?").join(",")})`,
		)
		.all(...reassignableRows.map((row) => row.id)) as Array<{
		active: number | null;
		deleted_at: string | null;
		id: number;
		scope_id: string | null;
	}>;
	const currentById = new Map(currentRows.map((row) => [Number(row.id), row]));
	for (const row of reassignableRows) {
		const current = currentById.get(row.id);
		if (
			current?.scope_id !== LEGACY_SHARED_REVIEW_SCOPE_ID ||
			current.active !== 1 ||
			current.deleted_at
		) {
			throw new Error(
				"legacy shared review group changed before reassignment; refresh and try again",
			);
		}
	}
	return reassignableRows;
}

function legacySharedReviewReassignmentPreview(
	store: MemoryStore,
	input: { scopeId: string; workspaceIdentity: string },
): LegacySharedReviewReassignmentPreview {
	if (!input.workspaceIdentity.trim())
		throw new Error("workspace_identity must be a non-empty string");
	if (!input.scopeId.trim()) throw new Error("scope_id must be a non-empty string");
	if (input.scopeId === LOCAL_DEFAULT_SCOPE_ID) {
		throw new Error("local-default is not a valid target for legacy shared review reassignment");
	}
	if (input.scopeId === LEGACY_SHARED_REVIEW_SCOPE_ID) {
		throw new Error("legacy-shared-review is a review bucket, not an assignable Sharing domain");
	}
	const targetScope = listSharingDomainSettingsScopes(store.db).find(
		(scope) => scope.scope_id === input.scopeId,
	);
	if (!targetScope) throw new Error(`scope_id ${input.scopeId} is not an active Sharing domain`);
	assertLocalDeviceScopeMembership(store, input.scopeId);
	const rows = legacySharedReviewRowsForWorkspace(store, input.workspaceIdentity);
	if (rows.length === 0) throw new Error("legacy shared review group not found");
	const reassignableRows = reassignableLegacySharedReviewRows(store, rows);
	const peerDeviceIds = [
		...new Set(
			rows
				.map((row) => String(row.origin_device_id ?? "").trim())
				.filter((deviceId) => deviceId && deviceId !== store.deviceId),
		),
	].sort();
	return {
		affected_peer_device_count: peerDeviceIds.length,
		affected_peer_device_ids: peerDeviceIds.slice(0, 5),
		confirmation_token: legacySharedReviewConfirmationToken({
			rows,
			scopeId: input.scopeId,
			store,
			workspaceIdentity: input.workspaceIdentity,
		}),
		memory_count: rows.length,
		reassignable_memory_count: reassignableRows.length,
		scope_id: input.scopeId,
		skipped_memory_count: rows.length - reassignableRows.length,
		target_scope_label: targetScope.label || targetScope.scope_id,
		warning:
			"This changes future sync authorization for reassignable local memories. It does not erase data already copied to peers under legacy-shared-review.",
		workspace_identity: input.workspaceIdentity,
	};
}

function reassignLegacySharedReviewGroup(
	store: MemoryStore,
	input: { confirmationToken?: string | null; scopeId: string; workspaceIdentity: string },
): Record<string, unknown> {
	const preview = legacySharedReviewReassignmentPreview(store, input);
	if (input.confirmationToken !== preview.confirmation_token) {
		throw new Error(
			"legacy shared review group changed before reassignment; refresh and try again",
		);
	}
	const rows = reassignableLegacySharedReviewRows(
		store,
		legacySharedReviewRowsForWorkspace(store, input.workspaceIdentity),
	);
	store.db.transaction(() => {
		for (const row of rows) store.reassignMemoryScope(row.id, input.scopeId);
	})();
	return {
		ok: true,
		...preview,
		reassigned_memory_count: rows.length,
		legacy_shared_review: legacySharedReviewSummary(store),
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
	       p.actor_id, p.discovered_via_coordinator_id, p.discovered_via_group_id,
	       a.display_name AS actor_display_name
	FROM sync_peers AS p
	LEFT JOIN actors AS a ON a.actor_id = p.actor_id
	ORDER BY name, peer_device_id
`;

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Compute the negotiated sync capability for a request by combining the
 * server's local capability with the value the caller advertised in the
 * `X-Codemem-Sync-Capability` header. Routes use this to decide whether to
 * honor scoped-sync wire features such as explicit `scope_id` parameters
 * and `/v1/status` `authorized_scopes` enumeration.
 *
 * Unsigned headers are fine here: the server is computing what it is
 * willing to do, not granting access. Per-scope authorization is enforced
 * separately via the membership cache when a scope_id is actually used.
 */
function negotiatedSyncCapability(c: Context) {
	const header = c.req.header(SYNC_CAPABILITY_HEADER) ?? null;
	return negotiateSyncCapability(LOCAL_SYNC_CAPABILITY, normalizeSyncCapability(header));
}

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
			if (isSyncAuthStoreBusy(auth)) return syncAuthStoreBusyResponse(c);
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
			if (isSyncAuthStoreBusy(auth)) return syncAuthStoreBusyResponse(c);
			if (!auth.ok) {
				// Specific reasons are logged server-side; wire responses use a generic
				// reason to prevent info-disclosure.
				if (bootstrapAttempted) {
					const grantPresent = Boolean((c.req.header("X-Codemem-Bootstrap-Grant") ?? "").trim());
					console.warn(
						`[sync] bootstrap grant auth failed: reason=${auth.reason} grant_present=${grantPresent} path=${c.req.path}`,
					);
				}
				const wireReason = bootstrapAttempted ? "bootstrap_grant_invalid" : auth.reason;
				return (
					(preauthChecked ? null : rateLimitedResponse(c, c.req.path, false)) ??
					c.json(unauthorizedPayload(wireReason, true), 401)
				);
			}
			const limited = rateLimitedResponse(c, auth.deviceId, true);
			if (limited) return limited;

			try {
				const [deviceId, fingerprint] = ensureDeviceIdentity(store.db, {
					keysDir: syncKeysDir(),
				});
				const syncReset = getSyncResetState(store.db);
				const negotiated = negotiatedSyncCapability(c);
				const authorizedScopes = isScopedSyncCapability(negotiated)
					? listAuthorizedScopesForPeer(store.db, {
							localDeviceId: deviceId,
							peerDeviceId: auth.deviceId,
						})
					: null;
				const response: Record<string, unknown> = {
					device_id: deviceId,
					protocol_version: SYNC_PROTOCOL_VERSION,
					fingerprint,
					sync_reset: addSyncScopeToBoundary(syncReset, null),
					sync_capability: LOCAL_SYNC_CAPABILITY,
				};
				if (authorizedScopes !== null) {
					response.authorized_scopes = authorizedScopes;
				}
				return c.json(response);
			} catch {
				return c.json({ error: "internal_error" }, 500);
			}
		})();
	});

	// GET /v1/ops (peer sync protocol)
	app.get("/v1/ops", (c) => {
		const store = getStore();
		const auth = authorizeSyncRequest(store, c.req, Buffer.alloc(0));
		if (isSyncAuthStoreBusy(auth)) return syncAuthStoreBusyResponse(c);
		if (!auth.ok)
			return (
				rateLimitedResponse(c, c.req.path, false) ??
				c.json(unauthorizedPayload(auth.reason, true), 401)
			);
		const limited = rateLimitedResponse(c, auth.deviceId, true);
		if (limited) return limited;
		const peerDeviceId = auth.deviceId;

		try {
			const rawScopeId = c.req.query(SYNC_SCOPE_QUERY_PARAM);
			const negotiated = negotiatedSyncCapability(c);
			const [localDeviceId] = ensureDeviceIdentity(store.db, { keysDir: syncKeysDir() });
			const scopeRequest = parseSyncScopeRequest(rawScopeId, rawScopeId !== undefined, {
				db: store.db,
				localDeviceId,
				negotiatedCapability: negotiated,
				peerDeviceId,
			});
			if (!scopeRequest.ok) {
				return c.json(
					syncScopeResetRequiredPayload(
						getSyncResetState(store.db),
						scopeRequest.reason,
						LOCAL_SYNC_CAPABILITY,
						null,
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
			const result = loadReplicationOpsForPeer(store.db, {
				since,
				limit,
				deviceId: localDeviceId,
				generation: Number.isFinite(generation) ? generation : null,
				snapshotId,
				baselineCursor,
				scopeId: scopeRequest.mode === "scoped" ? scopeRequest.scope_id : undefined,
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
			const filtered = filterOpsForPeer(store, peerDeviceId, localDeviceId, ops);
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
				skipped_detail: filtered.skippedDetail,
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
			if (isSyncAuthStoreBusy(auth)) return syncAuthStoreBusyResponse(c);
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
			if (isSyncAuthStoreBusy(auth)) return syncAuthStoreBusyResponse(c);
			if (!auth.ok) {
				// Specific reasons are logged server-side; wire responses use a generic
				// reason to prevent info-disclosure.
				if (bootstrapAttempted) {
					const grantPresent = Boolean((c.req.header("X-Codemem-Bootstrap-Grant") ?? "").trim());
					console.warn(
						`[sync] bootstrap grant auth failed: reason=${auth.reason} grant_present=${grantPresent} path=${c.req.path}`,
					);
				}
				const wireReason = bootstrapAttempted ? "bootstrap_grant_invalid" : auth.reason;
				return (
					(preauthChecked ? null : rateLimitedResponse(c, c.req.path, false)) ??
					c.json(unauthorizedPayload(wireReason, true), 401)
				);
			}
			const limited = rateLimitedResponse(c, auth.deviceId, true);
			if (limited) return limited;

			try {
				const rawScopeId = c.req.query(SYNC_SCOPE_QUERY_PARAM);
				const negotiated = negotiatedSyncCapability(c);
				const [localDeviceId] = ensureDeviceIdentity(store.db, { keysDir: syncKeysDir() });
				const scopeRequest = parseSyncScopeRequest(rawScopeId, rawScopeId !== undefined, {
					db: store.db,
					localDeviceId,
					negotiatedCapability: negotiated,
					peerDeviceId: auth.deviceId,
				});
				if (!scopeRequest.ok) {
					return c.json(
						syncScopeResetRequiredPayload(
							getSyncResetState(store.db),
							scopeRequest.reason,
							LOCAL_SYNC_CAPABILITY,
							null,
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
					scopeId: scopeRequest.mode === "scoped" ? scopeRequest.scope_id : undefined,
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
		if (isSyncAuthStoreBusy(auth)) return syncAuthStoreBusyResponse(c);
		if (!auth.ok)
			return (
				rateLimitedResponse(c, c.req.path, false) ??
				c.json(unauthorizedPayload(auth.reason, true), 401)
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

		const negotiated = negotiateSyncCapability(
			LOCAL_SYNC_CAPABILITY,
			normalizeSyncCapability(body.sync_capability),
		);
		const [localDeviceId] = ensureDeviceIdentity(store.db, { keysDir: syncKeysDir() });
		const scopeRequest = parseSyncScopeRequest(body.scope_id, Object.hasOwn(body, "scope_id"), {
			db: store.db,
			localDeviceId,
			negotiatedCapability: negotiated,
			peerDeviceId,
		});
		if (!scopeRequest.ok) {
			return c.json(
				syncScopeResetRequiredPayload(
					getSyncResetState(store.db),
					scopeRequest.reason,
					LOCAL_SYNC_CAPABILITY,
					null,
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
		// Inbound POSTs still use legacy visibility/project filters, but must not run
		// the outbound scope gate. Unsupported peers deliberately bypass strict inbound
		// scope rejection during rollout, so outbound filtering would silently drop data.
		const filtered = filterOpsForPeer(store, peerDeviceId, localDeviceId, normalizedOps, {
			applyScopeFilter: false,
		});
		// Scope validation runs against the full signed batch so bad scoped ops cannot
		// evade fail-closed rejection by also tripping peer project filters.
		const rejected = rejectInboundScopeFailures(store.db, normalizedOps, localDeviceId, {
			enabled: negotiated !== "unsupported",
			peerDeviceId,
		});
		if (rejected) {
			return c.json(
				{
					error: "scope_rejected",
					reason: rejected.rejections[0]?.reason ?? "scope_mismatch",
					rejections: rejected.rejections,
					sync_capability: LOCAL_SYNC_CAPABILITY,
					scope_id: scopeRequest.scope_id,
				},
				403,
			);
		}

		const result = applyReplicationOps(store.db, filtered.allowed, localDeviceId, store.scanner);
		const skipped = result.skipped + filtered.skipped;
		return c.json({
			...result,
			skipped,
			skipped_detail: filtered.skippedDetail,
			sync_capability: LOCAL_SYNC_CAPABILITY,
			scope_id: scopeRequest.scope_id,
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

			const coordinatorSnapshot = await coordinatorStatusSnapshot(store, config);
			const coordinator = traceSync("coordinator", () =>
				redactCoordinatorStatus(coordinatorSnapshot, showDiag),
			);

			// Build peers list using deduplicated mapPeerRow
			const peerRows = traceSync(
				"peerRows",
				() => store.db.prepare(PEERS_QUERY).all() as Record<string, unknown>[],
			);
			const recentOpsByPeer = traceSync("recentPeerOps", () => recentPeerOps(store));
			const scopeRejectionsByPeer = traceSync("recentScopeRejectionsByPeer", () =>
				recentScopeRejectionsByPeer(store),
			);
			const peersItems = peerRows.map((row) => {
				const peer = mapPeerRow(
					store,
					row,
					showDiag,
					recentOpsByPeer,
					scopeRejectionsByPeer,
					(deviceRow?.device_id as string | null | undefined) ?? null,
				);
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
				return mapSyncAttemptRow(row, showDiag, addrs);
			});
			const latestAttemptError = String(attemptRows[0]?.error || "").trim();

			const statusBlock: Record<string, unknown> = {
				...statusPayload,
				background_maintenance: summarizeMaintenanceJobs(listMaintenanceJobs(store.db), showDiag),
				peers: peersMap,
				pending: 0,
				sync: {},
				ping: {},
			};
			const legacyDevices = traceSync("legacyDevices", () => store.claimableLegacyDeviceIds());
			const legacyReview = traceSync("legacySharedReview", () => legacySharedReviewSummary(store));
			const sharingReview = traceSync("sharingReview", () => store.sharingReviewSummary(project));
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
				legacy_shared_review: legacyReview,
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
			const scopeRejectionsByPeer = recentScopeRejectionsByPeer(store);
			const d = drizzle(store.db, { schema });
			const deviceRow = d
				.select({ device_id: schema.syncDevice.device_id })
				.from(schema.syncDevice)
				.limit(1)
				.get();
			const localDeviceId = (deviceRow?.device_id as string | null | undefined) ?? null;
			// Use deduplicated mapPeerRow helper (fix #4)
			const peers = rows.map((row) =>
				mapPeerRow(store, row, showDiag, recentOpsByPeer, scopeRejectionsByPeer, localDeviceId),
			);
			return c.json({ items: peers, redacted: !showDiag });
		}
	});

	// GET /api/sync/peers/:peer_device_id/scope-rejections
	//
	// Recent scope-rejection records produced by the inbound fail-closed gate.
	// Each row is metadata only — op id, entity ref, scope id, reason code,
	// timestamp. The rejection log never stores op payloads, so this endpoint
	// can never leak inbound payload contents regardless of diagnostics state.
	app.get("/api/sync/peers/:peer_device_id/scope-rejections", (c) => {
		const store = getStore();
		const peerDeviceId = String(c.req.param("peer_device_id") || "").trim();
		if (!peerDeviceId) return c.json({ error: "missing_peer_device_id" }, 400);
		const limit = queryInt(c.req.query("limit"), 100);
		if (limit <= 0) return c.json({ error: "invalid_limit" }, 400);
		const sinceMinutesRaw = queryInt(c.req.query("sinceMinutes"), 24 * 60);
		// Cap at ~10 years so a hostile or fat-fingered query cannot push the
		// computed timestamp past the Date range and turn toISOString() into
		// a 500. Anything older than 10 years is effectively "all rejections".
		const SINCE_MINUTES_MAX = 10 * 365 * 24 * 60;
		const sinceMinutes = Math.min(Math.max(sinceMinutesRaw, 0), SINCE_MINUTES_MAX);
		const sinceIso =
			sinceMinutes > 0 ? new Date(Date.now() - sinceMinutes * 60_000).toISOString() : undefined;
		const records = listInboundScopeRejections(store.db, {
			peerDeviceId,
			sinceIso,
			limit,
		});
		const summaries = summarizeInboundScopeRejections(store.db, {
			peerDeviceId,
			sinceIso,
		});
		const summary = summaries[0] ?? {
			peer_device_id: peerDeviceId,
			total: 0,
			by_reason: {},
			last_at: null,
		};
		return c.json({
			peer_device_id: peerDeviceId,
			summary,
			items: records,
		});
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
			const showDiag = queryBool(c.req.query("includeDiagnostics"));
			const items = rows.map((row) => mapSyncAttemptRow(row, showDiag));
			return c.json({ items, redacted: !showDiag });
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
			let deviceId: string | undefined;
			let publicKey: string | undefined;
			let fingerprint: string | undefined;

			try {
				const [id, fp] = ensureDeviceIdentity(store.db, { keysDir: syncKeysDir() });
				deviceId = id;
				fingerprint = fp;
				const row = d
					.select({ public_key: schema.syncDevice.public_key })
					.from(schema.syncDevice)
					.where(eq(schema.syncDevice.device_id, id))
					.get();
				publicKey = row?.public_key ?? "";
			} catch {
				return c.json({ error: "device identity unavailable" }, 500);
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
			items.push({
				peer_device_id: peerId,
				...result,
				skippedOut: undefined,
				skipped_out: safeSkippedSyncDetail(result.skippedOut),
			});
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

	app.get("/api/sync/sharing-domains/settings", (c) => {
		const store = getStore();
		const limit = Math.max(1, queryInt(c.req.query("limit"), 250));
		return c.json({
			scopes: listSharingDomainSettingsScopes(store.db),
			mappings: listProjectScopeSettingsMappings(store.db),
			projects: listProjectScopeCandidates(store.db, { limit }),
			local_default_scope_id: LOCAL_DEFAULT_SCOPE_ID,
		});
	});

	app.get("/api/sync/projects", (c) => {
		const store = getStore();
		const limit = Math.max(1, queryInt(c.req.query("limit"), 50));
		const offset = Math.max(0, queryInt(c.req.query("offset"), 0));
		return c.json(
			listProjectScopeInventory(store.db, {
				identitySource: c.req.query("identity_source"),
				limit,
				offset,
				query: c.req.query("q"),
				scopeId: c.req.query("scope_id"),
				status: c.req.query("status"),
			}),
		);
	});

	app.post("/api/sync/projects/reassign-project", async (c) => {
		const store = getStore();
		const body = await parseViewerJsonBody(c);
		if (!body) return c.json({ error: "invalid json" }, 400);
		try {
			const workspaceIdentity = optionalViewerStrictString(body, "workspace_identity") ?? "";
			const project = optionalViewerStrictString(body, "project") ?? "";
			const [deviceId] = ensureDeviceIdentity(store.db, { keysDir: syncKeysDir() });
			const result = reassignProjectScopeInventoryProject(store.db, {
				deviceId,
				project,
				workspaceIdentity,
			});
			return c.json({ ok: true, ...result });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return c.json({ error: message }, message.includes("not found") ? 404 : 400);
		}
	});

	app.post("/api/sync/projects/forget", async (c) => {
		const store = getStore();
		const body = await parseViewerJsonBody(c);
		if (!body) return c.json({ error: "invalid json" }, 400);
		try {
			const workspaceIdentity = optionalViewerStrictString(body, "workspace_identity") ?? "";
			const confirmationToken = optionalViewerStrictString(body, "confirmation_token");
			const confirmed = body.confirmed === true;
			const result = forgetProjectInventoryLocalMemories(store, {
				confirmationToken,
				confirmed,
				workspaceIdentity,
			});
			if (!confirmed) {
				return c.json(
					{
						error: "project_forget_confirmation_required",
						preview: result,
					},
					409,
				);
			}
			return c.json({ ok: true, ...result });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return c.json({ error: message }, message.includes("not found") ? 404 : 400);
		}
	});

	app.post("/api/sync/legacy-shared-review/reassign", async (c) => {
		const store = getStore();
		const body = await parseViewerJsonBody(c);
		if (!body) return c.json({ error: "invalid json" }, 400);
		try {
			const workspaceIdentity = optionalViewerStrictString(body, "workspace_identity") ?? "";
			const scopeId = optionalViewerStrictString(body, "scope_id") ?? "";
			const confirmationToken = optionalViewerStrictString(body, "confirmation_token");
			const confirmedOldCopies = body.confirmed_old_copies === true;
			const preview = legacySharedReviewReassignmentPreview(store, {
				scopeId,
				workspaceIdentity,
			});
			if (!confirmedOldCopies) {
				return c.json(
					{
						error: "legacy_review_confirmation_required",
						message: preview.warning,
						preview,
					},
					409,
				);
			}
			return c.json(
				reassignLegacySharedReviewGroup(store, {
					confirmationToken,
					scopeId,
					workspaceIdentity,
				}),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return c.json({ error: message }, message.includes("not found") ? 404 : 400);
		}
	});

	app.put("/api/sync/sharing-domains/project-mappings", async (c) => {
		const store = getStore();
		const body = await parseViewerJsonBody(c);
		if (!body) return c.json({ error: "invalid json" }, 400);
		try {
			const confirmedGuardrailTokens = optionalViewerStringList(body, "confirmed_guardrail_tokens");
			const mappingInput = parseViewerProjectMappingInput(body);
			const analysis = analyzeProjectScopeMappingChangeGuardrails(store.db, mappingInput);
			if (analysis.requested_workspace_identity?.startsWith("unmapped:")) {
				return c.json(
					{
						error: "unmapped_project_local_only",
						message:
							"Unmapped projects need a stable path, git remote, or workspace id before assigning a Sharing domain.",
						guardrail_warnings: analysis.warnings,
					},
					400,
				);
			}
			const missingConfirmations = missingGuardrailConfirmations(
				analysis.warnings,
				confirmedGuardrailTokens,
			);
			if (missingConfirmations.length > 0) {
				const missingCodes = [...new Set(missingConfirmations.map((warning) => warning.code))];
				const missingTokens = [
					...new Set(missingConfirmations.map((warning) => warning.confirmation_token)),
				].filter((token): token is string => typeof token === "string" && token.length > 0);
				return c.json(
					{
						error: "guardrail_confirmation_required",
						required_guardrails: missingCodes,
						required_guardrail_tokens: missingTokens,
						guardrail_warnings: analysis.warnings,
					},
					409,
				);
			}
			const mapping = upsertProjectScopeSettingsMapping(store.db, {
				...mappingInput,
			});
			return c.json({ ok: true, mapping, guardrail_warnings: analysis.warnings });
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
		}
	});

	app.put("/api/sync/sharing-domains/project-mappings/bulk", async (c) => {
		const store = getStore();
		const body = await parseViewerJsonBody(c);
		if (!body) return c.json({ error: "invalid json" }, 400);
		try {
			const rawMappings = body.mappings;
			if (!Array.isArray(rawMappings) || rawMappings.length === 0) {
				return c.json({ error: "mappings must be a non-empty array" }, 400);
			}
			const mappingInputs = rawMappings.map((raw) => {
				if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
					throw new Error("each mapping must be an object");
				}
				return parseViewerProjectMappingInput(raw as Record<string, unknown>);
			});
			const analyses = mappingInputs.map((mappingInput) =>
				analyzeProjectScopeMappingChangeGuardrails(store.db, mappingInput),
			);
			const unmapped = analyses.find((analysis) =>
				analysis.requested_workspace_identity?.startsWith("unmapped:"),
			);
			if (unmapped) {
				return c.json(
					{
						error: "unmapped_project_local_only",
						message:
							"Unmapped projects need a stable path, git remote, or workspace id before assigning a Sharing domain.",
						guardrail_warnings: unmapped.warnings,
					},
					400,
				);
			}
			const missingConfirmations = analyses.flatMap((analysis) =>
				missingGuardrailConfirmations(analysis.warnings, []),
			);
			if (missingConfirmations.length > 0) {
				const missingCodes = [...new Set(missingConfirmations.map((warning) => warning.code))];
				const missingTokens = [
					...new Set(missingConfirmations.map((warning) => warning.confirmation_token)),
				].filter((token): token is string => typeof token === "string" && token.length > 0);
				return c.json(
					{
						error: "guardrail_confirmation_required",
						required_guardrails: missingCodes,
						required_guardrail_tokens: missingTokens,
						guardrail_warnings: analyses.flatMap((analysis) => analysis.warnings),
					},
					409,
				);
			}
			const saveMappings = store.db.transaction(() =>
				mappingInputs.map((mappingInput) =>
					upsertProjectScopeSettingsMapping(store.db, mappingInput),
				),
			);
			return c.json({
				ok: true,
				mappings: saveMappings(),
				guardrail_warnings: analyses.flatMap((analysis) => analysis.warnings),
			});
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
		}
	});

	app.delete("/api/sync/sharing-domains/project-mappings/:id", (c) => {
		const store = getStore();
		const id = Number(c.req.param("id"));
		try {
			const deleted = deleteProjectScopeSettingsMapping(store.db, id);
			return c.json({ ok: true, deleted });
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
		}
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
		try {
			const result = await acceptDiscoveredPeer(store, {
				peerDeviceId,
				fingerprint: fingerprint || undefined,
			});
			if (!result.ok) {
				return c.json(
					{
						error: result.error,
						detail: result.detail,
						...(result.reason ? { reason: result.reason } : {}),
					},
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
				const d = drizzle(store.db, { schema });
				const existing = d
					.select({ pinned_fingerprint: schema.syncPeers.pinned_fingerprint })
					.from(schema.syncPeers)
					.where(eq(schema.syncPeers.peer_device_id, pairingResult.device_id))
					.get();
				const existingFingerprint = String(existing?.pinned_fingerprint ?? "").trim();
				if (existingFingerprint && existingFingerprint !== pairingResult.fingerprint) {
					return c.json(
						{
							error: "peer_conflict",
							detail:
								"Pairing payload conflicts with the existing trusted fingerprint for this device. Remove or repair the old peer before accepting this pairing payload.",
						},
						409,
					);
				}
				updatePeerAddresses(store.db, pairingResult.device_id, pairingResult.addresses, {
					pinnedFingerprint: pairingResult.fingerprint,
					publicKey: pairingResult.public_key,
					replaceTrust: true,
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
			try {
				const defaultSpace = await ensureDefaultSpaceForTeam({
					store: getStore(),
					config,
					groupId,
					displayName: displayName || group.display_name || null,
				});
				return c.json({ ok: true, group, default_space: defaultSpace, status });
			} catch (setupError) {
				return c.json({
					ok: true,
					group,
					default_space: null,
					setup_warning: {
						step: "default_space",
						error: setupError instanceof Error ? setupError.message : String(setupError),
					},
					status,
				});
			}
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
			const groups = removeConfiguredCoordinatorGroup(groupId);
			return c.json({
				ok: true,
				group,
				status: coordinatorAdminStatusPayload(),
				disconnected_group_id: groupId,
				groups,
			});
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
			let defaultSpaceMembership = null;
			let setupWarning = null;
			try {
				defaultSpaceMembership = await maybeGrantDefaultSpaceOnJoin({
					store: getStore(),
					config,
					groupId: result.group_id,
					deviceId: result.device_id,
				});
			} catch (grantError) {
				setupWarning = {
					step: "default_space_grant",
					error: grantError instanceof Error ? grantError.message : String(grantError),
				};
			}
			return c.json({
				ok: true,
				request: result,
				default_space_membership: defaultSpaceMembership,
				setup_warning: setupWarning,
				status,
			});
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
			const requestedFingerprint = String(body.fingerprint ?? "").trim();
			const addressesInput = Array.isArray(body.peer_addresses) ? body.peer_addresses : [];
			const addresses = mergeAddresses(
				[],
				addressesInput.map((item) => String(item ?? "").trim()).filter((item) => item.length > 0),
			);
			if (!peerDeviceId || !publicKey) {
				return c.json({ error: "peer_device_id_and_public_key_required" }, 400);
			}
			const fingerprint = requestedFingerprint || fingerprintPublicKey(publicKey);
			if (fingerprintPublicKey(publicKey) !== fingerprint) {
				return c.json({ error: "fingerprint_mismatch" }, 400);
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
				{
					error: result.error,
					detail: result.detail,
					...(result.reason ? { reason: result.reason } : {}),
				},
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
				default_space_scope_id: null,
				auto_grant_default_space_on_join: false,
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
		const autoGrantDefaultSpace =
			typeof body.auto_grant_default_space_on_join === "boolean"
				? body.auto_grant_default_space_on_join
				: undefined;
		const defaultSpaceScopeId =
			body.default_space_scope_id === undefined
				? undefined
				: optionalViewerString(body, "default_space_scope_id");
		if (autoGrantDefaultSpace === true && !defaultSpaceScopeId) {
			return c.json(
				{
					error: "default_space_scope_id_required_for_auto_grant",
					status,
				},
				400,
			);
		}
		const store = getStore();
		try {
			const preferences = upsertCoordinatorGroupPreference(store.db, {
				coordinator_id: coordinatorId,
				group_id: groupId,
				projects_include: normalizeList(body.projects_include),
				projects_exclude: normalizeList(body.projects_exclude),
				auto_seed_scope: autoSeed,
				default_space_scope_id: defaultSpaceScopeId,
				auto_grant_default_space_on_join: autoGrantDefaultSpace,
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
