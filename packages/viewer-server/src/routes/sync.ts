/**
 * Sync routes — status, peers, actors, attempts, pairing, mutations.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import type {
	CoordinatorBootstrapGrantVerification,
	CoordinatorScope,
	CoordinatorScopeMembership,
	MaintenanceJobSnapshot,
	MemoryStore,
	ProjectScopeGuardrailWarning,
	ReassignScopeCapability,
	RecipientPolicyCoordinatorEffectReceipt,
	RecipientPolicyPeerCapability,
	RecipientPolicyReconcileResult,
	RecipientPolicyReconcilerEffects,
	RecipientPolicyReviewDecisionV1,
	RecipientPolicyReviewResolveRequestV1,
	ReplicationOp,
	SemanticIndexDiagnostics,
	ShareOperationLifecycleStepInput,
	ShareOperationPlan,
	SharePersonIntent,
	ShareProjectIntent,
} from "@codemem/core";
import {
	ACCESS_CLEANUP_OP_TYPE,
	addSyncScopeToBoundary,
	analyzeProjectScopeMappingChangeGuardrails,
	applyReplicationOps,
	buildAuthHeaders,
	buildBaseUrl,
	canonicalWorkspaceIdentity,
	cleanupNonces,
	commitRecipientPolicyEdges,
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
	countShareableProjectMemories,
	createCoordinatorReciprocalApproval,
	DEFAULT_TIME_WINDOW_S,
	decodeInvitePayload,
	defaultSpaceScopeIdForGroup,
	deleteProjectScopeSettingsMapping,
	diagnoseStalePeerReceivedRows,
	ensureDeviceIdentity,
	executeShareProvisioning,
	extractInvitePayload,
	extractReplicationOps,
	type FilterReplicationSkipped,
	filterReplicationOpsForSyncWithStatus,
	fingerprintPublicKey,
	formatHostPort,
	friendlyDeviceName,
	getCoordinatorGroupPreference,
	getRecipientPolicyAuthorityState,
	getSemanticIndexDiagnostics,
	getSyncResetState,
	type InboundScopeRejectionPeerSummary,
	inviteTokenDigest,
	isProjectSyncEnablementError,
	isScopedSyncCapability,
	LEGACY_SHARED_REVIEW_SCOPE_ID,
	LOCAL_DEFAULT_SCOPE_ID,
	LOCAL_SYNC_CAPABILITY,
	LOCAL_SYNC_FEATURES,
	listAuthorizedScopesForPeer,
	listCoordinatorJoinRequests,
	listInboundScopeRejections,
	listLegacyRecipientPolicyProjections,
	listMaintenanceJobs,
	listPerPeerScopeSyncState,
	listProjectScopeCandidates,
	listProjectScopeInventory,
	listProjectScopeSettingsMappings,
	listRecipientPolicyIntent,
	listRecipientPolicyReview,
	listSharingDomainSettingsScopes,
	loadMemorySnapshotPageForPeer,
	loadReplicationOpsForPeer,
	lookupCoordinatorPeers,
	mergeAddresses,
	migrateRecipientPolicyIntent,
	negotiateSyncCapability,
	normalizeAddress,
	normalizeSyncCapability,
	normalizeSyncFeatures,
	normalizeTeammateName,
	parseAcceptedProjectIntent,
	parseReassignScopePayload,
	parseSyncScopeRequest,
	persistShareOperation,
	personalScopeGrantStatusForPeer,
	planShareOperation,
	previewRecipientPolicyEdges,
	previewRecipientPolicyOnboarding,
	projectShareLifecycle,
	RecipientPolicyEdgeRequestError,
	readCodememConfigFile,
	readCoordinatorSyncConfig,
	reassignProjectScopeInventoryProject,
	reconcileRecipientPolicyProject,
	reconcileShareOperationAcceptance,
	recordNonce,
	refreshConfiguredScopeMembershipCache,
	rejectInboundScopeFailures,
	requestJson,
	resolveRecipientPolicyReview,
	resolveRecipientPolicyReviewBulk,
	runSyncPass,
	SCOPE_MEMBERSHIP_REVOCATION_LIMITATION,
	SYNC_AUTHORIZATION_REFRESH_HEADER,
	SYNC_CAPABILITY_HEADER,
	SYNC_FEATURES_HEADER,
	SYNC_SCOPE_QUERY_PARAM,
	schema,
	summarizeInboundScopeRejections,
	supportsSyncFeature,
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
		effectId: `team-default-grant:${opts.groupId}:${scopeId}:${deviceId}:1`,
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
	requestId: string;
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
	if (defaultScope?.kind !== "team_default") return null;
	return await coordinatorGrantScopeMembershipAction({
		effectId: `team-default-join:${opts.requestId}:${scopeId}:${opts.deviceId}:1`,
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

function coordinatorAdminMembershipEffectId(
	action: "grant" | "revoke",
	attemptId: string,
	input: {
		groupId: string;
		scopeId: string;
		deviceId: string;
		role?: string | null;
		membershipEpoch: number | null;
		coordinatorId?: string | null;
		manifestIssuerDeviceId?: string | null;
		manifestHash: string | null;
		signedManifestJson: string | null;
	},
): string {
	const fingerprint = createHash("sha256")
		.update(
			JSON.stringify({
				action,
				attemptId,
				groupId: input.groupId,
				scopeId: input.scopeId,
				deviceId: input.deviceId,
				role: input.role ?? null,
				membershipEpoch: input.membershipEpoch,
				coordinatorId: input.coordinatorId ?? null,
				manifestIssuerDeviceId: input.manifestIssuerDeviceId ?? null,
				manifestHash: input.manifestHash,
				signedManifestJson: input.signedManifestJson,
			}),
		)
		.digest("hex");
	return `viewer-admin-membership:${action}:${fingerprint}`;
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
		message.includes("scope_membership_effect_conflict") ||
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

function projectInviteAcceptanceFailure(error: unknown): {
	error: string;
	detail: string;
} {
	if (isProjectSyncEnablementError(error)) {
		return { error: error.code, detail: error.detail };
	}
	const code = error instanceof Error ? error.message : "project_invite_acceptance_failed";
	const detailByCode: Record<string, string> = {
		invite_already_bound:
			"This invitation was accepted by another device. Ask the owner to create a new invitation.",
		invite_expired: "This invitation expired. Ask the owner to create a new invitation.",
		invite_identity_conflict:
			"This invitation does not match this Identity. Ask the owner to create a new invitation for this recipient.",
		invite_invalid: "This invitation is no longer valid. Ask the owner to create a new invitation.",
		inviter_identity_invalid:
			"The owner's device identity could not be verified. Ask the owner to review the share and create a new invitation.",
		project_invite_self_acceptance_forbidden:
			"The owner cannot accept this recipient invitation on the owner's device.",
		project_invite_bootstrap_incomplete:
			"The owner's device is not ready to establish trust yet. Retry once, then ask the owner to review the share.",
		project_invite_trust_state_invalid:
			"The owner's trust setup could not be verified. Ask the owner to review the share.",
	};
	const safeCode = Object.hasOwn(detailByCode, code) ? code : "project_invite_acceptance_failed";
	return {
		error: safeCode,
		detail:
			detailByCode[code] ??
			"The invitation could not be accepted safely. Retry once, then ask the owner to review the share.",
	};
}

const PROJECT_INVITE_TTL_HOURS = 7 * 24;
const PROJECT_INVITE_BODY_KEYS = new Set([
	"teammate_name",
	"project_ids",
	"reviewed_project_set_digest",
]);

function projectInviteStringList(body: Record<string, unknown>, key: string): string[] {
	const value = body[key];
	if (!Array.isArray(value)) throw new Error(`${key}_must_be_string_array`);
	if (value.length > 100) throw new Error(`${key}_too_large`);
	const items = value.map((item) => {
		if (typeof item !== "string") throw new Error(`${key}_must_be_string_array`);
		return item.trim();
	});
	if (items.some((item) => !item)) throw new Error(`${key}_contains_empty_value`);
	if (new Set(items).size !== items.length) throw new Error(`${key}_contains_duplicates`);
	return items;
}

function assertProjectInviteBody(body: Record<string, unknown>, creating: boolean): void {
	const allowed = creating ? PROJECT_INVITE_BODY_KEYS : new Set(["teammate_name", "project_ids"]);
	if (Object.keys(body).some((key) => !allowed.has(key))) {
		throw new Error("unexpected_project_invite_fields");
	}
	if (typeof body.teammate_name !== "string") throw new Error("teammate_name_must_be_string");
	if (creating && typeof body.reviewed_project_set_digest !== "string") {
		throw new Error("reviewed_project_set_digest_required");
	}
	if (creating && !/^[a-f0-9]{64}$/u.test(String(body.reviewed_project_set_digest).trim())) {
		throw new Error("reviewed_project_set_digest_invalid");
	}
}

function projectInviteStatus(config = readCoordinatorSyncConfig()): {
	groupId: string;
	config: ReturnType<typeof readCoordinatorSyncConfig>;
} {
	const status = coordinatorAdminStatusPayload(config);
	if (status.readiness !== "ready") throw new Error("team_sharing_not_configured");
	if (status.groups.length !== 1) throw new Error("team_selection_ambiguous");
	if (!status.active_group) throw new Error("team_sharing_not_configured");
	return { groupId: status.active_group, config };
}

type RecipientInviteKind = "team_member" | "add_device";

function recipientInviteKind(value: unknown): RecipientInviteKind {
	if (value === "team_member" || value === "add_device") return value;
	throw new Error("recipient_invite_kind_invalid");
}

function localOnboardingBinding(
	store: MemoryStore,
	deviceName: string | null,
): {
	deviceId: string;
	devicePublicKey: string;
	deviceDisplayName: string;
} {
	const deviceId = ensureStableStoreIdentity(store);
	const devicePublicKey = String(
		store.db
			.prepare("SELECT public_key FROM sync_device WHERE device_id = ?")
			.pluck()
			.get(deviceId) ?? "",
	).trim();
	if (!devicePublicKey) throw new Error("device_public_key_missing");
	const config = readCodememConfigFile();
	return {
		deviceId,
		devicePublicKey,
		deviceDisplayName: friendlyDeviceName({
			explicitName: deviceName ?? String(config.sync_device_name ?? ""),
			osName: hostname(),
			fallbackSeed: deviceId,
		}),
	};
}

function recipientInviteOnboardingPreview(
	store: MemoryStore,
	body: Record<string, unknown>,
	invitationId: string,
) {
	const kind = recipientInviteKind(body.kind ?? body.invite_kind);
	const binding = localOnboardingBinding(store, optionalViewerString(body, "device_name"));
	const teamId = optionalViewerStrictString(body, "policy_team_id");
	const targetIdentityId = optionalViewerStrictString(body, "target_identity_id");
	if (kind === "team_member") {
		if (!teamId || targetIdentityId) throw new Error("recipient_invite_metadata_invalid");
		return previewRecipientPolicyOnboarding(store.db, {
			version: 1,
			journey: "team",
			invitationId,
			identityId: store.actorId,
			...binding,
			teamId,
		});
	}
	if (!targetIdentityId || teamId) throw new Error("recipient_invite_metadata_invalid");
	return previewRecipientPolicyOnboarding(store.db, {
		version: 1,
		journey: "add_device",
		invitationId,
		identityId: targetIdentityId,
		...binding,
	});
}

function recipientInvitePreviewId(kind: RecipientInviteKind, targetId: string): string {
	return `recipient-invite-preview:${kind}:${targetId}`;
}

function coordinatorPreviewDigest(reviewedOnboardingDigest: string): string {
	const match = /^recipient-onboarding-preview-v1:([a-f0-9]{64})$/u.exec(reviewedOnboardingDigest);
	if (!match?.[1]) throw new Error("reviewed_onboarding_digest_invalid");
	return match[1];
}

export function recipientPolicyCapabilityFromStatus(payload: {
	sync_capability?: unknown;
	sync_features?: unknown;
}): RecipientPolicyPeerCapability {
	if (!isScopedSyncCapability(normalizeSyncCapability(payload.sync_capability))) {
		return "unsupported";
	}
	return supportsSyncFeature(payload.sync_features, "reassign_scope") ? "supported" : "unsupported";
}

async function peerSupportsSyncRequirements(
	store: MemoryStore,
	deviceId: string,
	requirements: { scoped: boolean; reassignScope: boolean },
): Promise<RecipientPolicyPeerCapability> {
	const [localDeviceId] = ensureDeviceIdentity(store.db, { keysDir: syncKeysDir() });
	if (deviceId === localDeviceId) return "supported";
	const row = store.db
		.prepare(
			"SELECT addresses_json, pinned_fingerprint, public_key FROM sync_peers WHERE peer_device_id = ?",
		)
		.get(deviceId) as
		| {
				addresses_json: string | null;
				pinned_fingerprint: string | null;
				public_key: string | null;
		  }
		| undefined;
	const expectedFingerprint =
		String(row?.pinned_fingerprint ?? "").trim() ||
		(row?.public_key ? fingerprintPublicKey(row.public_key) : "");
	const addresses = safeJsonList(row?.addresses_json ?? null);
	for (const address of addresses) {
		try {
			const url = `${buildBaseUrl(address)}/v1/status`;
			const headers = {
				...buildAuthHeaders({
					deviceId: localDeviceId,
					method: "GET",
					url,
					bodyBytes: Buffer.alloc(0),
					keysDir: syncKeysDir(),
				}),
				[SYNC_CAPABILITY_HEADER]: LOCAL_SYNC_CAPABILITY,
				[SYNC_FEATURES_HEADER]: LOCAL_SYNC_FEATURES.join(","),
			};
			const [status, payload] = await requestJson("GET", url, { headers, timeoutS: 5 });
			if (status < 200 || status >= 300) continue;
			if (String(payload?.device_id ?? "").trim() !== deviceId) continue;
			if (
				expectedFingerprint &&
				String(payload?.fingerprint ?? "").trim() !== expectedFingerprint
			) {
				continue;
			}
			if (
				requirements.scoped &&
				requirements.reassignScope &&
				recipientPolicyCapabilityFromStatus(payload ?? {}) !== "supported"
			) {
				return "unsupported";
			}
			if (
				requirements.scoped &&
				!isScopedSyncCapability(normalizeSyncCapability(payload?.sync_capability))
			) {
				return "unsupported";
			}
			if (
				requirements.reassignScope &&
				!supportsSyncFeature(payload?.sync_features, "reassign_scope")
			) {
				return "unsupported";
			}
			return "supported";
		} catch {
			// Try the next reviewed address. Ambiguous/unreachable capability fails closed.
		}
	}
	return "undetermined";
}

async function peerSupportsReassignScope(
	store: MemoryStore,
	deviceId: string,
): Promise<ReassignScopeCapability> {
	return peerSupportsSyncRequirements(store, deviceId, {
		scoped: false,
		reassignScope: true,
	});
}

function resolveProjectInviteSelection(
	store: MemoryStore,
	requestedIds: string[],
	initiatingDeviceId: string,
): ShareProjectIntent[] {
	if (requestedIds.length === 0) throw new Error("project_selection_empty");
	const requested = new Set(requestedIds);
	const byIdentity = new Map<
		string,
		ReturnType<typeof listProjectScopeInventory>["projects"][number]
	>();
	let offset = 0;
	while (byIdentity.size < requested.size) {
		const page = listProjectScopeInventory(store.db, { limit: 250, offset });
		for (const project of page.projects) {
			if (requested.has(project.workspace_identity)) {
				byIdentity.set(project.workspace_identity, project);
			}
		}
		if (!page.has_more) break;
		offset += page.limit;
	}
	return requestedIds.map((projectId) => {
		const project = byIdentity.get(projectId);
		if (!project) throw new Error("project_selection_unknown");
		const ambiguous = project.guardrail_warnings.some(
			(warning) => warning.code === "basename_collision_review" && warning.requires_confirmation,
		);
		if (ambiguous) throw new Error("project_selection_ambiguous");
		if (
			project.read_only ||
			project.identity_source === "unmapped" ||
			project.memory_count == null ||
			project.guardrail_warnings.some((warning) => warning.requires_confirmation)
		) {
			throw new Error("project_selection_unsupported");
		}
		return {
			canonicalIdentity: project.workspace_identity,
			displayName: project.display_project,
			identitySource: project.identity_source,
			existingMemoryCount: countShareableProjectMemories(store.db, {
				canonicalIdentity: project.workspace_identity,
				initiatingDeviceId,
			}),
		};
	});
}

function resolveSharePerson(store: MemoryStore, teammateName: string): SharePersonIntent {
	const matches = store.db
		.prepare(
			`SELECT actor_id, display_name, status
			 FROM actors
			 WHERE status IN ('active', 'pending') AND lower(trim(display_name)) = lower(?)
			 ORDER BY actor_id`,
		)
		.all(teammateName) as Array<{ actor_id: string; display_name: string; status: string }>;
	if (matches.length > 1) throw new Error("teammate_match_ambiguous");
	const match = matches[0];
	if (match) {
		return match.status === "pending"
			? { kind: "pending", personId: match.actor_id, displayName: match.display_name }
			: { kind: "existing", personId: match.actor_id, displayName: match.display_name };
	}
	return { kind: "pending", displayName: teammateName };
}

function projectInvitePlan(
	store: MemoryStore,
	body: Record<string, unknown>,
	createdAt: string,
	inviteExpiresAt: string,
): { plan: ShareOperationPlan; config: ReturnType<typeof readCoordinatorSyncConfig> } {
	const teammateName = normalizeTeammateName(String(body.teammate_name));
	const [localDeviceId] = ensureDeviceIdentity(store.db, { keysDir: syncKeysDir() });
	store.adoptEnsuredDeviceIdentity(localDeviceId);
	const projects = resolveProjectInviteSelection(
		store,
		projectInviteStringList(body, "project_ids"),
		localDeviceId,
	);
	const { groupId, config } = projectInviteStatus();
	return {
		plan: planShareOperation({
			inviterActorId: store.actorId,
			inviterDeviceIds: [localDeviceId],
			person: resolveSharePerson(store, teammateName),
			projects,
			coordinatorGroupId: groupId,
			createdAt,
			inviteExpiresAt,
		}),
		config,
	};
}

function projectInvitePreview(plan: ShareOperationPlan) {
	return {
		operation_id: plan.operationId,
		teammate: {
			display_name: plan.teammateName,
			match: plan.personKind,
			...(plan.personKind === "existing" ? { person_id: plan.personId } : {}),
		},
		projects: plan.projects.map((project) => ({
			project_id: project.canonicalIdentity,
			display_name: project.displayName,
			existing_memory_count: project.existingMemoryCount,
		})),
		existing_memory_count: plan.projects.reduce(
			(total, project) => total + project.existingMemoryCount,
			0,
		),
		future_memories_shared: true as const,
		history_policy: plan.historyPolicy,
		reviewed_project_set_digest: plan.reviewedProjectSetDigest,
	};
}

type CoordinatorProjectInvitePayload = Record<string, unknown> & {
	operation_id?: string;
	group_id?: string;
	state?: string;
};

async function coordinatorProjectInvitePayload(operationId: string): Promise<{
	groupId: string;
	config: ReturnType<typeof readCoordinatorSyncConfig>;
	payload: CoordinatorProjectInvitePayload;
}> {
	const { groupId, config } = projectInviteStatus();
	const [status, payload] = await requestJson(
		"GET",
		`${buildBaseUrl(config.syncCoordinatorUrl)}/v1/admin/project-invites/${encodeURIComponent(operationId)}?group_id=${encodeURIComponent(groupId)}`,
		{
			headers: { "X-Codemem-Coordinator-Admin": config.syncCoordinatorAdminSecret },
			timeoutS: 10,
		},
	).catch((cause: unknown) => {
		const error = new Error("coordinator_unavailable", { cause });
		Object.assign(error, { status: 503 });
		throw error;
	});
	if (status < 200 || status >= 300) {
		const error = new Error(String(payload?.error ?? "operation_read_failed"));
		Object.assign(error, { status });
		throw error;
	}
	if (!payload || payload.operation_id !== operationId || payload.group_id !== groupId) {
		const error = new Error("operation_scope_mismatch");
		Object.assign(error, { status: 409 });
		throw error;
	}
	return { groupId, config, payload: payload as CoordinatorProjectInvitePayload };
}

async function reconcileProjectInviteAcceptance(
	store: MemoryStore,
	operationId: string,
): Promise<{ accepted: boolean; payload: CoordinatorProjectInvitePayload }> {
	const owner = store.db
		.prepare("SELECT inviter_actor_id FROM share_operations WHERE operation_id = ?")
		.pluck()
		.get(operationId) as string | undefined;
	if (!owner) throw new Error("operation_not_found");
	if (owner !== store.actorId) throw new Error("operation_scope_mismatch");
	ensureLocalActorRecord(store);
	const { groupId, payload } = await coordinatorProjectInvitePayload(operationId);
	if (payload.state === "waiting_for_acceptance") return { accepted: false, payload };
	if (payload.state !== "accepted") {
		const error = new Error("operation_state_invalid");
		Object.assign(error, { status: 409 });
		throw error;
	}
	const required = [
		"reviewed_project_set_digest",
		"recipient_actor_id",
		"recipient_display_name",
		"recipient_device_id",
		"recipient_device_display_name",
		"recipient_public_key",
		"recipient_fingerprint",
		"consumed_at",
		"trust_state",
	] as const;
	if (required.some((key) => typeof payload[key] !== "string" || !String(payload[key]).trim())) {
		const error = new Error("operation_acceptance_invalid");
		Object.assign(error, { status: 409 });
		throw error;
	}
	const trustState = String(payload.trust_state);
	const bootstrapGrantId =
		typeof payload.bootstrap_grant_id === "string" && payload.bootstrap_grant_id.trim()
			? payload.bootstrap_grant_id
			: null;
	if (
		(trustState !== "pending_inviter_device" && trustState !== "bootstrap_grant_created") ||
		(trustState === "bootstrap_grant_created") !== Boolean(bootstrapGrantId)
	) {
		const error = new Error("operation_trust_state_invalid");
		Object.assign(error, { status: 409 });
		throw error;
	}
	const projects = parseAcceptedProjectIntent(payload.projects);
	reconcileShareOperationAcceptance(store.db, {
		operationId,
		localInviterActorId: store.actorId,
		coordinatorGroupId: groupId,
		reviewedProjectSetDigest: String(payload.reviewed_project_set_digest),
		recipientActorId: String(payload.recipient_actor_id),
		recipientDisplayName: String(payload.recipient_display_name),
		recipientDeviceId: String(payload.recipient_device_id),
		recipientDeviceDisplayName: String(payload.recipient_device_display_name),
		recipientPublicKey: String(payload.recipient_public_key),
		recipientFingerprint: String(payload.recipient_fingerprint),
		consumedAt: String(payload.consumed_at),
		trustState,
		bootstrapGrantId,
		projects,
	});
	return { accepted: true, payload };
}

interface ShareOperationReadRow {
	operation_id: string;
	state: string;
	person_id: string;
	teammate_name: string;
	recipient_actor_id: string | null;
	recipient_display_name: string | null;
	recipient_device_id: string | null;
	recipient_device_display_name: string | null;
	invite_expires_at: string;
	acceptance_consumed_at: string | null;
	created_at: string;
	updated_at: string;
	actor_display_name: string | null;
	peer_display_name: string | null;
	device_last_seen_at: string | null;
}

async function shareOperationReadModels(
	store: MemoryStore,
	operationId?: string,
	includeInviteLinks = true,
) {
	const rows = store.db
		.prepare(`SELECT o.operation_id, o.state, o.person_id, o.teammate_name,
			o.recipient_actor_id, o.recipient_display_name, o.recipient_device_id,
			o.recipient_device_display_name, o.invite_expires_at, o.acceptance_consumed_at,
			o.created_at, o.updated_at, a.display_name AS actor_display_name,
			p.name AS peer_display_name, p.last_sync_at AS device_last_seen_at
		 FROM share_operations o
		 LEFT JOIN actors a ON a.actor_id = o.person_id
		 LEFT JOIN sync_peers p ON p.peer_device_id = o.recipient_device_id
		 WHERE o.inviter_actor_id = ? AND (? IS NULL OR o.operation_id = ?)
		 ORDER BY o.created_at DESC, o.operation_id`)
		.all(store.actorId, operationId ?? null, operationId ?? null) as ShareOperationReadRow[];
	const now = new Date().toISOString();
	return Promise.all(
		rows.map(async (row) => {
			const projects = store.db
				.prepare(`SELECT canonical_project_identity AS project_id, display_name, existing_memory_count
				 FROM share_operation_projects WHERE operation_id = ? ORDER BY ordinal`)
				.all(row.operation_id) as Array<{
				project_id: string;
				display_name: string;
				existing_memory_count: number;
			}>;
			const steps = (
				store.db
					.prepare(`SELECT step_key, status, attempt_count, started_at, last_attempt_at,
						safe_error_code, updated_at FROM share_operation_steps WHERE operation_id = ?`)
					.all(row.operation_id) as Array<{
					step_key: string;
					status: ShareOperationLifecycleStepInput["status"];
					attempt_count: number;
					started_at: string | null;
					last_attempt_at: string | null;
					safe_error_code: string | null;
					updated_at: string;
				}>
			).map(
				(step): ShareOperationLifecycleStepInput => ({
					attemptCount: step.attempt_count,
					lastAttemptAt: step.last_attempt_at,
					safeErrorCode: step.safe_error_code,
					startedAt: step.started_at,
					status: step.status,
					stepKey: step.step_key,
					updatedAt: step.updated_at,
				}),
			);
			let inviteLink: string | null = null;
			let projectedState = row.state;
			if (includeInviteLinks && row.state === "waiting_for_acceptance") {
				try {
					const remote = await coordinatorProjectInvitePayload(row.operation_id);
					if (remote.payload.state === "accepted") projectedState = "accepted";
					inviteLink =
						typeof remote.payload.invite_link === "string" && remote.payload.invite_link.trim()
							? remote.payload.invite_link
							: null;
				} catch {
					// A read-model refresh remains useful when the coordinator is temporarily unavailable.
				}
			}
			const personId = row.recipient_actor_id || row.person_id;
			const personName = row.recipient_display_name || row.actor_display_name || row.teammate_name;
			const deviceName = row.recipient_device_display_name || row.peer_display_name;
			const lifecycle = projectShareLifecycle({
				deviceLastSeenAt: row.device_last_seen_at,
				deviceName,
				inviteLink,
				now,
				personName,
				state: projectedState,
				steps,
			});
			return {
				operation_id: row.operation_id,
				person: { actor_id: personId, display_name: personName },
				devices:
					row.recipient_device_id && deviceName
						? [
								{
									device_id: row.recipient_device_id,
									display_name: deviceName,
									last_seen_at: row.device_last_seen_at,
								},
							]
						: [],
				projects,
				project_count: projects.length,
				lifecycle: {
					state: lifecycle.lifecycle,
					label: lifecycle.label,
					explanation: lifecycle.explanation,
					primary_action:
						lifecycle.primaryAction?.kind === "copy_invite"
							? {
									kind: "copy_invite",
									label: lifecycle.primaryAction.label,
									invite_link: lifecycle.primaryAction.inviteLink,
								}
							: !includeInviteLinks && lifecycle.lifecycle === "waiting_for_acceptance"
								? { kind: "copy_invite", label: "Copy invite" }
								: lifecycle.primaryAction,
				},
				timestamps: {
					created_at: row.created_at,
					updated_at: row.updated_at,
					accepted_at: row.acceptance_consumed_at,
					invite_expires_at: row.invite_expires_at,
				},
			};
		}),
	);
}

async function executeProjectShareProvisioning(store: MemoryStore, operationId: string) {
	const { groupId, config } = projectInviteStatus();
	const coordinatorId = config.syncCoordinatorUrl || null;
	if (!coordinatorId) throw new Error("coordinator_not_configured");
	const [localDeviceId] = ensureDeviceIdentity(store.db, { keysDir: syncKeysDir() });
	return executeShareProvisioning(
		store.db,
		{ operationId, initiatingDeviceId: localDeviceId },
		{
			createOrGetBoundary: async (project, expectedGroupId) => {
				if (expectedGroupId !== groupId) throw new Error("operation_scope_mismatch");
				const readExisting = async () =>
					(
						await coordinatorListScopesAction({
							groupId,
							includeInactive: true,
							remoteUrl: config.syncCoordinatorUrl || null,
							adminSecret: config.syncCoordinatorAdminSecret || null,
						})
					).find((scope) => scope.scope_id === project.boundaryId) ?? null;
				const existing = await readExisting();
				if (existing) return existing;
				try {
					return await coordinatorCreateScopeAction({
						groupId,
						scopeId: project.boundaryId,
						label: project.displayName,
						kind: "managed_project",
						authorityType: "coordinator",
						coordinatorId,
						membershipEpoch: 1,
						status: "active",
						remoteUrl: config.syncCoordinatorUrl || null,
						adminSecret: config.syncCoordinatorAdminSecret || null,
					});
				} catch (error) {
					const reread = await readExisting();
					if (reread) return reread;
					throw error;
				}
			},
			grantMembership: ({ effectId, groupId: expectedGroupId, scopeId, deviceId, role }) => {
				if (expectedGroupId !== groupId) throw new Error("operation_scope_mismatch");
				return coordinatorGrantScopeMembershipAction({
					effectId,
					groupId,
					scopeId,
					deviceId,
					role,
					membershipEpoch: 1,
					coordinatorId,
					remoteUrl: config.syncCoordinatorUrl || null,
					adminSecret: config.syncCoordinatorAdminSecret || null,
				});
			},
			supportsReassignScope: (deviceId) => peerSupportsReassignScope(store, deviceId),
			refreshAuthorization: async (expectedGroupId) => {
				if (expectedGroupId !== groupId) throw new Error("operation_scope_mismatch");
				const refreshed = await refreshConfiguredScopeMembershipCache(store.db, config, {
					keysDir: syncKeysDir(),
				});
				const group = refreshed.groups.find((item) => item.groupId === groupId);
				if (group?.status !== "refreshed") throw new Error("authorization_refresh_failed");
			},
			runInitialSync: (recipientDeviceId) =>
				runSyncPass(store.db, recipientDeviceId, {
					keysDir: syncKeysDir(),
					scanner: store.scanner,
					refreshAuthorization: true,
				}),
		},
	);
}

export interface AdvanceProjectShareOperationResult {
	advanced: boolean;
	state: "active" | "waiting_for_acceptance";
}

export async function advanceProjectShareOperation(
	store: MemoryStore,
	operationId: string,
): Promise<AdvanceProjectShareOperationResult> {
	const operation = store.db
		.prepare(
			"SELECT state, inviter_actor_id, recipient_device_id FROM share_operations WHERE operation_id = ?",
		)
		.get(operationId) as
		| { state: string; inviter_actor_id: string; recipient_device_id: string | null }
		| undefined;
	if (!operation) throw new Error("operation_not_found");
	if (operation.inviter_actor_id !== store.actorId) throw new Error("operation_scope_mismatch");
	if (!operation.recipient_device_id) {
		const reconciliation = await reconcileProjectInviteAcceptance(store, operationId);
		if (!reconciliation.accepted) {
			return { advanced: false, state: "waiting_for_acceptance" };
		}
	}
	await executeProjectShareProvisioning(store, operationId);
	return { advanced: true, state: "active" };
}

export interface AdvancePendingProjectSharesResult {
	processed: number;
	advanced: number;
	waiting: number;
	attention: number;
	failed: number;
	items: Array<{
		operationId: string;
		outcome:
			| "advanced"
			| "waiting_for_acceptance"
			| "waiting_for_device"
			| "retry_scheduled"
			| "needs_attention"
			| "failed";
		error?: string;
	}>;
}

const AUTOMATIC_SHARE_OPERATION_STATES = [
	"waiting_for_acceptance",
	"accepted",
	"provisioning",
	"initial_sync",
	"waiting_for_device",
] as const;

const AUTOMATIC_WAITING_ACCEPTANCE_RETRY_COOLDOWN_MS = 30 * 1000;
const AUTOMATIC_WAITING_DEVICE_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
const TERMINAL_SHARE_MAINTENANCE_ERRORS = new Set([
	"coordinator_not_configured",
	"team_sharing_not_configured",
	"team_selection_ambiguous",
	"initiating_device_not_reviewed",
	"inviter_project_access_ambiguous",
	"managed_boundary_plan_missing",
	"operation_device_binding_missing",
	"operation_intent_invalid",
	"provisioning_membership_plan_invalid",
	"device_binding_conflict",
	"intent_conflict",
	"inviter_identity_conflict",
]);
const PROJECT_INVITE_OWNER_CONFLICT_ERRORS = new Set([
	"operation_scope_mismatch",
	"operation_state_invalid",
	"operation_acceptance_invalid",
	"operation_trust_state_invalid",
	"operation_intent_invalid",
	"operation_intent_mismatch",
	"recipient_fingerprint_mismatch",
	"recipient_device_identity_conflict",
	"recipient_actor_conflict",
	"pending_person_identity_conflict",
	"device_binding_conflict",
	"intent_conflict",
	"inviter_identity_conflict",
]);
const TERMINAL_RECONCILIATION_ERRORS = new Set([
	"coordinator_not_configured",
	"team_sharing_not_configured",
	"team_selection_ambiguous",
	"operation_not_found",
	...PROJECT_INVITE_OWNER_CONFLICT_ERRORS,
]);

function errorStatus(error: unknown): number | null {
	const value = error && typeof error === "object" ? (error as { status?: unknown }).status : null;
	return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599
		? value
		: null;
}

function projectInviteOwnerErrorResponse(
	error: unknown,
	fallback: { code: "operation_read_failed" | "operation_reconcile_failed"; status: 400 | 409 },
): {
	code: string;
	status: 400 | 404 | 409 | 502 | 503;
} {
	const message = error instanceof Error ? error.message : "";
	const status = errorStatus(error);
	if (message === "operation_not_found" && (status == null || status === 404)) {
		return { code: message, status: 404 };
	}
	if (PROJECT_INVITE_OWNER_CONFLICT_ERRORS.has(message) && (status == null || status === 409)) {
		return { code: message, status: 409 };
	}
	if (status != null && status >= 500 && message !== "coordinator_unavailable") {
		return { code: "coordinator_upstream_failed", status: 502 };
	}
	if (message === "coordinator_unavailable" || status === 408 || status === 429 || status === 503) {
		return { code: "coordinator_unavailable", status: 503 };
	}
	return fallback;
}

function isRetryableReconciliationError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	if (TERMINAL_RECONCILIATION_ERRORS.has(message)) return false;
	const status = errorStatus(error);
	return status == null || status === 408 || status === 429 || status >= 500;
}

function safeReconciliationErrorCode(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return TERMINAL_RECONCILIATION_ERRORS.has(message) ? message : "operation_read_failed";
}

function recordInviteReconciliationFailure(
	store: MemoryStore,
	operationId: string,
	error: unknown,
	now: string,
): "retry_scheduled" | "needs_attention" {
	const safeErrorCode = safeReconciliationErrorCode(error);
	const retryable = isRetryableReconciliationError(error);
	store.db
		.prepare(`UPDATE share_operation_steps SET
			status = CASE WHEN ? = 1 THEN 'pending' ELSE 'failed' END,
			attempt_count = attempt_count + 1, last_attempt_at = ?, safe_error_code = ?, updated_at = ?
			WHERE operation_id = ? AND step_key = 'invite_consumption'`)
		.run(retryable ? 1 : 0, now, safeErrorCode, now, operationId);
	const outcome = retryable ? "retry_scheduled" : "needs_attention";
	store.db
		.prepare("UPDATE share_operations SET state = ?, updated_at = ? WHERE operation_id = ?")
		.run(
			outcome === "needs_attention" ? "needs_attention" : "waiting_for_acceptance",
			now,
			operationId,
		);
	return outcome;
}

export async function advancePendingProjectShares(
	store: MemoryStore,
	options: {
		limit?: number;
		now?: Date;
		advanceOperation?: (
			store: MemoryStore,
			operationId: string,
		) => Promise<AdvanceProjectShareOperationResult>;
	} = {},
): Promise<AdvancePendingProjectSharesResult> {
	const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 3), 10));
	const placeholders = AUTOMATIC_SHARE_OPERATION_STATES.map(() => "?").join(", ");
	const maintenanceNow = options.now ?? new Date();
	const waitingAcceptanceRetryBefore = new Date(
		maintenanceNow.getTime() - AUTOMATIC_WAITING_ACCEPTANCE_RETRY_COOLDOWN_MS,
	).toISOString();
	const waitingRetryBefore = new Date(
		maintenanceNow.getTime() - AUTOMATIC_WAITING_DEVICE_RETRY_COOLDOWN_MS,
	).toISOString();
	const rows = store.db
		.prepare(`SELECT operation_id FROM share_operations
		 WHERE inviter_actor_id = ?
		 AND state IN (${placeholders})
		 AND (state <> 'waiting_for_acceptance' OR updated_at <= ?)
		 AND (state <> 'waiting_for_device' OR updated_at <= ?)
		 ORDER BY CASE WHEN state IN ('accepted', 'provisioning', 'initial_sync') THEN 0 ELSE 1 END,
			CASE WHEN state IN ('waiting_for_acceptance', 'waiting_for_device')
				THEN updated_at ELSE created_at END ASC,
			created_at ASC, operation_id ASC
		 LIMIT ?`)
		.all(
			store.actorId,
			...AUTOMATIC_SHARE_OPERATION_STATES,
			waitingAcceptanceRetryBefore,
			waitingRetryBefore,
			limit,
		) as Array<{
		operation_id: string;
	}>;
	const advanceOperation = options.advanceOperation ?? advanceProjectShareOperation;
	const result: AdvancePendingProjectSharesResult = {
		processed: 0,
		advanced: 0,
		waiting: 0,
		attention: 0,
		failed: 0,
		items: [],
	};
	for (const row of rows) {
		result.processed += 1;
		try {
			const advanced = await advanceOperation(store, row.operation_id);
			if (!advanced.advanced) {
				store.db
					.prepare("UPDATE share_operations SET updated_at = ? WHERE operation_id = ?")
					.run(maintenanceNow.toISOString(), row.operation_id);
				result.waiting += 1;
				result.items.push({
					operationId: row.operation_id,
					outcome: "waiting_for_acceptance",
				});
				continue;
			}
			result.advanced += 1;
			result.items.push({ operationId: row.operation_id, outcome: "advanced" });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const state = store.db
				.prepare("SELECT state FROM share_operations WHERE operation_id = ?")
				.pluck()
				.get(row.operation_id);
			if (message === "waiting_for_device" || state === "waiting_for_device") {
				result.waiting += 1;
				result.items.push({ operationId: row.operation_id, outcome: "waiting_for_device" });
				continue;
			}
			if (state === "needs_attention") {
				result.attention += 1;
				result.items.push({
					operationId: row.operation_id,
					outcome: "needs_attention",
					error: message,
				});
				continue;
			}
			if (state === "waiting_for_acceptance") {
				const outcome = recordInviteReconciliationFailure(
					store,
					row.operation_id,
					error,
					maintenanceNow.toISOString(),
				);
				if (outcome === "needs_attention") result.attention += 1;
				else result.waiting += 1;
				result.items.push({ operationId: row.operation_id, outcome, error: message });
				continue;
			}
			if (TERMINAL_SHARE_MAINTENANCE_ERRORS.has(message)) {
				store.db
					.prepare(
						"UPDATE share_operations SET state = 'needs_attention', updated_at = ? WHERE operation_id = ?",
					)
					.run(maintenanceNow.toISOString(), row.operation_id);
				result.attention += 1;
				result.items.push({
					operationId: row.operation_id,
					outcome: "needs_attention",
					error: message,
				});
				continue;
			}
			result.failed += 1;
			result.items.push({
				operationId: row.operation_id,
				outcome: "failed",
				error: message,
			});
		}
	}
	return result;
}

const RECIPIENT_POLICY_MAINTENANCE_MAX_LIMIT = 10;
const RECIPIENT_POLICY_MAINTENANCE_DEFAULT_LIMIT = 3;
const RECIPIENT_POLICY_MAINTENANCE_BACKOFF_MS = 60_000;
const RECIPIENT_POLICY_WAITING_ERRORS = new Set([
	"recipient_policy_capability_undetermined",
	"recipient_policy_parity_incomplete",
	"recipient_policy_snapshot_not_fresh",
]);

interface RecipientPolicyCoordinatorBoundary {
	coordinatorId: string;
	groupId: string;
	membershipEpoch: number;
}

function recipientPolicyCoordinatorBoundary(
	store: MemoryStore,
	scopeId: string,
): RecipientPolicyCoordinatorBoundary {
	const row = store.db
		.prepare(
			`SELECT coordinator_id, group_id, membership_epoch FROM replication_scopes
			 WHERE scope_id = ? AND kind = 'managed_project' AND authority_type = 'coordinator'
			 AND status = 'active'`,
		)
		.get(scopeId) as
		| {
				coordinator_id: string | null;
				group_id: string | null;
				membership_epoch: number;
		  }
		| undefined;
	const coordinatorId = String(row?.coordinator_id ?? "").trim();
	const groupId = String(row?.group_id ?? "").trim();
	const membershipEpoch = Number(row?.membership_epoch);
	if (!coordinatorId || !groupId || !Number.isSafeInteger(membershipEpoch) || membershipEpoch < 0) {
		throw new Error("recipient_policy_active_managed_scope_required");
	}
	return { coordinatorId, groupId, membershipEpoch };
}

function recipientPolicySnapshotFingerprint(
	scopeId: string,
	scopeMembershipEpoch: number,
	memberships: Array<{
		deviceId: string;
		status: "active" | "revoked";
		membershipEpoch: number;
	}>,
): string {
	const canonical = memberships
		.toSorted(
			(left, right) =>
				left.deviceId.localeCompare(right.deviceId) ||
				left.status.localeCompare(right.status) ||
				left.membershipEpoch - right.membershipEpoch,
		)
		.map(
			(membership) =>
				`${membership.deviceId}\u0000${membership.status}\u0000${membership.membershipEpoch}`,
		)
		.join("\u0001");
	return `recipient-policy-coordinator-snapshot-v2:${createHash("sha256")
		.update(`${scopeId}\u0000${scopeMembershipEpoch}\u0000${canonical}`)
		.digest("hex")}`;
}

export function createRecipientPolicyReconcilerEffects(
	store: MemoryStore,
	options: {
		config?: ReturnType<typeof readCoordinatorSyncConfig>;
		now?: () => string;
	} = {},
): RecipientPolicyReconcilerEffects {
	const config = options.config ?? readCoordinatorSyncConfig();
	const now = options.now ?? (() => new Date().toISOString());
	const target = (scopeId: string) => recipientPolicyCoordinatorBoundary(store, scopeId);
	const coordinatorOptions = (scopeId: string) => {
		const boundary = target(scopeId);
		const remoteUrl = config.syncCoordinatorUrl?.trim();
		const adminSecret = config.syncCoordinatorAdminSecret?.trim();
		if (!remoteUrl || !adminSecret) throw new Error("recipient_policy_effect_failed");
		if (!config.syncCoordinatorGroups.includes(boundary.groupId)) {
			throw new Error("recipient_policy_effect_failed");
		}
		try {
			if (buildBaseUrl(boundary.coordinatorId) !== buildBaseUrl(remoteUrl)) {
				throw new Error("recipient_policy_effect_failed");
			}
		} catch {
			throw new Error("recipient_policy_effect_failed");
		}
		return {
			...boundary,
			remoteUrl,
			adminSecret,
		};
	};
	return {
		now,
		snapshot: async ({ scopeId }) => {
			const targetOptions = coordinatorOptions(scopeId);
			const memberships = await coordinatorListScopeMembershipsAction({
				groupId: targetOptions.groupId,
				scopeId,
				includeRevoked: true,
				remoteUrl: targetOptions.remoteUrl,
				adminSecret: targetOptions.adminSecret,
			}).catch(() => {
				throw new Error("recipient_policy_snapshot_not_fresh");
			});
			const snapshotMemberships = memberships.map((membership) => {
				if (membership.status !== "active" && membership.status !== "revoked") {
					throw new Error("recipient_policy_snapshot_invalid");
				}
				const status: "active" | "revoked" = membership.status;
				return {
					deviceId: membership.device_id,
					status,
					membershipEpoch: membership.membership_epoch,
				};
			});
			return {
				authoritative: true,
				scopeId,
				scopeMembershipEpoch: targetOptions.membershipEpoch,
				fingerprint: recipientPolicySnapshotFingerprint(
					scopeId,
					targetOptions.membershipEpoch,
					snapshotMemberships,
				),
				observedAt: now(),
				memberships: snapshotMemberships,
			};
		},
		probeCapability: (deviceId) =>
			peerSupportsSyncRequirements(store, deviceId, {
				scoped: true,
				reassignScope: true,
			}),
		revoke: async (input): Promise<RecipientPolicyCoordinatorEffectReceipt> => {
			const targetOptions = coordinatorOptions(input.scopeId);
			await coordinatorRevokeScopeMembershipAction({
				effectId: input.effectId,
				groupId: targetOptions.groupId,
				scopeId: input.scopeId,
				deviceId: input.deviceId,
				remoteUrl: targetOptions.remoteUrl,
				adminSecret: targetOptions.adminSecret,
			});
			return {
				effectId: input.effectId,
				scopeId: input.scopeId,
				deviceId: input.deviceId,
				status: "revoked",
			};
		},
		grant: async (input): Promise<RecipientPolicyCoordinatorEffectReceipt> => {
			const targetOptions = coordinatorOptions(input.scopeId);
			const membership = await coordinatorGrantScopeMembershipAction({
				effectId: input.effectId,
				groupId: targetOptions.groupId,
				scopeId: input.scopeId,
				deviceId: input.deviceId,
				role: input.role,
				coordinatorId: targetOptions.coordinatorId,
				remoteUrl: targetOptions.remoteUrl,
				adminSecret: targetOptions.adminSecret,
			});
			return {
				effectId: input.effectId,
				scopeId: membership.scope_id,
				deviceId: membership.device_id,
				status: membership.status === "active" ? "active" : "revoked",
			};
		},
		refresh: async ({ scopeId }) => {
			const boundary = target(scopeId);
			const refreshed = await refreshConfiguredScopeMembershipCache(store.db, config, {
				keysDir: syncKeysDir(),
			});
			const group = refreshed.groups.find((item) => item.groupId === boundary.groupId);
			if (group?.status !== "refreshed") throw new Error("recipient_policy_effect_failed");
		},
	};
}

export interface ReconcileRecipientPolicyProjectsResult {
	processed: number;
	active: number;
	waiting: number;
	attention: number;
	failed: number;
	items: Array<{
		canonicalProjectIdentity: string;
		status: RecipientPolicyReconcileResult["status"] | "failed";
		safeErrorCode: string | null;
	}>;
}

export async function reconcileRecipientPolicyProjects(
	store: MemoryStore,
	options: {
		limit?: number;
		now?: Date;
		backoffMs?: number;
		leaseOwner?: string;
		effects?: RecipientPolicyReconcilerEffects;
		reconcileProject?: typeof reconcileRecipientPolicyProject;
	} = {},
): Promise<ReconcileRecipientPolicyProjectsResult> {
	const limit = Math.max(
		1,
		Math.min(
			Math.trunc(options.limit ?? RECIPIENT_POLICY_MAINTENANCE_DEFAULT_LIMIT),
			RECIPIENT_POLICY_MAINTENANCE_MAX_LIMIT,
		),
	);
	const maintenanceNow = options.now ?? new Date();
	const backoffMs = Math.max(
		0,
		Math.trunc(options.backoffMs ?? RECIPIENT_POLICY_MAINTENANCE_BACKOFF_MS),
	);
	const retryBefore = new Date(maintenanceNow.getTime() - backoffMs).toISOString();
	const rows = store.db
		.prepare(
			`WITH projects AS (
				SELECT DISTINCT canonical_project_identity FROM project_recipients
				UNION
				SELECT canonical_project_identity FROM recipient_policy_authority_states
			)
			 SELECT projects.canonical_project_identity
			 FROM projects
			 LEFT JOIN recipient_policy_authority_states authority
			  ON authority.canonical_project_identity = projects.canonical_project_identity
			 WHERE authority.safe_error_code IS NULL OR authority.last_attempt_at IS NULL
			  OR authority.last_attempt_at <= ?
			 ORDER BY CASE WHEN authority.last_attempt_at IS NULL THEN 0 ELSE 1 END,
			  authority.last_attempt_at, projects.canonical_project_identity
			 LIMIT ?`,
		)
		.all(retryBefore, limit) as Array<{ canonical_project_identity: string }>;
	const effects = options.effects ?? createRecipientPolicyReconcilerEffects(store);
	const reconcileProject = options.reconcileProject ?? reconcileRecipientPolicyProject;
	const result: ReconcileRecipientPolicyProjectsResult = {
		processed: 0,
		active: 0,
		waiting: 0,
		attention: 0,
		failed: 0,
		items: [],
	};
	for (const row of rows) {
		result.processed += 1;
		try {
			const outcome = await reconcileProject(
				store.db,
				{
					canonicalProjectIdentity: row.canonical_project_identity,
					leaseOwner:
						options.leaseOwner ?? `recipient-policy-maintenance:${store.deviceId || process.pid}`,
				},
				effects,
			);
			if (outcome.status === "active") result.active += 1;
			else if (outcome.status === "needs_attention") result.attention += 1;
			else result.waiting += 1;
			result.items.push({
				canonicalProjectIdentity: row.canonical_project_identity,
				status: outcome.status,
				safeErrorCode: outcome.safeErrorCode,
			});
		} catch {
			result.failed += 1;
			result.items.push({
				canonicalProjectIdentity: row.canonical_project_identity,
				status: "failed",
				safeErrorCode: "recipient_policy_reconciliation_failed",
			});
		}
	}
	return result;
}

export type RecipientPolicyReconciliationReadState =
	| "active"
	| "needs_attention"
	| "pending"
	| "verifying"
	| "waiting";

export interface RecipientPolicyReconciliationReadModel {
	version: 1;
	items: Array<{
		canonicalProjectIdentity: string;
		state: RecipientPolicyReconciliationReadState;
		label: string;
		explanation: string;
		deliveredCopiesMayRemain: true;
		revocationWarning: string;
	}>;
}

function recipientPolicyReadState(
	authority: ReturnType<typeof getRecipientPolicyAuthorityState>,
): RecipientPolicyReconciliationReadState {
	if (!authority) return "pending";
	if (authority.safeErrorCode && RECIPIENT_POLICY_WAITING_ERRORS.has(authority.safeErrorCode)) {
		return "waiting";
	}
	if (authority.safeErrorCode || authority.authorityState === "rolled_back") {
		return "needs_attention";
	}
	if (authority.authorityState === "active") return "active";
	if (authority.authorityState === "eligible") return "verifying";
	return "pending";
}

function recipientPolicyReadCopy(state: RecipientPolicyReconciliationReadState): {
	label: string;
	explanation: string;
} {
	if (state === "active") {
		return {
			label: "Recipient policy active",
			explanation: "Recipient policy now controls future access for this Project.",
		};
	}
	if (state === "verifying") {
		return {
			label: "Verifying recipient policy",
			explanation: "Current access matches recipient policy and needs one more stable check.",
		};
	}
	if (state === "waiting") {
		return {
			label: "Waiting to reconcile",
			explanation:
				"Waiting for devices or a fresh coordinator snapshot. No partial grant is applied.",
		};
	}
	if (state === "needs_attention") {
		return {
			label: "Reconciliation needs attention",
			explanation:
				"Legacy scope enforcement remains in control until this Project is safe to retry.",
		};
	}
	return {
		label: "Recipient policy pending",
		explanation: "Legacy scope enforcement remains in control while reconciliation is pending.",
	};
}

export function listRecipientPolicyReconciliationStatus(
	store: MemoryStore,
): RecipientPolicyReconciliationReadModel {
	const projectIds = (
		store.db
			.prepare(
				`SELECT DISTINCT canonical_project_identity FROM project_recipients WHERE status = 'active'
				 UNION SELECT canonical_project_identity FROM recipient_policy_authority_states
				 ORDER BY canonical_project_identity`,
			)
			.all() as Array<{ canonical_project_identity: string }>
	).map((row) => row.canonical_project_identity);
	return {
		version: 1,
		items: projectIds.map((canonicalProjectIdentity) => {
			const state = recipientPolicyReadState(
				getRecipientPolicyAuthorityState(store.db, canonicalProjectIdentity),
			);
			return {
				canonicalProjectIdentity,
				state,
				...recipientPolicyReadCopy(state),
				deliveredCopiesMayRemain: true,
				revocationWarning: SCOPE_MEMBERSHIP_REVOCATION_LIMITATION,
			};
		}),
	};
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
	const workerPublicKey = String(workerEnrollment.public_key ?? "").trim();
	const workerFingerprint = String(workerEnrollment.fingerprint ?? "").trim();
	if (!workerPublicKey || fingerprintPublicKey(workerPublicKey) !== workerFingerprint) {
		return { ok: false, reason: "bootstrap_grant_worker_identity_invalid", deviceId };
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
			publicKey: workerPublicKey,
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
	updatePeerAddresses(store.db, deviceId, [], {
		name: String(workerEnrollment.display_name ?? "").trim() || undefined,
		pinnedFingerprint: workerFingerprint,
		publicKey: workerPublicKey,
		replaceTrust: true,
	});
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
		.select({ actor_id: schema.actors.actor_id, is_local: schema.actors.is_local })
		.from(schema.actors)
		.where(eq(schema.actors.actor_id, store.actorId))
		.get();
	if (existing) {
		// Row already exists for the canonical local actor id; the demotion
		// above guarantees it is the only is_local=1 row, but the row itself
		// may have been previously set to is_local=0 (e.g. via a stale demote
		// from an even earlier identity). Re-mark it as local idempotently.
		if (existing.is_local !== 1) {
			d.update(schema.actors)
				.set({ is_local: 1, updated_at: now })
				.where(eq(schema.actors.actor_id, store.actorId))
				.run();
		}
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

function ensureStableStoreIdentity(store: MemoryStore): string {
	const [deviceId] = ensureDeviceIdentity(store.db, { keysDir: syncKeysDir() });
	store.adoptEnsuredDeviceIdentity(deviceId);
	ensureLocalActorRecord(store);
	return deviceId;
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
	options: { applyScopeFilter?: boolean; supportsReassignScope?: boolean } = {},
): { allowed: ReplicationOp[]; skipped: number; skippedDetail: SafeSkippedSyncDetail | null } {
	const [allowed, , skipped] = filterReplicationOpsForSyncWithStatus(store.db, ops, peerDeviceId, {
		localDeviceId,
		applyScopeFilter: options.applyScopeFilter,
		supportsReassignScope: options.supportsReassignScope,
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
const CLEANUP_DIAGNOSTICS_MAX_ROWS = 250;

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

function cleanupDiagnostics(
	store: MemoryStore,
	localDeviceId: string | null,
	showDiag: boolean,
): Record<string, unknown> {
	const opRows = store.db
		.prepare(
			`SELECT
				SUM(CASE WHEN device_id = ? THEN 1 ELSE 0 END) AS source_authored,
				SUM(CASE WHEN device_id != ? THEN 1 ELSE 0 END) AS applied,
				MAX(created_at) AS latest_at
			 FROM replication_ops
			 WHERE op_type = ?`,
		)
		.get(localDeviceId ?? "", localDeviceId ?? "", ACCESS_CLEANUP_OP_TYPE) as
		| { applied: number | null; latest_at: string | null; source_authored: number | null }
		| undefined;
	const stale =
		localDeviceId && showDiag
			? diagnoseStalePeerReceivedRows(store.db, {
					localDeviceId,
					maxRows: CLEANUP_DIAGNOSTICS_MAX_ROWS,
				})
			: { ambiguous: [], checked: 0, retained: 0, would_delete: 0, would_delete_memory_ids: [] };
	const ambiguousByReason: Record<string, number> = {};
	for (const item of stale.ambiguous) {
		ambiguousByReason[item.reason] = (ambiguousByReason[item.reason] ?? 0) + 1;
	}
	const sourceAuthored = Number(opRows?.source_authored ?? 0);
	const applied = Number(opRows?.applied ?? 0);
	const ambiguous = stale.ambiguous.length;
	const state = stale.would_delete
		? "cleanup_pending"
		: ambiguous
			? "needs_review"
			: applied
				? "cleanup_applied"
				: sourceAuthored
					? "cleanup_announced"
					: "clear";
	return {
		state,
		access_cleanup_ops: {
			source_authored: sourceAuthored,
			applied,
			latest_at: opRows?.latest_at ?? null,
		},
		stale_peer_rows: {
			checked: stale.checked,
			diagnostic_limit: showDiag ? CLEANUP_DIAGNOSTICS_MAX_ROWS : 0,
			scan_skipped: !showDiag || !localDeviceId,
			would_remove: stale.would_delete,
			ambiguous,
			ambiguous_by_reason: ambiguousByReason,
			retained: stale.retained,
			items: showDiag ? stale.ambiguous.slice(0, 25) : undefined,
		},
		redacted: !showDiag,
	};
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
			"This device can reassign only locally owned memories. Peer-owned copies must be fixed on their source device. Online compatible peers should converge after syncing, but offline devices, backups, copied databases, malicious peers, or old versions may retain old copies.",
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
 * Threat model: this header is intentionally only a best-effort capability
 * advertisement. It is not signed, so an authenticated paired peer — or a
 * bootstrap worker presenting a valid grant on `/v1/status` — can claim
 * `scoped` support and cause status to enumerate the scopes that caller is
 * already authorized to see. That is metadata disclosure inside the paired-peer
 * or bootstrap-grant trust boundary, not data authorization. Every scoped data
 * path still requires signed requests and checks membership before returning
 * scope contents.
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
				const grantPresent = Boolean((c.req.header("X-Codemem-Bootstrap-Grant") ?? "").trim());
				if (bootstrapAttempted && grantPresent) {
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
				if (
					c.req.header(SYNC_AUTHORIZATION_REFRESH_HEADER) === "1" &&
					supportsSyncFeature(c.req.header(SYNC_FEATURES_HEADER), "reassign_scope")
				) {
					// Project-first provisioning grants at the coordinator immediately before
					// this status probe. Refresh now so the managed scope can participate in
					// the same initial sync pass instead of waiting for the daemon interval.
					await refreshConfiguredScopeMembershipCache(store.db, undefined, {
						keysDir: syncKeysDir(),
					});
				}
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
					sync_features: LOCAL_SYNC_FEATURES,
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
			const filtered = filterOpsForPeer(store, peerDeviceId, localDeviceId, ops, {
				supportsReassignScope: supportsSyncFeature(
					c.req.header(SYNC_FEATURES_HEADER),
					"reassign_scope",
				),
			});
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
				const grantPresent = Boolean((c.req.header("X-Codemem-Bootstrap-Grant") ?? "").trim());
				if (bootstrapAttempted && grantPresent) {
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
		const peerFeatures = normalizeSyncFeatures(body.sync_features);
		const reassignOps = normalizedOps.filter((op) => op.op_type === "reassign_scope");
		if (reassignOps.length > 0 && !peerFeatures.includes("reassign_scope")) {
			return c.json({ error: "reassign_capability_required" }, 409);
		}
		try {
			for (const op of reassignOps) parseReassignScopePayload(op);
		} catch {
			return c.json({ error: "reassign_payload_invalid" }, 400);
		}
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
			supportsReassignScope: peerFeatures.includes("reassign_scope"),
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
				cleanup_diagnostics: cleanupDiagnostics(
					store,
					(deviceRow?.device_id as string | null | undefined) ?? null,
					showDiag,
				),
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
			const recipientPolicyReconciliation = traceSync("recipientPolicyReconciliation", () =>
				listRecipientPolicyReconciliationStatus(store),
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
				legacy_shared_review: legacyReview,
				sharing_review: sharingReview,
				recipient_policy_reconciliation: recipientPolicyReconciliation,
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
			let body: Record<string, unknown>;
			try {
				body = await c.req.json<Record<string, unknown>>();
			} catch {
				return c.json({ error: "invalid json" }, 400);
			}
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

	app.get("/api/sync/recipient-policy/v1/projection", (c) => {
		const store = getStore();
		return c.json(
			listLegacyRecipientPolicyProjections(store.db, {
				localActorId: store.actorId,
				localDeviceId: store.deviceId,
			}),
		);
	});

	app.get("/api/sync/recipient-policy/v1/review", (c) => {
		const store = getStore();
		ensureLocalActorRecord(store);
		return c.json(
			listRecipientPolicyReview(store.db, {
				localActorId: store.actorId,
				localDeviceId: store.deviceId,
			}),
		);
	});

	app.get("/api/sync/recipient-policy/v1/intent", (c) => {
		const store = getStore();
		return c.json(listRecipientPolicyIntent(store.db));
	});

	app.get("/api/sync/recipient-policy/v1/reconciliation-status", (c) => {
		return c.json(listRecipientPolicyReconciliationStatus(getStore()));
	});

	app.post("/api/sync/recipient-policy/v1/edges/preview", async (c) => {
		const store = getStore();
		const body = await parseViewerJsonBody(c);
		try {
			return c.json(previewRecipientPolicyEdges(store.db, body));
		} catch (error) {
			if (error instanceof RecipientPolicyEdgeRequestError) {
				if (error.status === "not_found") {
					return c.json({ error: error.errorCode }, 404);
				}
				return c.json({ error: error.errorCode }, 400);
			}
			if (isSqliteBusy(error)) {
				c.header("Retry-After", "1");
				return c.json({ error: "edge_preview_busy" }, 503);
			}
			return c.json({ error: "edge_preview_failed" }, 500);
		}
	});

	app.post("/api/sync/recipient-policy/v1/edges/commit", async (c) => {
		const store = getStore();
		const body = await parseViewerJsonBody(c);
		try {
			const result = commitRecipientPolicyEdges(store.db, body);
			if (result.status === "invalid") return c.json(result, 400);
			if (result.status === "not_found") return c.json(result, 404);
			if (result.status === "stale" || result.status === "conflict") {
				return c.json(result, 409);
			}
			return c.json(result);
		} catch (error) {
			if (isSqliteBusy(error)) {
				c.header("Retry-After", "1");
				return c.json({ error: "edge_commit_busy" }, 503);
			}
			return c.json(
				{
					version: 1,
					status: "conflict",
					reviewedPolicyDigest: "",
					errorCode: "edge_commit_conflict",
					outcomes: [],
					writeCount: 0,
					idempotent: false,
				},
				409,
			);
		}
	});

	app.post("/api/sync/recipient-policy/v1/invites/preview", async (c) => {
		const store = getStore();
		const body = await parseViewerJsonBody(c);
		if (!body) return c.json({ error: "request_invalid" }, 400);
		const config = readCoordinatorSyncConfig();
		const status = coordinatorAdminStatusPayload(config);
		const unavailable = coordinatorAdminUnavailable(status);
		if (unavailable) return c.json(unavailable.body, unavailable.httpStatus);
		try {
			const kind = recipientInviteKind(body.kind ?? body.invite_kind);
			const targetId =
				kind === "team_member"
					? optionalViewerStrictString(body, "policy_team_id")
					: optionalViewerStrictString(body, "target_identity_id");
			if (!targetId) throw new Error("recipient_invite_metadata_invalid");
			const preview = recipientInviteOnboardingPreview(
				store,
				body,
				recipientInvitePreviewId(kind, targetId),
			);
			return c.json({ kind, preview });
		} catch (error) {
			return c.json(
				{ error: error instanceof Error ? error.message : "recipient_invite_invalid" },
				400,
			);
		}
	});

	app.post("/api/sync/recipient-policy/v1/invites", async (c) => {
		const store = getStore();
		const body = await parseViewerJsonBody(c);
		if (!body) return c.json({ error: "request_invalid" }, 400);
		const config = readCoordinatorSyncConfig();
		const status = coordinatorAdminStatusPayload(config);
		const unavailable = coordinatorAdminUnavailable(status);
		if (unavailable) return c.json(unavailable.body, unavailable.httpStatus);
		try {
			const kind = recipientInviteKind(body.kind ?? body.invite_kind);
			const targetId =
				kind === "team_member"
					? optionalViewerStrictString(body, "policy_team_id")
					: optionalViewerStrictString(body, "target_identity_id");
			if (!targetId) throw new Error("recipient_invite_metadata_invalid");
			const preview = recipientInviteOnboardingPreview(
				store,
				body,
				recipientInvitePreviewId(kind, targetId),
			);
			const reviewedDigest = optionalViewerStrictString(body, "reviewed_onboarding_digest");
			if (!reviewedDigest) throw new Error("reviewed_onboarding_digest_required");
			if (reviewedDigest !== preview.reviewedOnboardingDigest) {
				return c.json({ error: "reviewed_onboarding_stale", preview }, 409);
			}
			const groupId = resolveCoordinatorAdminGroup(optionalViewerString(body, "group_id"), status);
			const ttlHours = parseInviteTtlHours(body.ttl_hours);
			if (!groupId) throw new Error("group_id_required");
			if (ttlHours == null) throw new Error("ttl_hours_invalid");
			const result = await coordinatorCreateInviteAction({
				groupId,
				coordinatorUrl: config.syncCoordinatorUrl || null,
				policy: "auto_admit",
				ttlHours,
				createdBy: store.actorId,
				remoteUrl: config.syncCoordinatorUrl || null,
				adminSecret: config.syncCoordinatorAdminSecret || null,
				inviteKind: kind,
				policyTeamId: kind === "team_member" ? targetId : null,
				targetIdentityId: kind === "add_device" ? targetId : null,
				reviewedPreviewDigest: coordinatorPreviewDigest(preview.reviewedOnboardingDigest),
			});
			return c.json({ ok: true, kind, preview, invite: result });
		} catch (error) {
			return c.json(
				{ error: error instanceof Error ? error.message : "recipient_invite_failed" },
				400,
			);
		}
	});

	app.post("/api/sync/recipient-policy/v1/migrate", async (c) => {
		const store = getStore();
		const value = await parseViewerJsonBody(c);
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return c.json({ error: "request_invalid" }, 400);
		}
		const body = value as Record<string, unknown>;
		if (
			Object.keys(body).some((key) => key !== "dryRun") ||
			(Object.hasOwn(body, "dryRun") && typeof body.dryRun !== "boolean")
		) {
			return c.json({ error: "request_invalid" }, 400);
		}
		return c.json(
			migrateRecipientPolicyIntent(
				store.db,
				{ localActorId: store.actorId, localDeviceId: store.deviceId },
				{ dryRun: body.dryRun === true },
			),
		);
	});

	const parseReviewRequest = (value: unknown): RecipientPolicyReviewResolveRequestV1 | null => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		const body = value as Record<string, unknown>;
		const allowedKeys = new Set(["reviewItemId", "sourceFingerprint", "decision", "decisionInput"]);
		if (
			Object.keys(body).some((key) => !allowedKeys.has(key)) ||
			typeof body.reviewItemId !== "string" ||
			typeof body.sourceFingerprint !== "string" ||
			typeof body.decision !== "string"
		) {
			return null;
		}
		return {
			reviewItemId: body.reviewItemId,
			sourceFingerprint: body.sourceFingerprint,
			decision: body.decision as RecipientPolicyReviewDecisionV1,
			...(Object.hasOwn(body, "decisionInput") ? { decisionInput: body.decisionInput } : {}),
		};
	};

	app.post("/api/sync/recipient-policy/v1/review/resolve", async (c) => {
		const store = getStore();
		const body = await parseViewerJsonBody(c);
		const request = parseReviewRequest(body);
		if (!request) return c.json({ error: "request_invalid" }, 400);
		ensureLocalActorRecord(store);
		const result = resolveRecipientPolicyReview(
			store.db,
			{ localActorId: store.actorId, localDeviceId: store.deviceId },
			request,
		);
		if (result.status === "stale" || result.status === "conflict") return c.json(result, 409);
		if (result.status === "not_found") return c.json(result, 404);
		if (result.status === "invalid") return c.json(result, 400);
		return c.json(result);
	});

	app.post("/api/sync/recipient-policy/v1/review/resolve-bulk", async (c) => {
		const store = getStore();
		const body = await parseViewerJsonBody(c);
		if (
			!body ||
			!Array.isArray(body.requests) ||
			body.requests.length === 0 ||
			body.requests.length > 100
		)
			return c.json({ error: "request_invalid" }, 400);
		const requests = body.requests.map(parseReviewRequest);
		if (requests.some((request) => request == null))
			return c.json({ error: "request_invalid" }, 400);
		ensureLocalActorRecord(store);
		const result = resolveRecipientPolicyReviewBulk(
			store.db,
			{ localActorId: store.actorId, localDeviceId: store.deviceId },
			requests as RecipientPolicyReviewResolveRequestV1[],
		);
		return c.json(result, result.results.some((item) => item.status !== "applied") ? 207 : 200);
	});

	app.get("/api/sync/projects", async (c) => {
		const store = getStore();
		const limit = Math.max(1, queryInt(c.req.query("limit"), 50));
		const offset = Math.max(0, queryInt(c.req.query("offset"), 0));
		const inventory = listProjectScopeInventory(store.db, {
			identitySource: c.req.query("identity_source"),
			limit,
			offset,
			query: c.req.query("q"),
			scopeId: c.req.query("scope_id"),
			status: c.req.query("status"),
		});
		const operations = await shareOperationReadModels(store, undefined, false);
		const operationById = new Map(
			operations.map((operation) => [operation.operation_id, operation]),
		);
		const sharingByProject = new Map<string, Array<Record<string, unknown>>>();
		const reviewed = store.db
			.prepare(`SELECT p.operation_id, p.canonical_project_identity
			 FROM share_operation_projects p
			 JOIN share_operations o ON o.operation_id = p.operation_id
			 WHERE o.inviter_actor_id = ? ORDER BY o.created_at, p.ordinal`)
			.all(store.actorId) as Array<{ operation_id: string; canonical_project_identity: string }>;
		for (const item of reviewed) {
			const operation = operationById.get(item.operation_id);
			if (!operation) continue;
			const current = sharingByProject.get(item.canonical_project_identity) ?? [];
			current.push({
				person: operation.person,
				lifecycle: {
					state: operation.lifecycle.state,
					label: operation.lifecycle.label,
					explanation: operation.lifecycle.explanation,
				},
			});
			sharingByProject.set(item.canonical_project_identity, current);
		}
		return c.json({
			...inventory,
			projects: inventory.projects.map((project) => ({
				...project,
				sharing: sharingByProject.get(project.workspace_identity) ?? [],
			})),
		});
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

	app.post("/api/sync/project-invites/preview", async (c) => {
		const store = getStore();
		const body = await parseViewerJsonBody(c);
		if (!body) return c.json({ error: "invalid_json" }, 400);
		try {
			assertProjectInviteBody(body, false);
			const createdAt = new Date().toISOString();
			const inviteExpiresAt = new Date(
				new Date(createdAt).getTime() + PROJECT_INVITE_TTL_HOURS * 3600 * 1000,
			).toISOString();
			const { plan } = projectInvitePlan(store, body, createdAt, inviteExpiresAt);
			return c.json(projectInvitePreview(plan));
		} catch (error) {
			return c.json(
				{ error: error instanceof Error ? error.message : "project_invite_invalid" },
				400,
			);
		}
	});

	app.post("/api/sync/project-invites", async (c) => {
		const store = getStore();
		const body = await parseViewerJsonBody(c);
		if (!body) return c.json({ error: "invalid_json" }, 400);
		try {
			assertProjectInviteBody(body, true);
			const createdAt = new Date().toISOString();
			const inviteExpiresAt = new Date(
				new Date(createdAt).getTime() + PROJECT_INVITE_TTL_HOURS * 3600 * 1000,
			).toISOString();
			const { plan, config } = projectInvitePlan(store, body, createdAt, inviteExpiresAt);
			if (String(body.reviewed_project_set_digest).trim() !== plan.reviewedProjectSetDigest) {
				return c.json({ error: "reviewed_project_set_changed" }, 409);
			}
			const existingState = (() => {
				try {
					return store.db
						.prepare("SELECT state FROM share_operations WHERE operation_id = ?")
						.pluck()
						.get(plan.operationId) as string | undefined;
				} catch {
					// Local persistence below remains authoritative. Keeping this precheck
					// best-effort preserves coordinator idempotency if local storage is unavailable.
					return undefined;
				}
			})();
			if (existingState && existingState !== "waiting_for_acceptance") {
				return c.json({ error: "operation_state_invalid" }, 409);
			}
			// The coordinator invite is minted before local persistence. If the local
			// transaction fails, operationId makes coordinator creation return the
			// current invite. Expired or revoked waiting invites are renewed in place.
			const result = await coordinatorCreateInviteAction({
				groupId: plan.coordinatorGroupId,
				coordinatorUrl: config.syncCoordinatorUrl || null,
				policy: "auto_admit",
				ttlHours: PROJECT_INVITE_TTL_HOURS,
				createdBy: store.actorId,
				remoteUrl: config.syncCoordinatorUrl || null,
				adminSecret: config.syncCoordinatorAdminSecret || null,
				operationId: plan.operationId,
				reviewedProjectSetDigest: plan.reviewedProjectSetDigest,
				inviterActorId: plan.inviterActorId,
				inviterDisplayName: store.actorDisplayName,
				inviterDeviceId: plan.inviterDeviceIds[0],
				pendingPersonId: plan.personId,
				projectSummaries: plan.projects.map((project) => ({
					display_name: project.displayName,
					existing_memory_count: project.existingMemoryCount,
				})),
				projectIntent: plan.projects.map((project) => ({
					canonical_identity: project.canonicalIdentity,
					display_name: project.displayName,
					existing_memory_count: project.existingMemoryCount,
				})),
			});
			if (
				String(result.operation_id ?? "").trim() !== plan.operationId ||
				String(result.reviewed_project_set_digest ?? "").trim() !== plan.reviewedProjectSetDigest
			) {
				throw new Error("coordinator_invite_intent_mismatch");
			}
			const payload = result.payload;
			if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
				throw new Error("coordinator_invite_payload_missing");
			}
			const token = String((payload as Record<string, unknown>).token ?? "").trim();
			const expiresAt = String((payload as Record<string, unknown>).expires_at ?? "").trim();
			const link = String(result.link ?? "").trim();
			const encoded = String(result.encoded ?? "").trim();
			if (!token || !expiresAt || !link || !encoded) {
				throw new Error("coordinator_invite_payload_invalid");
			}
			const persistedPlan = { ...plan, inviteExpiresAt: new Date(expiresAt).toISOString() };
			persistShareOperation(store.db, persistedPlan, {
				inviteId: String(result.invite_id ?? "").trim() || null,
				tokenDigest: inviteTokenDigest(token),
			});
			return c.json({
				ok: true,
				...projectInvitePreview(persistedPlan),
				invite: {
					link,
					encoded,
					expires_at: persistedPlan.inviteExpiresAt,
				},
			});
		} catch (error) {
			return c.json(
				{ error: error instanceof Error ? error.message : "project_invite_failed" },
				400,
			);
		}
	});

	app.get("/api/sync/project-invites/:operationId", async (c) => {
		const operationId = String(c.req.param("operationId") ?? "").trim();
		if (!/^share_[a-f0-9]{40}$/u.test(operationId)) {
			return c.json({ error: "operation_id_invalid" }, 400);
		}
		try {
			const { payload } = await coordinatorProjectInvitePayload(operationId);
			return c.json(
				payload.state === "accepted" ? { ...payload, state: "pending_setup" } : payload,
			);
		} catch (error) {
			const mapped = projectInviteOwnerErrorResponse(error, {
				code: "operation_read_failed",
				status: 400,
			});
			return c.json({ error: mapped.code }, mapped.status);
		}
	});

	app.post("/api/sync/project-invites/:operationId/reconcile", async (c) => {
		const store = getStore();
		const operationId = String(c.req.param("operationId") ?? "").trim();
		if (!/^share_[a-f0-9]{40}$/u.test(operationId)) {
			return c.json({ error: "operation_id_invalid" }, 400);
		}
		try {
			const result = await reconcileProjectInviteAcceptance(store, operationId);
			return c.json({
				ok: true,
				operation_id: operationId,
				reconciled: result.accepted,
				state: result.accepted ? "pending_setup" : "waiting_for_acceptance",
			});
		} catch (error) {
			const mapped = projectInviteOwnerErrorResponse(error, {
				code: "operation_reconcile_failed",
				status: 409,
			});
			return c.json({ error: mapped.code }, mapped.status);
		}
	});

	app.get("/api/sync/share-operations", async (c) => {
		const store = getStore();
		const items = await shareOperationReadModels(store, undefined, false);
		return c.json({ items });
	});

	app.get("/api/sync/share-operations/:operationId", async (c) => {
		const store = getStore();
		const operationId = String(c.req.param("operationId") ?? "").trim();
		if (!/^share_[a-f0-9]{40}$/u.test(operationId)) {
			return c.json({ error: "operation_id_invalid" }, 400);
		}
		const [item] = await shareOperationReadModels(store, operationId);
		return item ? c.json(item) : c.json({ error: "operation_not_found" }, 404);
	});

	const advanceProjectShare = async (c: Context) => {
		const store = getStore();
		const operationId = String(c.req.param("operationId") ?? "").trim();
		if (!/^share_[a-f0-9]{40}$/u.test(operationId)) {
			return c.json({ error: "operation_id_invalid" }, 400);
		}
		try {
			const advanced = await advanceProjectShareOperation(store, operationId);
			if (!advanced.advanced) {
				return c.json({ error: "invitation_not_accepted" }, 409);
			}
			const [operation] = await shareOperationReadModels(store, operationId);
			return c.json({ ok: true, operation });
		} catch (error) {
			const code = error instanceof Error ? error.message : "provisioning_failed";
			return c.json({ error: code }, code === "operation_not_found" ? 404 : 409);
		}
	};

	app.post("/api/sync/share-operations/:operationId/advance", advanceProjectShare);

	app.post("/api/sync/project-invites/:operationId/provision", async (c) => {
		const store = getStore();
		const operationId = String(c.req.param("operationId") ?? "").trim();
		if (!/^share_[a-f0-9]{40}$/u.test(operationId)) {
			return c.json({ error: "operation_id_invalid" }, 400);
		}
		try {
			const plan = await executeProjectShareProvisioning(store, operationId);
			return c.json({ ok: true, operation_id: operationId, state: "active", plan });
		} catch (error) {
			const code = error instanceof Error ? error.message : "provisioning_failed";
			return c.json({ error: code }, code === "operation_not_found" ? 404 : 409);
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
			const [deviceId] = ensureDeviceIdentity(store.db, { keysDir: syncKeysDir() });
			const mapping = upsertProjectScopeSettingsMapping(store.db, {
				deviceId,
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
			const [deviceId] = ensureDeviceIdentity(store.db, { keysDir: syncKeysDir() });
			const saveMappings = store.db.transaction(() =>
				mappingInputs.map((mappingInput) =>
					upsertProjectScopeSettingsMapping(store.db, { deviceId, ...mappingInput }),
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

	app.post("/api/sync/invites/inspect", async (c) => {
		const store = getStore();
		const body = await parseViewerJsonBody(c);
		if (!body || typeof body.invite !== "string") return c.json({ error: "invite_invalid" }, 400);
		try {
			const payload = decodeInvitePayload(extractInvitePayload(body.invite));
			ensureStableStoreIdentity(store);
			const recipientInvite = payload.kind === "team_member" || payload.kind === "add_device";
			if (!payload.operation_id && !recipientInvite) return c.json({ kind: "legacy_team_invite" });
			const [status, inspected] = await requestJson(
				"POST",
				`${buildBaseUrl(payload.coordinator_url)}/v1/invites/inspect`,
				{ body: { token: payload.token }, timeoutS: 10 },
			);
			if (status < 200 || status >= 300) {
				return c.json(
					{ error: String(inspected?.error ?? "invite_invalid") },
					status === 410 ? 410 : 400,
				);
			}
			const config = readCodememConfigFile();
			const identityId =
				payload.kind === "add_device"
					? String(inspected?.target_identity_id ?? "").trim()
					: store.actorId;
			const expectedTarget =
				payload.kind === "team_member"
					? String(inspected?.policy_team_id ?? "").trim()
					: String(inspected?.target_identity_id ?? "").trim();
			if (recipientInvite) {
				if (
					String(inspected?.kind ?? "").trim() !== payload.kind ||
					!expectedTarget ||
					String(inspected?.reviewed_preview_digest ?? "").trim() !==
						String(payload.reviewed_preview_digest ?? "").trim() ||
					(payload.kind === "team_member" && expectedTarget !== payload.policy_team_id) ||
					(payload.kind === "add_device" && expectedTarget !== payload.target_identity_id)
				) {
					return c.json({ error: "recipient_invite_intent_mismatch" }, 409);
				}
				const preview = recipientInviteOnboardingPreview(
					store,
					{
						kind: payload.kind,
						policy_team_id: payload.kind === "team_member" ? expectedTarget : null,
						target_identity_id: payload.kind === "add_device" ? identityId : null,
						device_name: optionalViewerString(body, "device_name"),
					},
					String(payload.token),
				);
				return c.json({
					...inspected,
					recipient_name: store.actorDisplayName,
					device_name: preview.binding.deviceDisplayName,
					onboarding: preview,
				});
			}
			return c.json({
				...inspected,
				recipient_name: store.actorDisplayName,
				device_name: friendlyDeviceName({
					explicitName: String(config.sync_device_name ?? ""),
					osName: hostname(),
					fallbackSeed: store.deviceId,
				}),
			});
		} catch {
			return c.json({ error: "invite_invalid" }, 400);
		}
	});

	// POST /api/sync/invites/import accepts both team invites (coordinator
	// invite envelope or codemem:// link) and device-pairing payloads
	// (base64 JSON with { device_id, fingerprint, public_key, addresses }).
	// The server discriminates by decoding the pasted text — UI callers get
	// one textarea for all flows. Response type distinguishes legacy Team joins,
	// exact-Project pending setup, recipient onboarding, and direct pairing.
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

		let projectInvite = false;
		try {
			const decoded = decodeInvitePayload(extractInvitePayload(rawValue));
			projectInvite = Boolean(decoded.operation_id);
			ensureStableStoreIdentity(store);
			const recipientInvite = decoded.kind === "team_member" || decoded.kind === "add_device";
			const reviewedOnboardingDigest =
				typeof body.reviewed_onboarding_digest === "string"
					? body.reviewed_onboarding_digest.trim()
					: "";
			if (recipientInvite && !reviewedOnboardingDigest) {
				return c.json({ error: "reviewed_onboarding_digest_required" }, 400);
			}
			const result = await coordinatorImportInviteAction({
				inviteValue: rawValue,
				dbPath: store.dbPath,
				recipientActorId: store.actorId,
				recipientDisplayName:
					typeof body.recipient_name === "string" ? body.recipient_name : store.actorDisplayName,
				deviceDisplayName: typeof body.device_name === "string" ? body.device_name : null,
				reviewedOnboardingDigest: reviewedOnboardingDigest || null,
			});
			const type = recipientInvite
				? "recipient_onboarding"
				: projectInvite
					? "project_share"
					: "team_join";
			if (projectInvite && getSyncRuntimeStatus?.()?.phase === "disabled") {
				return c.json(
					{
						...result,
						type,
						setup_state: "restart_required",
						restart_required: true,
						detail:
							"The invitation was accepted and sync was enabled. Restart codemem to start the sync service; Project setup remains pending until the first sync finishes.",
					},
					200,
				);
			}
			return c.json({
				...result,
				type,
			});
		} catch (error) {
			if (projectInvite) return c.json(projectInviteAcceptanceFailure(error), 400);
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
		const role = optionalViewerString(body, "role");
		const coordinatorId = optionalViewerString(body, "coordinator_id");
		const manifestIssuerDeviceId = optionalViewerString(body, "manifest_issuer_device_id");
		const manifestHash = optionalViewerString(body, "manifest_hash");
		const signedManifestJson = optionalViewerString(body, "signed_manifest_json");
		const effectId =
			optionalViewerString(body, "effect_id") ??
			coordinatorAdminMembershipEffectId("grant", randomUUID(), {
				groupId,
				scopeId,
				deviceId,
				role,
				membershipEpoch,
				coordinatorId,
				manifestIssuerDeviceId,
				manifestHash,
				signedManifestJson,
			});
		try {
			const membership = await coordinatorGrantScopeMembershipAction({
				effectId,
				groupId,
				scopeId,
				deviceId,
				role,
				membershipEpoch,
				coordinatorId,
				manifestIssuerDeviceId,
				manifestHash,
				signedManifestJson,
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
			const manifestHash = optionalViewerString(body, "manifest_hash");
			const signedManifestJson = optionalViewerString(body, "signed_manifest_json");
			const effectId =
				optionalViewerString(body, "effect_id") ??
				coordinatorAdminMembershipEffectId("revoke", randomUUID(), {
					groupId,
					scopeId,
					deviceId,
					membershipEpoch,
					manifestHash,
					signedManifestJson,
				});
			try {
				const ok = await coordinatorRevokeScopeMembershipAction({
					effectId,
					groupId,
					scopeId,
					deviceId,
					membershipEpoch,
					manifestHash,
					signedManifestJson,
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
					requestId,
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
