import { hostname } from "node:os";
import {
	BetterSqliteCoordinatorStore,
	DEFAULT_COORDINATOR_DB_PATH,
} from "./better-sqlite-coordinator-store.js";
import {
	decodeInvitePayload,
	encodeInvitePayload,
	extractInvitePayload,
	type InvitePayload,
	inviteLink,
} from "./coordinator-invites.js";
import {
	CoordinatorMembershipError,
	normalizeMembershipEffectId,
} from "./coordinator-membership-effects.js";
import type {
	CoordinatorBootstrapGrant,
	CoordinatorEnrollment,
	CoordinatorGrantScopeMembershipInput,
	CoordinatorGroup,
	CoordinatorInvite,
	CoordinatorJoinRequest,
	CoordinatorJoinRequestReviewResult,
	CoordinatorRecipientInviteKind,
	CoordinatorRevokeScopeMembershipInput,
	CoordinatorScope,
	CoordinatorScopeMembership,
} from "./coordinator-store-contract.js";
import {
	isCoordinatorAssignedIdentityId,
	recipientInviteAuthoritativeIdentityId,
} from "./coordinator-store-contract.js";
import { connect, resolveDbPath } from "./db.js";
import { initDatabase } from "./maintenance.js";
import {
	readCodememConfigFile,
	readCodememConfigFileAtPath,
	writeCodememConfigFile,
} from "./observer-config.js";
import {
	PROJECT_INVITE_PENDING_STATUS,
	ProjectSyncEnablementError,
} from "./project-invite-acceptance.js";
import { friendlyDeviceName, normalizeIdentityDisplayName } from "./project-invite-identity.js";
import {
	assertAddDeviceIdentityAdoptionAllowed,
	commitRecipientPolicyOnboardingFromReviewedIntent,
	previewRecipientPolicyOnboardingFromReviewedIntent,
	type RecipientPolicyReviewedIntentPreviewRequestV1,
} from "./recipient-policy-onboarding.js";
import {
	parseStoredRecipientReviewedIntent,
	RecipientReviewedIntentError,
	type RecipientReviewedIntentV1,
	verifyRecipientReviewedIntent,
} from "./recipient-reviewed-intent.js";
import {
	type AcceptedProjectIntent,
	acceptedProjectIntentDigest,
	managedProjectScopeId,
	parseAcceptedProjectIntent,
} from "./share-operation.js";
import { buildAuthHeaders } from "./sync-auth.js";
import { updatePeerAddresses } from "./sync-discovery.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { buildBaseUrl, requestJson } from "./sync-http-client.js";
import { ensureDeviceIdentity, loadPublicKey } from "./sync-identity.js";

const VALID_INVITE_POLICIES = new Set(["auto_admit", "approval_required"]);
const INVITE_IMPORT_TIMEOUT_S = 10;
const PROJECT_INVITE_SYNC_DEFAULTS = {
	host: "0.0.0.0",
	intervalS: 120,
	port: 7337,
} as const;

function stripTrailingSlashes(value: string): string {
	let end = value.length;
	while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
	return end === value.length ? value : value.slice(0, end);
}

function enableInviteSync(config: Record<string, unknown>): Record<string, unknown> {
	const port = Number(config.sync_port);
	const intervalS = Number(config.sync_interval_s);
	return {
		...config,
		sync_enabled: true,
		sync_host: String(config.sync_host ?? "").trim() || PROJECT_INVITE_SYNC_DEFAULTS.host,
		sync_port:
			Number.isSafeInteger(port) && port > 0 && port <= 65_535
				? port
				: PROJECT_INVITE_SYNC_DEFAULTS.port,
		sync_interval_s:
			Number.isSafeInteger(intervalS) && intervalS > 0
				? intervalS
				: PROJECT_INVITE_SYNC_DEFAULTS.intervalS,
	};
}

function coordinatorRemoteTarget(config = readCodememConfigFile()): {
	remoteUrl: string | null;
	adminSecret: string | null;
} {
	const remoteUrl = String(config.sync_coordinator_url ?? "").trim() || null;
	const adminSecret =
		String(
			process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET ??
				config.sync_coordinator_admin_secret ??
				"",
		).trim() || null;
	return { remoteUrl, adminSecret };
}

async function remoteRequest(
	method: string,
	url: string,
	adminSecret: string,
	body?: Record<string, unknown>,
	actorId?: string | null,
): Promise<Record<string, unknown> | null> {
	const headers: Record<string, string> = { "X-Codemem-Coordinator-Admin": adminSecret };
	const normalizedActorId = String(actorId ?? "").trim();
	if (normalizedActorId) headers["X-Codemem-Coordinator-Admin-Actor"] = normalizedActorId;
	const [status, payload] = await requestJson(method, url, {
		headers,
		body,
		timeoutS: 3,
	});
	if (status < 200 || status >= 300) {
		const detail = typeof payload?.error === "string" ? payload.error : "unknown";
		throw new Error(`Remote coordinator request failed (${status}): ${detail}`);
	}
	return payload;
}

function inviteUrlWarnings(rawUrl: string | null | undefined): string[] {
	const value = String(rawUrl ?? "").trim();
	if (!value) return [];
	let hostname = "";
	try {
		hostname = new URL(buildBaseUrl(value)).hostname.trim().toLowerCase();
	} catch {
		return [
			"Coordinator URL could not be parsed. Double-check that teammates can reach it before sharing this invite.",
		];
	}
	hostname = hostname.replace(/^\[/, "").replace(/\]$/, "");
	if (!hostname) return [];
	if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
		return [
			"Invite uses a localhost coordinator URL. It will only work on the same machine unless you replace it with a reachable hostname or IP.",
		];
	}
	if (hostname.endsWith(".local")) {
		return [
			"Invite uses a local-network coordinator hostname. Teammates outside that network may not be able to join.",
		];
	}
	if (hostname.includes(":")) {
		const normalized = hostname.toLowerCase();
		if (normalized === "::1") {
			return [
				"Invite uses a localhost coordinator URL. It will only work on the same machine unless you replace it with a reachable hostname or IP.",
			];
		}
		if (normalized.startsWith("fd7a:115c:a1e0:")) {
			return [
				"Invite uses a ULA/Tailnet-style coordinator IPv6 address. This can be correct for private-network teams, but other teammates may not be able to join unless they share that network.",
			];
		}
		if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
			return [
				"Invite uses a private-network coordinator IPv6 address. This is fine for LAN-only or VPN-only teams, but teammates outside that network may not be able to join.",
			];
		}
		if (
			normalized.startsWith("fe8") ||
			normalized.startsWith("fe9") ||
			normalized.startsWith("fea") ||
			normalized.startsWith("feb")
		) {
			return [
				"Invite uses a link-local coordinator IPv6 address. It usually only works on the same local network segment.",
			];
		}
	}
	const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!ipv4Match) return [];
	const octets = ipv4Match.slice(1).map((part) => Number.parseInt(part, 10));
	if (octets.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) {
		return [
			"Invite uses an unusual coordinator IP address. Double-check that teammates can reach it before sharing this invite.",
		];
	}
	const a = octets[0] ?? -1;
	const b = octets[1] ?? -1;
	const isPrivate =
		a === 10 ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		a === 127 ||
		(a === 169 && b === 254);
	if (isPrivate) {
		return [
			"Invite uses a private-network coordinator IP address. This is fine for LAN-only teams, but teammates outside that network may not be able to join.",
		];
	}
	if (a === 100 && b >= 64 && b <= 127) {
		return [
			"Invite uses a CGNAT/Tailscale-style coordinator IP address. This can be correct for Tailnet-only teams, but other teammates may not be able to join unless they share that network.",
		];
	}
	return [];
}

async function requireLocalActiveGroup(
	store: BetterSqliteCoordinatorStore,
	groupId: string,
): Promise<void> {
	const group = await store.getGroup(groupId);
	if (!group) throw new Error(`Group not found: ${groupId}`);
	if (group.archived_at) throw new Error(`Group is archived: ${groupId}`);
}

async function localScopeForGroup(
	store: BetterSqliteCoordinatorStore,
	groupId: string,
	scopeId: string,
): Promise<CoordinatorScope | null> {
	await requireLocalActiveGroup(store, groupId);
	return (
		(await store.listScopes({ groupId, includeInactive: true })).find(
			(scope) => scope.scope_id === scopeId,
		) ?? null
	);
}

function inviteImportTransportError(error: unknown, coordinatorUrl: string): Error {
	const name = typeof error === "object" && error && "name" in error ? String(error.name) : "";
	const message = error instanceof Error ? error.message : String(error ?? "");
	const base = buildBaseUrl(coordinatorUrl);
	if (name === "TimeoutError" || /timed? out/i.test(message)) {
		return new Error(
			`Invite import timed out contacting the coordinator at ${base}. Check that this machine can reach that URL and try again.`,
		);
	}
	if (name === "TypeError" || /fetch failed|network/i.test(message)) {
		return new Error(
			`Invite import could not reach the coordinator at ${base}. Check the invite URL and this machine's network access before retrying.`,
		);
	}
	return error instanceof Error ? error : new Error(message);
}

export async function coordinatorCreateGroupAction(opts: {
	groupId: string;
	displayName?: string | null;
	dbPath?: string | null;
	remoteUrl?: string | null;
	adminSecret?: string | null;
}): Promise<CoordinatorGroup> {
	const groupId = String(opts.groupId ?? "").trim();
	if (!groupId) throw new Error("Group id required.");
	const remote = opts.remoteUrl ?? null;
	const adminSecret = opts.adminSecret ?? null;
	if (remote) {
		if (!adminSecret) throw new Error("Admin secret required.");
		const payload = await remoteRequest(
			"POST",
			`${stripTrailingSlashes(remote)}/v1/admin/groups`,
			adminSecret,
			{ group_id: groupId, display_name: opts.displayName ?? null },
		);
		const group = payload?.group;
		if (!group || typeof group !== "object")
			throw new Error("Remote coordinator did not return group payload.");
		return group as CoordinatorGroup;
	}
	const store = new BetterSqliteCoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		await store.createGroup(groupId, opts.displayName ?? null);
		const group = await store.getGroup(groupId);
		if (!group) throw new Error(`Failed to create group: ${groupId}`);
		return group;
	} finally {
		await store.close();
	}
}

export async function coordinatorRenameGroupAction(opts: {
	groupId: string;
	displayName: string;
	dbPath?: string | null;
	remoteUrl?: string | null;
	adminSecret?: string | null;
}): Promise<CoordinatorGroup | null> {
	const groupId = String(opts.groupId ?? "").trim();
	const displayName = String(opts.displayName ?? "").trim();
	if (!groupId || !displayName) throw new Error("group_id and display_name are required.");
	const remote = opts.remoteUrl ?? null;
	const adminSecret = opts.adminSecret ?? null;
	if (remote) {
		if (!adminSecret) throw new Error("Admin secret required.");
		let payload: Record<string, unknown> | null;
		try {
			payload = await remoteRequest(
				"POST",
				`${stripTrailingSlashes(remote)}/v1/admin/groups/rename`,
				adminSecret,
				{ group_id: groupId, display_name: displayName },
			);
		} catch (error) {
			if (error instanceof Error && error.message.includes("group_not_found")) return null;
			throw error;
		}
		const group = payload?.group;
		return group && typeof group === "object" ? (group as CoordinatorGroup) : null;
	}
	const store = new BetterSqliteCoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		const ok = await store.renameGroup(groupId, displayName);
		if (!ok) return null;
		return await store.getGroup(groupId);
	} finally {
		await store.close();
	}
}

export async function coordinatorArchiveGroupAction(opts: {
	groupId: string;
	dbPath?: string | null;
	remoteUrl?: string | null;
	adminSecret?: string | null;
}): Promise<CoordinatorGroup | null> {
	const groupId = String(opts.groupId ?? "").trim();
	if (!groupId) throw new Error("Group id required.");
	const remote = opts.remoteUrl ?? null;
	const adminSecret = opts.adminSecret ?? null;
	if (remote) {
		if (!adminSecret) throw new Error("Admin secret required.");
		let payload: Record<string, unknown> | null;
		try {
			payload = await remoteRequest(
				"POST",
				`${stripTrailingSlashes(remote)}/v1/admin/groups/archive`,
				adminSecret,
				{ group_id: groupId },
			);
		} catch (error) {
			if (error instanceof Error && error.message.includes("group_not_found_or_already_archived"))
				return null;
			throw error;
		}
		const group = payload?.group;
		return group && typeof group === "object" ? (group as CoordinatorGroup) : null;
	}
	const store = new BetterSqliteCoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		const ok = await store.archiveGroup(groupId);
		if (!ok) return null;
		return await store.getGroup(groupId);
	} finally {
		await store.close();
	}
}

export async function coordinatorUnarchiveGroupAction(opts: {
	groupId: string;
	dbPath?: string | null;
	remoteUrl?: string | null;
	adminSecret?: string | null;
}): Promise<CoordinatorGroup | null> {
	const groupId = String(opts.groupId ?? "").trim();
	if (!groupId) throw new Error("Group id required.");
	const remote = opts.remoteUrl ?? null;
	const adminSecret = opts.adminSecret ?? null;
	if (remote) {
		if (!adminSecret) throw new Error("Admin secret required.");
		let payload: Record<string, unknown> | null;
		try {
			payload = await remoteRequest(
				"POST",
				`${stripTrailingSlashes(remote)}/v1/admin/groups/unarchive`,
				adminSecret,
				{ group_id: groupId },
			);
		} catch (error) {
			if (error instanceof Error && error.message.includes("group_not_found_or_not_archived"))
				return null;
			throw error;
		}
		const group = payload?.group;
		return group && typeof group === "object" ? (group as CoordinatorGroup) : null;
	}
	const store = new BetterSqliteCoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		const ok = await store.unarchiveGroup(groupId);
		if (!ok) return null;
		return await store.getGroup(groupId);
	} finally {
		await store.close();
	}
}

export async function coordinatorListGroupsAction(opts?: {
	dbPath?: string | null;
	remoteUrl?: string | null;
	adminSecret?: string | null;
	includeArchived?: boolean;
}): Promise<CoordinatorGroup[]> {
	const remote = opts?.remoteUrl ?? null;
	const adminSecret = opts?.adminSecret ?? null;
	const includeArchived = opts?.includeArchived === true;
	if (remote) {
		if (!adminSecret) throw new Error("Admin secret required.");
		const payload = await remoteRequest(
			"GET",
			`${stripTrailingSlashes(remote)}/v1/admin/groups${includeArchived ? "?include_archived=1" : ""}`,
			adminSecret,
		);
		return Array.isArray(payload?.items)
			? payload.items.filter(
					(row): row is CoordinatorGroup => Boolean(row) && typeof row === "object",
				)
			: [];
	}
	const store = new BetterSqliteCoordinatorStore(opts?.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		return await store.listGroups(includeArchived);
	} finally {
		await store.close();
	}
}

export async function coordinatorListScopesAction(opts: {
	groupId: string;
	includeInactive?: boolean;
	dbPath?: string | null;
	remoteUrl?: string | null;
	adminSecret?: string | null;
}): Promise<CoordinatorScope[]> {
	const groupId = String(opts.groupId ?? "").trim();
	if (!groupId) throw new Error("Group id required.");
	const target = coordinatorRemoteTarget();
	const remote = opts.remoteUrl ?? (opts.dbPath ? null : target.remoteUrl);
	const adminSecret = opts.adminSecret ?? target.adminSecret;
	if (remote) {
		if (!adminSecret) throw new Error("Admin secret required.");
		const payload = await remoteRequest(
			"GET",
			`${stripTrailingSlashes(remote)}/v1/admin/groups/${encodeURIComponent(groupId)}/scopes${opts.includeInactive ? "?include_inactive=1" : ""}`,
			adminSecret,
		);
		return Array.isArray(payload?.items)
			? payload.items.filter(
					(row): row is CoordinatorScope => Boolean(row) && typeof row === "object",
				)
			: [];
	}
	const store = new BetterSqliteCoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		await requireLocalActiveGroup(store, groupId);
		return await store.listScopes({ groupId, includeInactive: opts.includeInactive === true });
	} finally {
		await store.close();
	}
}

export async function coordinatorCreateScopeAction(opts: {
	groupId: string;
	scopeId: string;
	label: string;
	kind?: string | null;
	authorityType?: string | null;
	coordinatorId?: string | null;
	manifestIssuerDeviceId?: string | null;
	membershipEpoch?: number | null;
	manifestHash?: string | null;
	status?: string | null;
	dbPath?: string | null;
	remoteUrl?: string | null;
	adminSecret?: string | null;
}): Promise<CoordinatorScope> {
	const groupId = String(opts.groupId ?? "").trim();
	const scopeId = String(opts.scopeId ?? "").trim();
	const label = String(opts.label ?? "").trim();
	if (!groupId || !scopeId || !label)
		throw new Error("group_id, scope_id, and label are required.");
	const target = coordinatorRemoteTarget();
	const remote = opts.remoteUrl ?? (opts.dbPath ? null : target.remoteUrl);
	const adminSecret = opts.adminSecret ?? target.adminSecret;
	if (remote) {
		if (!adminSecret) throw new Error("Admin secret required.");
		const payload = await remoteRequest(
			"POST",
			`${stripTrailingSlashes(remote)}/v1/admin/groups/${encodeURIComponent(groupId)}/scopes`,
			adminSecret,
			{
				scope_id: scopeId,
				label,
				kind: opts.kind ?? null,
				authority_type: opts.authorityType ?? null,
				coordinator_id: opts.coordinatorId ?? null,
				manifest_issuer_device_id: opts.manifestIssuerDeviceId ?? null,
				membership_epoch: opts.membershipEpoch ?? null,
				manifest_hash: opts.manifestHash ?? null,
				status: opts.status ?? null,
			},
		);
		const scope = payload?.scope;
		if (!scope || typeof scope !== "object") {
			throw new Error("Remote coordinator did not return scope payload.");
		}
		return scope as CoordinatorScope;
	}
	const store = new BetterSqliteCoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		await requireLocalActiveGroup(store, groupId);
		return await store.createScope({
			scopeId,
			label,
			kind: opts.kind ?? null,
			authorityType: opts.authorityType ?? null,
			coordinatorId: opts.coordinatorId ?? null,
			groupId,
			manifestIssuerDeviceId: opts.manifestIssuerDeviceId ?? null,
			membershipEpoch: opts.membershipEpoch ?? null,
			manifestHash: opts.manifestHash ?? null,
			status: opts.status ?? null,
		});
	} finally {
		await store.close();
	}
}

export async function coordinatorUpdateScopeAction(opts: {
	groupId: string;
	scopeId: string;
	label?: string | null;
	kind?: string | null;
	authorityType?: string | null;
	coordinatorId?: string | null;
	manifestIssuerDeviceId?: string | null;
	membershipEpoch?: number | null;
	manifestHash?: string | null;
	status?: string | null;
	dbPath?: string | null;
	remoteUrl?: string | null;
	adminSecret?: string | null;
}): Promise<CoordinatorScope | null> {
	const groupId = String(opts.groupId ?? "").trim();
	const scopeId = String(opts.scopeId ?? "").trim();
	if (!groupId || !scopeId) throw new Error("group_id and scope_id are required.");
	const target = coordinatorRemoteTarget();
	const remote = opts.remoteUrl ?? (opts.dbPath ? null : target.remoteUrl);
	const adminSecret = opts.adminSecret ?? target.adminSecret;
	if (remote) {
		if (!adminSecret) throw new Error("Admin secret required.");
		let payload: Record<string, unknown> | null;
		try {
			payload = await remoteRequest(
				"PATCH",
				`${stripTrailingSlashes(remote)}/v1/admin/groups/${encodeURIComponent(groupId)}/scopes/${encodeURIComponent(scopeId)}`,
				adminSecret,
				{
					label: opts.label ?? undefined,
					kind: opts.kind ?? undefined,
					authority_type: opts.authorityType ?? undefined,
					coordinator_id: opts.coordinatorId ?? undefined,
					manifest_issuer_device_id: opts.manifestIssuerDeviceId ?? undefined,
					membership_epoch: opts.membershipEpoch ?? undefined,
					manifest_hash: opts.manifestHash ?? undefined,
					status: opts.status ?? undefined,
				},
			);
		} catch (error) {
			if (error instanceof Error && error.message.includes("scope_not_found")) return null;
			throw error;
		}
		const scope = payload?.scope;
		return scope && typeof scope === "object" ? (scope as CoordinatorScope) : null;
	}
	const store = new BetterSqliteCoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		const existing = await localScopeForGroup(store, groupId, scopeId);
		if (!existing) return null;
		return await store.updateScope({
			scopeId,
			label: opts.label,
			kind: opts.kind,
			authorityType: opts.authorityType,
			coordinatorId: opts.coordinatorId,
			groupId,
			manifestIssuerDeviceId: opts.manifestIssuerDeviceId,
			membershipEpoch: opts.membershipEpoch,
			manifestHash: opts.manifestHash,
			status: opts.status,
		});
	} finally {
		await store.close();
	}
}

export async function coordinatorListScopeMembershipsAction(opts: {
	groupId: string;
	scopeId: string;
	includeRevoked?: boolean;
	dbPath?: string | null;
	remoteUrl?: string | null;
	adminSecret?: string | null;
}): Promise<CoordinatorScopeMembership[]> {
	const groupId = String(opts.groupId ?? "").trim();
	const scopeId = String(opts.scopeId ?? "").trim();
	if (!groupId || !scopeId) throw new Error("group_id and scope_id are required.");
	const target = coordinatorRemoteTarget();
	const remote = opts.remoteUrl ?? (opts.dbPath ? null : target.remoteUrl);
	const adminSecret = opts.adminSecret ?? target.adminSecret;
	if (remote) {
		if (!adminSecret) throw new Error("Admin secret required.");
		const payload = await remoteRequest(
			"GET",
			`${stripTrailingSlashes(remote)}/v1/admin/groups/${encodeURIComponent(groupId)}/scopes/${encodeURIComponent(scopeId)}/members${opts.includeRevoked ? "?include_revoked=1" : ""}`,
			adminSecret,
		);
		return Array.isArray(payload?.items)
			? payload.items.filter(
					(row): row is CoordinatorScopeMembership => Boolean(row) && typeof row === "object",
				)
			: [];
	}
	const store = new BetterSqliteCoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		if (!(await localScopeForGroup(store, groupId, scopeId))) {
			throw new Error(`Scope not found: ${scopeId}`);
		}
		return await store.listScopeMemberships(scopeId, opts.includeRevoked === true);
	} finally {
		await store.close();
	}
}

export async function coordinatorGrantScopeMembershipAction(
	opts: CoordinatorGrantScopeMembershipInput & {
		groupId: string;
		dbPath?: string | null;
		remoteUrl?: string | null;
		adminSecret?: string | null;
	},
): Promise<CoordinatorScopeMembership> {
	const groupId = String(opts.groupId ?? "").trim();
	const scopeId = String(opts.scopeId ?? "").trim();
	const deviceId = String(opts.deviceId ?? "").trim();
	const effectId = normalizeMembershipEffectId(opts.effectId);
	if (!groupId || !scopeId || !deviceId) {
		throw new Error("group_id, scope_id, and device_id are required.");
	}
	const target = coordinatorRemoteTarget();
	const remote = opts.remoteUrl ?? (opts.dbPath ? null : target.remoteUrl);
	const adminSecret = opts.adminSecret ?? target.adminSecret;
	if (remote) {
		if (!adminSecret) throw new Error("Admin secret required.");
		const payload = await remoteRequest(
			"POST",
			`${stripTrailingSlashes(remote)}/v1/admin/groups/${encodeURIComponent(groupId)}/scopes/${encodeURIComponent(scopeId)}/members`,
			adminSecret,
			{
				effect_id: effectId,
				device_id: deviceId,
				role: opts.role ?? null,
				membership_epoch: opts.membershipEpoch ?? null,
				coordinator_id: opts.coordinatorId ?? null,
				manifest_issuer_device_id: opts.manifestIssuerDeviceId ?? null,
				manifest_hash: opts.manifestHash ?? null,
				signed_manifest_json: opts.signedManifestJson ?? null,
			},
			opts.actorId ?? null,
		);
		const membership = payload?.membership;
		if (!membership || typeof membership !== "object") {
			throw new Error("Remote coordinator did not return membership payload.");
		}
		return membership as CoordinatorScopeMembership;
	}
	const store = new BetterSqliteCoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		try {
			return await store.grantScopeMembership({
				effectId,
				scopeId,
				deviceId,
				role: opts.role ?? null,
				membershipEpoch: opts.membershipEpoch ?? null,
				coordinatorId: opts.coordinatorId ?? null,
				groupId,
				manifestIssuerDeviceId: opts.manifestIssuerDeviceId ?? null,
				manifestHash: opts.manifestHash ?? null,
				signedManifestJson: opts.signedManifestJson ?? null,
				actorType: opts.actorType ?? "admin",
				actorId: opts.actorId ?? null,
			});
		} catch (error) {
			if (error instanceof CoordinatorMembershipError && error.code === "scope_not_found") {
				throw new Error(`Scope not found: ${scopeId}`);
			}
			if (error instanceof CoordinatorMembershipError && error.code === "scope_inactive") {
				throw new Error(`Scope is not active: ${scopeId}`);
			}
			throw error;
		}
	} finally {
		await store.close();
	}
}

export async function coordinatorRevokeScopeMembershipAction(
	opts: CoordinatorRevokeScopeMembershipInput & {
		groupId: string;
		dbPath?: string | null;
		remoteUrl?: string | null;
		adminSecret?: string | null;
	},
): Promise<boolean> {
	const groupId = String(opts.groupId ?? "").trim();
	const scopeId = String(opts.scopeId ?? "").trim();
	const deviceId = String(opts.deviceId ?? "").trim();
	const effectId = normalizeMembershipEffectId(opts.effectId);
	if (!groupId || !scopeId || !deviceId) {
		throw new Error("group_id, scope_id, and device_id are required.");
	}
	const target = coordinatorRemoteTarget();
	const remote = opts.remoteUrl ?? (opts.dbPath ? null : target.remoteUrl);
	const adminSecret = opts.adminSecret ?? target.adminSecret;
	if (remote) {
		if (!adminSecret) throw new Error("Admin secret required.");
		try {
			await remoteRequest(
				"POST",
				`${stripTrailingSlashes(remote)}/v1/admin/groups/${encodeURIComponent(groupId)}/scopes/${encodeURIComponent(scopeId)}/members/${encodeURIComponent(deviceId)}/revoke`,
				adminSecret,
				{
					effect_id: effectId,
					membership_epoch: opts.membershipEpoch ?? null,
					manifest_hash: opts.manifestHash ?? null,
					signed_manifest_json: opts.signedManifestJson ?? null,
				},
				opts.actorId ?? null,
			);
		} catch (error) {
			if (error instanceof Error && error.message.includes("membership_not_found")) return false;
			throw error;
		}
		return true;
	}
	const store = new BetterSqliteCoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		return await store.revokeScopeMembership({
			effectId,
			scopeId,
			deviceId,
			groupId,
			membershipEpoch: opts.membershipEpoch ?? null,
			manifestHash: opts.manifestHash ?? null,
			signedManifestJson: opts.signedManifestJson ?? null,
			actorType: opts.actorType ?? "admin",
			actorId: opts.actorId ?? null,
		});
	} finally {
		await store.close();
	}
}

export async function coordinatorEnrollDeviceAction(opts: {
	groupId: string;
	deviceId: string;
	fingerprint: string;
	publicKey: string;
	displayName?: string | null;
	dbPath?: string | null;
}): Promise<CoordinatorEnrollment> {
	const groupId = String(opts.groupId ?? "").trim();
	const deviceId = String(opts.deviceId ?? "").trim();
	const fingerprint = String(opts.fingerprint ?? "").trim();
	const publicKey = String(opts.publicKey ?? "").trim();
	if (!groupId || !deviceId || !fingerprint || !publicKey) {
		throw new Error("group_id, device_id, fingerprint, and public_key are required.");
	}
	const store = new BetterSqliteCoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		if (!(await store.getGroup(groupId))) throw new Error(`Group not found: ${groupId}`);
		await store.enrollDevice(groupId, {
			deviceId,
			fingerprint,
			publicKey,
			displayName: opts.displayName ?? null,
		});
		const enrollment = await store.getEnrollment(groupId, deviceId);
		if (!enrollment) throw new Error(`Failed to enroll device: ${deviceId}`);
		return enrollment;
	} finally {
		await store.close();
	}
}

export async function coordinatorListDevicesAction(opts: {
	groupId: string;
	includeDisabled?: boolean;
	dbPath?: string | null;
	remoteUrl?: string | null;
	adminSecret?: string | null;
}): Promise<CoordinatorEnrollment[]> {
	const groupId = String(opts.groupId ?? "").trim();
	if (!groupId) throw new Error("Group id required.");
	const remote = opts.remoteUrl ?? null;
	const adminSecret = opts.adminSecret ?? null;
	if (remote) {
		if (!adminSecret) throw new Error("Admin secret required.");
		const payload = await remoteRequest(
			"GET",
			`${stripTrailingSlashes(remote)}/v1/admin/devices?group_id=${encodeURIComponent(groupId)}&include_disabled=${opts.includeDisabled ? "1" : "0"}`,
			adminSecret,
		);
		if (!Array.isArray(payload?.items)) {
			throw new Error("coordinator_device_list_malformed");
		}
		return payload.items.map((row) => {
			if (!row || typeof row !== "object" || Array.isArray(row)) {
				throw new Error("coordinator_device_list_malformed");
			}
			const record = row as Record<string, unknown>;
			const identityId = record.identity_id ?? null;
			const displayName = record.display_name ?? null;
			if (
				record.group_id !== groupId ||
				!isCanonicalCoordinatorIdentifier(record.device_id) ||
				typeof record.public_key !== "string" ||
				typeof record.fingerprint !== "string" ||
				(identityId !== null && !isCanonicalCoordinatorIdentifier(identityId)) ||
				(displayName !== null && typeof displayName !== "string") ||
				typeof record.enabled !== "number" ||
				typeof record.created_at !== "string"
			) {
				throw new Error("coordinator_device_list_malformed");
			}
			const enrollment: CoordinatorEnrollment = {
				group_id: groupId,
				device_id: record.device_id,
				public_key: record.public_key,
				fingerprint: record.fingerprint,
				identity_id: identityId,
				display_name: displayName,
				enabled: record.enabled,
				created_at: record.created_at,
			};
			if (
				typeof record.presence_expires_at === "string" &&
				record.presence_capabilities !== null &&
				typeof record.presence_capabilities === "object" &&
				!Array.isArray(record.presence_capabilities)
			) {
				const capabilities = record.presence_capabilities as Record<string, unknown>;
				enrollment.presence_expires_at = record.presence_expires_at;
				enrollment.presence_capabilities = {
					sync_capability: capabilities.sync_capability,
					sync_features: capabilities.sync_features,
				};
			}
			return enrollment;
		});
	}
	const store = new BetterSqliteCoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		return await store.listEnrolledDevices(groupId, opts.includeDisabled === true);
	} finally {
		await store.close();
	}
}

function isCanonicalCoordinatorIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 256 &&
		value === value.trim() &&
		!/[\p{Cc}\p{Cf}]/u.test(value)
	);
}

export interface CoordinatorConsumedTeamInvite {
	invite_id: string;
	group_id: string;
	policy_team_id: string;
	assigned_identity_id: string;
	recipient_actor_id: string;
	recipient_display_name?: string | null;
	recipient_device_display_name?: string | null;
	bound_device_id: string;
	consumed_at: string;
}

function requiredConsumedTeamInviteText(value: unknown, maxLength = 2048): string {
	if (
		typeof value !== "string" ||
		!value ||
		value !== value.trim() ||
		value.length > maxLength ||
		/[\p{Cc}\p{Cf}]/u.test(value)
	) {
		throw new Error("coordinator_consumed_team_invite_invalid");
	}
	return value;
}

function isCanonicalConsumedTeamInviteTimestamp(value: string): boolean {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return false;
	const canonical = parsed.toISOString();
	return value === canonical || value === canonical.replace(/\.000Z$/u, "Z");
}

function optionalConsumedTeamInviteDisplayName(value: unknown, field: string): string | null {
	if (value == null || typeof value !== "string") return null;
	try {
		return normalizeIdentityDisplayName(value, field);
	} catch {
		return null;
	}
}

function consumedTeamInvites(
	invites: Array<Partial<CoordinatorInvite>>,
): CoordinatorConsumedTeamInvite[] {
	return invites
		.filter((invite) => invite.invite_kind === "team_member" && invite.consumed_at != null)
		.map((invite) => {
			const assignedIdentityId = invite.assigned_identity_id;
			const recipientActorId = invite.recipient_actor_id;
			if (
				!isCoordinatorAssignedIdentityId(assignedIdentityId) ||
				!isCoordinatorAssignedIdentityId(recipientActorId) ||
				assignedIdentityId !== recipientActorId
			) {
				throw new Error("coordinator_consumed_team_invite_invalid");
			}
			const consumedAt = requiredConsumedTeamInviteText(invite.consumed_at);
			if (!isCanonicalConsumedTeamInviteTimestamp(consumedAt)) {
				throw new Error("coordinator_consumed_team_invite_invalid");
			}
			const recipientDisplayName = optionalConsumedTeamInviteDisplayName(
				invite.recipient_display_name,
				"recipient_display_name",
			);
			const recipientDeviceDisplayName = optionalConsumedTeamInviteDisplayName(
				invite.recipient_device_display_name,
				"device_display_name",
			);
			const row: CoordinatorConsumedTeamInvite = {
				invite_id: requiredConsumedTeamInviteText(invite.invite_id),
				group_id: requiredConsumedTeamInviteText(invite.group_id),
				policy_team_id: requiredConsumedTeamInviteText(invite.policy_team_id, 256),
				assigned_identity_id: assignedIdentityId,
				recipient_actor_id: recipientActorId,
				bound_device_id: requiredConsumedTeamInviteText(invite.bound_device_id, 256),
				consumed_at: consumedAt,
				...(recipientDisplayName == null ? {} : { recipient_display_name: recipientDisplayName }),
				...(recipientDeviceDisplayName == null
					? {}
					: { recipient_device_display_name: recipientDeviceDisplayName }),
			};
			if (Object.values(row).some((value) => !value)) {
				throw new Error("coordinator_consumed_team_invite_invalid");
			}
			return row;
		})
		.toSorted(
			(left, right) =>
				left.consumed_at.localeCompare(right.consumed_at) ||
				left.invite_id.localeCompare(right.invite_id),
		);
}

export async function coordinatorListConsumedTeamInvitesAction(opts: {
	groupId: string;
	dbPath?: string | null;
	remoteUrl?: string | null;
	adminSecret?: string | null;
}): Promise<CoordinatorConsumedTeamInvite[]> {
	const groupId = String(opts.groupId ?? "").trim();
	if (!groupId) throw new Error("Group id required.");
	const remote = opts.remoteUrl ?? null;
	const adminSecret = opts.adminSecret ?? null;
	let invites: Array<Partial<CoordinatorInvite>>;
	if (remote) {
		if (!adminSecret) throw new Error("Admin secret required.");
		const payload = await remoteRequest(
			"GET",
			`${stripTrailingSlashes(remote)}/v1/admin/invites?group_id=${encodeURIComponent(groupId)}`,
			adminSecret,
		);
		if (
			!Array.isArray(payload?.items) ||
			payload.items.some((row) => !row || typeof row !== "object" || Array.isArray(row))
		) {
			throw new Error("coordinator_invite_list_malformed");
		}
		invites = payload.items as Array<Partial<CoordinatorInvite>>;
	} else {
		const store = new BetterSqliteCoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
		try {
			invites = await store.listInvites(groupId);
		} finally {
			await store.close();
		}
	}
	if (invites.some((invite) => invite.group_id !== groupId)) {
		throw new Error("coordinator_invite_group_mismatch");
	}
	return consumedTeamInvites(invites);
}

interface CoordinatorReviewedRecipientInviteEvidenceBase {
	invite_id: string;
	group_id: string;
	bound_device_id: string;
	bound_public_key: string;
	bound_fingerprint: string;
	recipient_actor_id: string;
	consumed_at: string;
	reviewed_preview_digest: string;
}

/** Token-free proof that a recipient invite remains reviewed and bound after consumption. */
export type CoordinatorReviewedRecipientInviteEvidence =
	| (CoordinatorReviewedRecipientInviteEvidenceBase & {
			invite_kind: "team_member";
			policy_team_id: string;
			assigned_identity_id: string;
	  })
	| (CoordinatorReviewedRecipientInviteEvidenceBase & {
			invite_kind: "add_device";
			target_identity_id: string;
	  });

function requiredInviteText(value: unknown, maxLength = 2048): string {
	if (
		typeof value !== "string" ||
		!value ||
		value !== value.trim() ||
		value.length > maxLength ||
		/[\p{Cc}\p{Cf}]/u.test(value)
	) {
		throw new Error("coordinator_reviewed_recipient_invite_invalid");
	}
	return value;
}

function isCanonicalInviteTimestamp(value: string): boolean {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return false;
	const canonical = parsed.toISOString();
	return value === canonical || value === canonical.replace(/\.000Z$/u, "Z");
}

async function reviewedRecipientInviteEvidence(
	invite: Partial<CoordinatorInvite>,
): Promise<CoordinatorReviewedRecipientInviteEvidence | null> {
	if (invite.invite_kind !== "team_member" && invite.invite_kind !== "add_device") return null;
	if (invite.consumed_at == null) return null;
	if (invite.revoked_at != null) return null;
	const common = {
		invite_id: requiredInviteText(invite.invite_id),
		group_id: requiredInviteText(invite.group_id),
		bound_device_id: requiredInviteText(invite.bound_device_id, 256),
		bound_public_key: requiredInviteText(invite.bound_public_key),
		bound_fingerprint: requiredInviteText(invite.bound_fingerprint),
		recipient_actor_id: requiredInviteText(invite.recipient_actor_id, 256),
		consumed_at: requiredInviteText(invite.consumed_at),
		reviewed_preview_digest: requiredInviteText(invite.reviewed_preview_digest),
	};
	if (
		!isCanonicalInviteTimestamp(common.consumed_at) ||
		!/^[a-f0-9]{64}$/u.test(common.reviewed_preview_digest) ||
		fingerprintPublicKey(common.bound_public_key) !== common.bound_fingerprint
	) {
		throw new Error("coordinator_reviewed_recipient_invite_invalid");
	}
	if (invite.invite_kind === "team_member") {
		const policyTeamId = requiredInviteText(invite.policy_team_id, 256);
		const assignedIdentityId = requiredInviteText(invite.assigned_identity_id, 256);
		if (
			invite.target_identity_id !== null ||
			!isCoordinatorAssignedIdentityId(assignedIdentityId) ||
			common.recipient_actor_id !== assignedIdentityId
		) {
			throw new Error("coordinator_reviewed_recipient_invite_invalid");
		}
		await parseStoredRecipientReviewedIntent(invite.reviewed_intent_json, {
			target: { kind: "team_member", policyTeamId },
			digest: common.reviewed_preview_digest,
		}).catch(() => {
			throw new Error("coordinator_reviewed_recipient_invite_invalid");
		});
		return {
			...common,
			invite_kind: "team_member",
			policy_team_id: policyTeamId,
			assigned_identity_id: assignedIdentityId,
		};
	}
	const targetIdentityId = requiredInviteText(invite.target_identity_id, 256);
	if (
		invite.policy_team_id !== null ||
		invite.assigned_identity_id !== null ||
		common.recipient_actor_id !== targetIdentityId
	) {
		throw new Error("coordinator_reviewed_recipient_invite_invalid");
	}
	await parseStoredRecipientReviewedIntent(invite.reviewed_intent_json, {
		target: { kind: "add_device", targetIdentityId },
		digest: common.reviewed_preview_digest,
	}).catch(() => {
		throw new Error("coordinator_reviewed_recipient_invite_invalid");
	});
	return {
		...common,
		invite_kind: "add_device",
		target_identity_id: targetIdentityId,
	};
}

/** List fail-closed recipient bootstrap evidence from a local or remote coordinator store. */
export async function coordinatorListReviewedRecipientInviteEvidenceAction(opts: {
	groupId: string;
	dbPath?: string | null;
	remoteUrl?: string | null;
	adminSecret?: string | null;
}): Promise<CoordinatorReviewedRecipientInviteEvidence[]> {
	const groupId = String(opts.groupId ?? "").trim();
	if (!groupId) throw new Error("Group id required.");
	const remote = opts.remoteUrl ?? null;
	const adminSecret = opts.adminSecret ?? null;
	let invites: Array<Partial<CoordinatorInvite>>;
	if (remote) {
		if (!adminSecret) throw new Error("Admin secret required.");
		const payload = await remoteRequest(
			"GET",
			`${stripTrailingSlashes(remote)}/v1/admin/invites?group_id=${encodeURIComponent(groupId)}`,
			adminSecret,
		);
		if (
			!Array.isArray(payload?.items) ||
			payload.items.some((row) => !row || typeof row !== "object" || Array.isArray(row))
		) {
			throw new Error("coordinator_invite_list_malformed");
		}
		invites = payload.items as Array<Partial<CoordinatorInvite>>;
	} else {
		const store = new BetterSqliteCoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
		try {
			invites = await store.listInvites(groupId);
		} finally {
			await store.close();
		}
	}
	if (invites.some((invite) => invite.group_id !== groupId)) {
		throw new Error("coordinator_invite_group_mismatch");
	}
	const evidence = await Promise.all(invites.map(reviewedRecipientInviteEvidence));
	return evidence
		.filter((item): item is CoordinatorReviewedRecipientInviteEvidence => item != null)
		.toSorted(
			(left, right) =>
				left.consumed_at.localeCompare(right.consumed_at) ||
				left.invite_id.localeCompare(right.invite_id),
		);
}

export async function coordinatorRenameDeviceAction(opts: {
	groupId: string;
	deviceId: string;
	displayName: string;
	dbPath?: string | null;
	remoteUrl?: string | null;
	adminSecret?: string | null;
}): Promise<CoordinatorEnrollment | null> {
	const groupId = String(opts.groupId ?? "").trim();
	const deviceId = String(opts.deviceId ?? "").trim();
	const displayName = String(opts.displayName ?? "").trim();
	if (!groupId || !deviceId || !displayName) {
		throw new Error("group_id, device_id, and display_name are required.");
	}
	const remote = opts.remoteUrl ?? coordinatorRemoteTarget().remoteUrl;
	const adminSecret = opts.adminSecret ?? coordinatorRemoteTarget().adminSecret;
	if (remote) {
		if (!adminSecret) throw new Error("Admin secret required.");
		let payload: Record<string, unknown> | null;
		try {
			payload = await remoteRequest(
				"POST",
				`${stripTrailingSlashes(remote)}/v1/admin/devices/rename`,
				adminSecret,
				{ group_id: groupId, device_id: deviceId, display_name: displayName },
			);
		} catch (error) {
			if (
				error instanceof Error &&
				error.message.includes("(404)") &&
				error.message.includes("device_not_found")
			) {
				return null;
			}
			throw error;
		}
		const device = payload?.device;
		return device && typeof device === "object" ? (device as CoordinatorEnrollment) : null;
	}
	const store = new BetterSqliteCoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		const ok = await store.renameDevice(groupId, deviceId, displayName);
		if (!ok) return null;
		const active = await store.getEnrollment(groupId, deviceId);
		if (active) return active;
		const all = await store.listEnrolledDevices(groupId, true);
		return all.find((device) => device.device_id === deviceId) ?? null;
	} finally {
		await store.close();
	}
}

export async function coordinatorDisableDeviceAction(opts: {
	groupId: string;
	deviceId: string;
	dbPath?: string | null;
	remoteUrl?: string | null;
	adminSecret?: string | null;
}): Promise<boolean> {
	const groupId = String(opts.groupId ?? "").trim();
	const deviceId = String(opts.deviceId ?? "").trim();
	if (!groupId || !deviceId) throw new Error("group_id and device_id are required.");
	const remote = opts.remoteUrl ?? coordinatorRemoteTarget().remoteUrl;
	const adminSecret = opts.adminSecret ?? coordinatorRemoteTarget().adminSecret;
	if (remote) {
		if (!adminSecret) throw new Error("Admin secret required.");
		try {
			await remoteRequest(
				"POST",
				`${stripTrailingSlashes(remote)}/v1/admin/devices/disable`,
				adminSecret,
				{ group_id: groupId, device_id: deviceId },
			);
		} catch (error) {
			if (
				error instanceof Error &&
				error.message.includes("(404)") &&
				error.message.includes("device_not_found")
			) {
				return false;
			}
			throw error;
		}
		return true;
	}
	const store = new BetterSqliteCoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		return await store.setDeviceEnabled(groupId, deviceId, false);
	} finally {
		await store.close();
	}
}

export async function coordinatorEnableDeviceAction(opts: {
	groupId: string;
	deviceId: string;
	dbPath?: string | null;
	remoteUrl?: string | null;
	adminSecret?: string | null;
}): Promise<boolean> {
	const groupId = String(opts.groupId ?? "").trim();
	const deviceId = String(opts.deviceId ?? "").trim();
	if (!groupId || !deviceId) throw new Error("group_id and device_id are required.");
	const remote = opts.remoteUrl ?? coordinatorRemoteTarget().remoteUrl;
	const adminSecret = opts.adminSecret ?? coordinatorRemoteTarget().adminSecret;
	if (remote) {
		if (!adminSecret) throw new Error("Admin secret required.");
		try {
			await remoteRequest(
				"POST",
				`${stripTrailingSlashes(remote)}/v1/admin/devices/enable`,
				adminSecret,
				{ group_id: groupId, device_id: deviceId },
			);
		} catch (error) {
			if (
				error instanceof Error &&
				error.message.includes("(404)") &&
				error.message.includes("device_not_found")
			) {
				return false;
			}
			throw error;
		}
		return true;
	}
	const store = new BetterSqliteCoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		return await store.setDeviceEnabled(groupId, deviceId, true);
	} finally {
		await store.close();
	}
}

export async function coordinatorRemoveDeviceAction(opts: {
	groupId: string;
	deviceId: string;
	dbPath?: string | null;
	remoteUrl?: string | null;
	adminSecret?: string | null;
}): Promise<boolean> {
	const groupId = String(opts.groupId ?? "").trim();
	const deviceId = String(opts.deviceId ?? "").trim();
	if (!groupId || !deviceId) throw new Error("group_id and device_id are required.");
	const remote = opts.remoteUrl ?? coordinatorRemoteTarget().remoteUrl;
	const adminSecret = opts.adminSecret ?? coordinatorRemoteTarget().adminSecret;
	if (remote) {
		if (!adminSecret) throw new Error("Admin secret required.");
		try {
			await remoteRequest(
				"POST",
				`${stripTrailingSlashes(remote)}/v1/admin/devices/remove`,
				adminSecret,
				{ group_id: groupId, device_id: deviceId },
			);
		} catch (error) {
			if (
				error instanceof Error &&
				error.message.includes("(404)") &&
				error.message.includes("device_not_found")
			) {
				return false;
			}
			throw error;
		}
		return true;
	}
	const store = new BetterSqliteCoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		return await store.removeDevice(groupId, deviceId);
	} finally {
		await store.close();
	}
}

export async function coordinatorCreateInviteAction(opts: {
	groupId: string;
	coordinatorUrl?: string | null;
	policy: string;
	ttlHours: number;
	createdBy?: string | null;
	dbPath?: string | null;
	remoteUrl?: string | null;
	adminSecret?: string | null;
	operationId?: string | null;
	reviewedProjectSetDigest?: string | null;
	inviterActorId?: string | null;
	inviterDisplayName?: string | null;
	inviterDeviceId?: string | null;
	pendingPersonId?: string | null;
	projectSummaries?: Array<{ display_name: string; existing_memory_count: number }> | null;
	projectIntent?: Array<{
		canonical_identity: string;
		display_name: string;
		existing_memory_count: number;
	}> | null;
	inviteKind?: "legacy_enrollment" | "project_share" | "team_member" | "add_device" | null;
	policyTeamId?: string | null;
	targetIdentityId?: string | null;
	reviewedPreviewDigest?: string | null;
	reviewedIntent?: unknown;
}): Promise<Record<string, unknown>> {
	if (!VALID_INVITE_POLICIES.has(opts.policy)) throw new Error(`Invalid policy: ${opts.policy}`);
	if (
		opts.operationId &&
		(!opts.reviewedProjectSetDigest ||
			!opts.inviterActorId ||
			!opts.inviterDisplayName ||
			!opts.inviterDeviceId ||
			!opts.pendingPersonId ||
			!opts.projectSummaries?.length ||
			!opts.projectIntent?.length)
	) {
		throw new Error("project_invite_context_required");
	}
	const inviteKind = opts.inviteKind ?? (opts.operationId ? "project_share" : "legacy_enrollment");
	if (
		(inviteKind === "team_member" &&
			(!opts.policyTeamId || !opts.reviewedPreviewDigest || opts.targetIdentityId)) ||
		(inviteKind === "add_device" &&
			(!opts.targetIdentityId || !opts.reviewedPreviewDigest || opts.policyTeamId)) ||
		(!["team_member", "add_device"].includes(inviteKind) &&
			Boolean(opts.policyTeamId || opts.targetIdentityId || opts.reviewedPreviewDigest))
	) {
		throw new Error("recipient_invite_context_required");
	}
	let reviewedIntent: RecipientReviewedIntentV1 | undefined;
	if (inviteKind === "team_member" || inviteKind === "add_device") {
		if (opts.reviewedIntent == null) throw new Error("recipient_invite_review_unavailable");
		try {
			reviewedIntent = await verifyRecipientReviewedIntent(opts.reviewedIntent, {
				target:
					inviteKind === "team_member"
						? { kind: "team_member", policyTeamId: String(opts.policyTeamId) }
						: { kind: "add_device", targetIdentityId: String(opts.targetIdentityId) },
				digest: String(opts.reviewedPreviewDigest),
			});
		} catch (error) {
			if (
				error instanceof RecipientReviewedIntentError &&
				error.code === "recipient_invite_intent_mismatch"
			) {
				throw error;
			}
			throw new Error("recipient_invite_review_unavailable");
		}
	} else if (opts.reviewedIntent != null) {
		throw new Error("recipient_invite_context_required");
	}
	const expiresAt = new Date(Date.now() + opts.ttlHours * 3600 * 1000).toISOString();
	const remote = opts.remoteUrl ?? coordinatorRemoteTarget().remoteUrl;
	const adminSecret = opts.adminSecret ?? coordinatorRemoteTarget().adminSecret;
	if (remote) {
		if (!adminSecret)
			throw new Error("Admin secret required to create invites via the coordinator API.");
		const payload = await remoteRequest(
			"POST",
			`${stripTrailingSlashes(remote)}/v1/admin/invites`,
			adminSecret,
			{
				group_id: opts.groupId,
				policy: opts.policy,
				expires_at: expiresAt,
				created_by: opts.createdBy ?? null,
				coordinator_url: opts.coordinatorUrl || remote,
				operation_id: opts.operationId ?? null,
				reviewed_project_set_digest: opts.reviewedProjectSetDigest ?? null,
				inviter_actor_id: opts.inviterActorId ?? null,
				inviter_display_name: opts.inviterDisplayName ?? null,
				inviter_device_id: opts.inviterDeviceId ?? null,
				pending_person_id: opts.pendingPersonId ?? null,
				project_summaries: opts.projectSummaries ?? null,
				project_intent: opts.projectIntent ?? null,
				invite_kind: inviteKind,
				policy_team_id: opts.policyTeamId ?? null,
				target_identity_id: opts.targetIdentityId ?? null,
				reviewed_preview_digest: opts.reviewedPreviewDigest ?? null,
				reviewed_intent: reviewedIntent ?? null,
			},
		);
		const invite = payload?.invite;
		const inviteRecord =
			invite && typeof invite === "object" && !Array.isArray(invite)
				? (invite as Record<string, unknown>)
				: null;
		return {
			group_id: opts.groupId,
			invite_id: inviteRecord?.invite_id,
			operation_id: inviteRecord?.operation_id ?? null,
			reviewed_project_set_digest: inviteRecord?.reviewed_project_set_digest ?? null,
			invite_kind: inviteRecord?.invite_kind ?? inviteKind,
			policy_team_id: inviteRecord?.policy_team_id ?? opts.policyTeamId ?? null,
			target_identity_id: inviteRecord?.target_identity_id ?? opts.targetIdentityId ?? null,
			assigned_identity_id: inviteRecord?.assigned_identity_id ?? null,
			reviewed_preview_digest:
				inviteRecord?.reviewed_preview_digest ?? opts.reviewedPreviewDigest ?? null,
			encoded: payload?.encoded,
			link: payload?.link,
			payload: payload?.payload,
			warnings: inviteUrlWarnings(String(opts.coordinatorUrl || remote)),
			mode: "remote",
		};
	}
	const resolvedCoordinatorUrl = String(
		opts.coordinatorUrl ?? readCodememConfigFile().sync_coordinator_url ?? "",
	).trim();
	if (!resolvedCoordinatorUrl) throw new Error("Coordinator URL required.");
	const store = new BetterSqliteCoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		const group = await store.getGroup(opts.groupId);
		if (!group) throw new Error(`Group not found: ${opts.groupId}`);
		const invite = await store.createInvite({
			groupId: opts.groupId,
			policy: opts.policy,
			expiresAt,
			createdBy: opts.createdBy ?? null,
			operationId: opts.operationId ?? null,
			reviewedProjectSetDigest: opts.reviewedProjectSetDigest ?? null,
			inviterActorId: opts.inviterActorId ?? null,
			inviterDisplayName: opts.inviterDisplayName ?? null,
			inviterDeviceId: opts.inviterDeviceId ?? null,
			pendingPersonId: opts.pendingPersonId ?? null,
			projectSummaries: opts.projectSummaries ?? null,
			projectIntent: opts.projectIntent ?? null,
			inviteKind,
			policyTeamId: opts.policyTeamId ?? null,
			targetIdentityId: opts.targetIdentityId ?? null,
			reviewedPreviewDigest: opts.reviewedPreviewDigest ?? null,
			reviewedIntent,
		});
		const payload: InvitePayload = {
			v: 1,
			kind:
				invite.invite_kind === "team_member" || invite.invite_kind === "add_device"
					? invite.invite_kind
					: "coordinator_team_invite",
			coordinator_url: resolvedCoordinatorUrl,
			group_id: opts.groupId,
			policy: invite.policy,
			token: String(invite.token ?? ""),
			expires_at: invite.expires_at,
			team_name: (invite.team_name_snapshot as string) ?? null,
			...(invite.operation_id
				? {
						operation_id: invite.operation_id,
						inviter_name: invite.inviter_display_name ?? null,
						project_summaries: opts.projectSummaries ?? [],
					}
				: {}),
			...(invite.invite_kind === "team_member"
				? {
						policy_team_id: invite.policy_team_id ?? undefined,
						assigned_identity_id: invite.assigned_identity_id ?? undefined,
						reviewed_preview_digest: invite.reviewed_preview_digest ?? undefined,
					}
				: {}),
			...(invite.invite_kind === "add_device"
				? {
						target_identity_id: invite.target_identity_id ?? undefined,
						inviter_device_id: invite.inviter_device_id ?? undefined,
						reviewed_preview_digest: invite.reviewed_preview_digest ?? undefined,
					}
				: {}),
		};
		const encoded = encodeInvitePayload(payload);
		return {
			group_id: opts.groupId,
			invite_id: invite.invite_id,
			operation_id: invite.operation_id ?? null,
			reviewed_project_set_digest: invite.reviewed_project_set_digest ?? null,
			invite_kind: invite.invite_kind ?? inviteKind,
			policy_team_id: invite.policy_team_id ?? null,
			target_identity_id: invite.target_identity_id ?? null,
			assigned_identity_id: invite.assigned_identity_id ?? null,
			reviewed_preview_digest: invite.reviewed_preview_digest ?? null,
			encoded,
			link: inviteLink(encoded),
			payload,
			warnings: inviteUrlWarnings(resolvedCoordinatorUrl),
			mode: "local",
		};
	} finally {
		await store.close();
	}
}

export async function coordinatorCreateAddDeviceInviteAction(opts: {
	groupId: string;
	coordinatorUrl?: string | null;
	ttlHours: number;
	deviceId: string;
	keysDir?: string | null;
	remoteUrl?: string | null;
	reviewedPreviewDigest: string;
	reviewedIntent: RecipientReviewedIntentV1;
}): Promise<Record<string, unknown>> {
	const groupId = String(opts.groupId ?? "").trim();
	const deviceId = String(opts.deviceId ?? "").trim();
	const remote = String(
		opts.remoteUrl ?? opts.coordinatorUrl ?? coordinatorRemoteTarget().remoteUrl ?? "",
	).trim();
	if (!groupId) throw new Error("group_id_required");
	if (!deviceId) throw new Error("device_id_required");
	if (!remote) throw new Error("coordinator_not_configured");
	if (!Number.isInteger(opts.ttlHours) || opts.ttlHours < 1) throw new Error("ttl_hours_invalid");
	const reviewedPreviewDigest = String(opts.reviewedPreviewDigest ?? "").trim();
	if (!/^[a-f0-9]{64}$/u.test(reviewedPreviewDigest)) {
		throw new Error("reviewed_preview_digest_invalid");
	}
	const expiresAt = new Date(Date.now() + opts.ttlHours * 3600 * 1000).toISOString();
	const body = {
		group_id: groupId,
		expires_at: expiresAt,
		reviewed_preview_digest: reviewedPreviewDigest,
		reviewed_intent: opts.reviewedIntent,
	};
	const url = `${stripTrailingSlashes(remote)}/v1/invites/add-device`;
	const bodyBytes = Buffer.from(JSON.stringify(body), "utf8");
	const [status, response] = await requestJson("POST", url, {
		headers: buildAuthHeaders({
			deviceId,
			method: "POST",
			url,
			bodyBytes,
			keysDir: opts.keysDir ?? undefined,
		}),
		bodyBytes,
		timeoutS: 3,
	});
	if (status < 200 || status >= 300) {
		const detail = typeof response?.error === "string" ? response.error : "unknown";
		throw new Error(`Remote coordinator request failed (${status}): ${detail}`);
	}
	const invite =
		response?.invite && typeof response.invite === "object" && !Array.isArray(response.invite)
			? (response.invite as Record<string, unknown>)
			: null;
	return {
		group_id: groupId,
		invite_id: invite?.invite_id,
		invite_kind: invite?.invite_kind ?? "add_device",
		target_identity_id: invite?.target_identity_id ?? null,
		reviewed_preview_digest: invite?.reviewed_preview_digest ?? reviewedPreviewDigest,
		encoded: response?.encoded,
		link: response?.link,
		payload: response?.payload,
		warnings: inviteUrlWarnings(opts.coordinatorUrl || remote),
		mode: "remote",
	};
}

interface ProjectInviteTrustResult {
	bootstrapGrantId: string | null;
	inviterPeer?: {
		deviceId: string;
		publicKey: string;
		fingerprint: string;
		displayName?: string;
	};
}

interface ValidatedAcceptedProjectIntent {
	operationId: string;
	reviewedProjectSetDigest: string;
	coordinatorId: string;
	groupId: string;
	projects: Array<AcceptedProjectIntent & { managedScopeId: string }>;
}

export function isPeerTrustBindingCompatible(
	db: ReturnType<typeof connect>,
	deviceId: string,
	publicKey: string,
	fingerprint: string,
): boolean {
	const existing = db
		.prepare(
			`SELECT peer.claimed_local_actor, peer.pinned_fingerprint, peer.public_key,
			 actor.is_local AS actor_is_local
			 FROM sync_peers peer
			 LEFT JOIN actors actor ON actor.actor_id = peer.actor_id
			 WHERE peer.peer_device_id = ?`,
		)
		.get(deviceId) as
		| {
				claimed_local_actor: number;
				pinned_fingerprint: string | null;
				public_key: string | null;
				actor_is_local: number | null;
		  }
		| undefined;
	if (!existing) return true;
	if (existing.claimed_local_actor === 1 || existing.actor_is_local === 1) return false;
	const existingFingerprint = String(existing.pinned_fingerprint ?? "").trim();
	const existingPublicKey = String(existing.public_key ?? "").trim();
	return (
		(!existingFingerprint || existingFingerprint === fingerprint) &&
		(!existingPublicKey || existingPublicKey === publicKey)
	);
}

function parseProjectInviteTrust(
	response: Record<string, unknown> | null,
): ProjectInviteTrustResult {
	const trustState = String(response?.trust_state ?? "").trim();
	if (!["pending_inviter_device", "bootstrap_grant_created"].includes(trustState)) {
		throw new Error("project_invite_trust_state_invalid");
	}
	const bootstrapGrantId = String(response?.bootstrap_grant_id ?? "").trim() || null;
	const inviter = response?.inviter_device;
	const inviterObject =
		inviter && typeof inviter === "object" && !Array.isArray(inviter)
			? (inviter as Record<string, unknown>)
			: null;
	if (trustState === "pending_inviter_device") {
		if (inviter != null || bootstrapGrantId) throw new Error("project_invite_bootstrap_incomplete");
		return { bootstrapGrantId: null };
	}
	if (!inviterObject || !bootstrapGrantId) throw new Error("project_invite_bootstrap_incomplete");
	const deviceId = String(inviterObject.device_id ?? "").trim();
	const publicKey = String(inviterObject.public_key ?? "").trim();
	const fingerprint = String(inviterObject.fingerprint ?? "").trim();
	if (!deviceId || !publicKey || fingerprintPublicKey(publicKey) !== fingerprint) {
		throw new Error("inviter_identity_invalid");
	}
	return {
		bootstrapGrantId,
		inviterPeer: {
			deviceId,
			publicKey,
			fingerprint,
			displayName: String(inviterObject.display_name ?? "").trim() || undefined,
		},
	};
}

function validateAcceptedProjectIntent(opts: {
	payload: InvitePayload;
	response: Record<string, unknown> | null;
	coordinatorUrl: string;
}): ValidatedAcceptedProjectIntent | null {
	if (!Object.hasOwn(opts.response ?? {}, "accepted_project_intent")) return null;
	const value = opts.response?.accepted_project_intent;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("accepted_project_intent_invalid");
	}
	const record = value as Record<string, unknown>;
	const operationId = String(record.operation_id ?? "").trim();
	const reviewedProjectSetDigest = String(record.reviewed_project_set_digest ?? "").trim();
	const payloadOperationId = String(opts.payload.operation_id ?? "").trim();
	const responseOperationId = String(opts.response?.operation_id ?? "").trim();
	const groupId = String(opts.payload.group_id ?? "").trim();
	const responseGroupId = String(opts.response?.group_id ?? "").trim();
	if (
		!/^share_[a-f0-9]{40}$/u.test(operationId) ||
		operationId !== payloadOperationId ||
		operationId !== responseOperationId ||
		!groupId ||
		groupId !== responseGroupId ||
		!/^[a-f0-9]{64}$/u.test(reviewedProjectSetDigest)
	) {
		throw new Error("accepted_project_intent_mismatch");
	}
	let projects: AcceptedProjectIntent[];
	try {
		projects = parseAcceptedProjectIntent(record.projects);
	} catch {
		throw new Error("accepted_project_intent_invalid");
	}
	const computedDigest = acceptedProjectIntentDigest(projects);
	if (computedDigest !== reviewedProjectSetDigest) {
		throw new Error("accepted_project_intent_mismatch");
	}
	return {
		operationId,
		reviewedProjectSetDigest,
		coordinatorId: buildBaseUrl(opts.coordinatorUrl),
		groupId,
		projects: projects.map((project) => ({
			...project,
			managedScopeId: managedProjectScopeId(groupId, project.canonical_identity),
		})),
	};
}

function persistProjectInviteTrust(opts: {
	dbPath: string;
	recipientActorId: string;
	recipientDisplayName: string;
	acceptingDeviceId: string;
	groupId: string;
	response: Record<string, unknown> | null;
	acceptedIntent: ValidatedAcceptedProjectIntent | null;
}): void {
	const trust = parseProjectInviteTrust(opts.response);
	const conn = connect(opts.dbPath);
	try {
		conn.transaction(() => {
			const now = new Date().toISOString();
			conn
				.prepare(`INSERT INTO actors(actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at)
				VALUES (?, ?, 1, 'active', NULL, ?, ?)
				ON CONFLICT(actor_id) DO UPDATE SET display_name = excluded.display_name,
				is_local = 1, status = 'active', merged_into_actor_id = NULL, updated_at = excluded.updated_at`)
				.run(opts.recipientActorId, opts.recipientDisplayName, now, now);
			if (
				trust.inviterPeer &&
				!isPeerTrustBindingCompatible(
					conn,
					trust.inviterPeer.deviceId,
					trust.inviterPeer.publicKey,
					trust.inviterPeer.fingerprint,
				)
			) {
				throw new Error("inviter_peer_trust_conflict");
			}
			if (trust.inviterPeer) {
				updatePeerAddresses(conn, trust.inviterPeer.deviceId, [], {
					pinnedFingerprint: trust.inviterPeer.fingerprint,
					publicKey: trust.inviterPeer.publicKey,
					name: trust.inviterPeer.displayName,
					replaceTrust: true,
				});
				conn
					.prepare(`UPDATE sync_peers SET pending_bootstrap_grant_id = ?,
					discovered_via_group_id = ? WHERE peer_device_id = ?`)
					.run(trust.bootstrapGrantId, opts.groupId, trust.inviterPeer.deviceId);
			}
			const intent = opts.acceptedIntent;
			if (!intent) return;
			for (const project of intent.projects) {
				const existing = conn
					.prepare(`SELECT display_name, managed_scope_id, coordinator_id, group_id,
						recipient_identity_id, accepting_device_id, reviewed_project_set_digest
					 FROM recipient_managed_project_projections
					 WHERE source_operation_id = ? AND canonical_project_identity = ?`)
					.get(intent.operationId, project.canonical_identity) as
					| {
							display_name: string;
							managed_scope_id: string;
							coordinator_id: string;
							group_id: string;
							recipient_identity_id: string;
							accepting_device_id: string;
							reviewed_project_set_digest: string;
					  }
					| undefined;
				if (
					existing &&
					(existing.display_name !== project.display_name ||
						existing.managed_scope_id !== project.managedScopeId ||
						existing.coordinator_id !== intent.coordinatorId ||
						existing.group_id !== intent.groupId ||
						existing.recipient_identity_id !== opts.recipientActorId ||
						existing.accepting_device_id !== opts.acceptingDeviceId ||
						existing.reviewed_project_set_digest !== intent.reviewedProjectSetDigest)
				) {
					throw new Error("accepted_project_projection_conflict");
				}
				if (existing) continue;
				conn
					.prepare(`INSERT INTO recipient_managed_project_projections(
					canonical_project_identity, display_name, managed_scope_id, coordinator_id,
					group_id, recipient_identity_id, accepting_device_id, source_operation_id,
					reviewed_project_set_digest, status, accepted_at, revoked_at, created_at, updated_at
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?)`)
					.run(
						project.canonical_identity,
						project.display_name,
						project.managedScopeId,
						intent.coordinatorId,
						intent.groupId,
						opts.recipientActorId,
						opts.acceptingDeviceId,
						intent.operationId,
						intent.reviewedProjectSetDigest,
						now,
						now,
						now,
					);
			}
		})();
	} finally {
		conn.close();
	}
}

function recipientInviteOnboardingRequest(opts: {
	payload: InvitePayload;
	identityId: string;
	deviceId: string;
	publicKey: string;
	deviceDisplayName: string;
}): RecipientPolicyReviewedIntentPreviewRequestV1 {
	const base = {
		version: 1 as const,
		invitationId: String(opts.payload.token),
		identityId: opts.identityId,
		deviceId: opts.deviceId,
		devicePublicKey: opts.publicKey,
		deviceDisplayName: opts.deviceDisplayName,
	};
	return opts.payload.kind === "team_member"
		? {
				...base,
				journey: "team",
				teamId: String(opts.payload.policy_team_id ?? ""),
			}
		: { ...base, journey: "add_device" };
}

async function validateRecipientInviteReview(opts: {
	payload: InvitePayload;
	response: Record<string, unknown> | null;
	identityId: string;
	deviceId: string;
	publicKey: string;
	deviceDisplayName: string;
	recipientDisplayName: string;
	reviewedOnboardingDigest: string;
	requireResponseIdentity?: boolean;
}): Promise<{
	reviewedIntent: RecipientReviewedIntentV1;
	persistedRecipientDisplayName: string;
}> {
	const responseKind = String(opts.response?.kind ?? "").trim();
	const responseDigest = String(opts.response?.reviewed_preview_digest ?? "").trim();
	const payloadIdentityId = recipientInviteAuthoritativeIdentityId({
		kind: opts.payload.kind as CoordinatorRecipientInviteKind,
		assigned_identity_id: opts.payload.assigned_identity_id,
		target_identity_id: opts.payload.target_identity_id,
	});
	const responseIdentityId = recipientInviteAuthoritativeIdentityId({
		kind: opts.payload.kind as CoordinatorRecipientInviteKind,
		assigned_identity_id: opts.response?.assigned_identity_id,
		target_identity_id: opts.response?.target_identity_id,
	});
	const acceptedIdentityId = String(opts.response?.identity_id ?? "").trim();
	if (
		responseKind !== opts.payload.kind ||
		!payloadIdentityId ||
		opts.identityId !== payloadIdentityId ||
		responseIdentityId !== payloadIdentityId ||
		(opts.requireResponseIdentity && acceptedIdentityId !== payloadIdentityId) ||
		responseDigest !== String(opts.payload.reviewed_preview_digest ?? "").trim() ||
		(opts.payload.kind === "team_member" &&
			String(opts.response?.policy_team_id ?? "").trim() !==
				String(opts.payload.policy_team_id ?? "").trim())
	) {
		throw new Error("recipient_invite_intent_mismatch");
	}
	let reviewedIntent: RecipientReviewedIntentV1;
	try {
		reviewedIntent = await verifyRecipientReviewedIntent(opts.response?.reviewed_intent, {
			target:
				opts.payload.kind === "team_member"
					? {
							kind: "team_member",
							policyTeamId: String(opts.payload.policy_team_id ?? "").trim(),
						}
					: {
							kind: "add_device",
							targetIdentityId: String(opts.payload.target_identity_id ?? "").trim(),
						},
			digest: responseDigest,
		});
	} catch (error) {
		if (error instanceof RecipientReviewedIntentError) {
			throw new Error("recipient_invite_intent_mismatch");
		}
		throw error;
	}
	const preview = previewRecipientPolicyOnboardingFromReviewedIntent(
		reviewedIntent,
		recipientInviteOnboardingRequest({
			payload: opts.payload,
			identityId: opts.identityId,
			deviceId: opts.deviceId,
			publicKey: opts.publicKey,
			deviceDisplayName: opts.deviceDisplayName,
		}),
	);
	if (opts.reviewedOnboardingDigest !== preview.reviewedOnboardingDigest) {
		throw new Error("reviewed_onboarding_stale");
	}
	return {
		reviewedIntent,
		persistedRecipientDisplayName:
			reviewedIntent.journey === "add_device"
				? reviewedIntent.targetIdentity.displayName
				: opts.recipientDisplayName,
	};
}

function persistRecipientInviteOnboarding(opts: {
	dbPath: string;
	payload: InvitePayload;
	identityId: string;
	identityDisplayName: string;
	deviceId: string;
	publicKey: string;
	deviceDisplayName: string;
	reviewedIntent: RecipientReviewedIntentV1;
	reviewedOnboardingDigest: string;
}): void {
	const conn = connect(opts.dbPath);
	try {
		const request = recipientInviteOnboardingRequest(opts);
		const result = commitRecipientPolicyOnboardingFromReviewedIntent(conn, {
			...request,
			identityDisplayName: opts.identityDisplayName,
			reviewedIntent: opts.reviewedIntent,
			reviewedOnboardingDigest: opts.reviewedOnboardingDigest,
		});
		if (result.status !== "applied")
			throw new Error(result.errorCode ?? "onboarding_commit_failed");
	} finally {
		conn.close();
	}
}

async function persistAddDeviceInviterTrust(opts: {
	dbPath: string;
	payload: InvitePayload;
	response: Record<string, unknown> | null;
}): Promise<boolean> {
	if (opts.payload.kind !== "add_device") return false;
	const inviter = opts.response?.inviter_device;
	const inviterObject =
		inviter && typeof inviter === "object" && !Array.isArray(inviter)
			? (inviter as Record<string, unknown>)
			: null;
	const bootstrapGrantId = String(opts.response?.bootstrap_grant_id ?? "").trim();
	const responseGroupId = String(opts.response?.group_id ?? "").trim();
	if (!inviterObject || !bootstrapGrantId || responseGroupId !== String(opts.payload.group_id)) {
		return false;
	}
	const inviterDeviceId = String(inviterObject.device_id ?? "").trim();
	const publicKey = String(inviterObject.public_key ?? "").trim();
	const fingerprint = String(inviterObject.fingerprint ?? "").trim();
	if (!inviterDeviceId || !publicKey || fingerprintPublicKey(publicKey) !== fingerprint)
		return false;
	const conn = connect(opts.dbPath);
	try {
		if (!isPeerTrustBindingCompatible(conn, inviterDeviceId, publicKey, fingerprint)) return false;
		updatePeerAddresses(conn, inviterDeviceId, [], {
			name: String(inviterObject.display_name ?? "").trim() || "Existing device",
			pinnedFingerprint: fingerprint,
			publicKey,
			replaceTrust: true,
		});
		conn
			.prepare(`UPDATE sync_peers SET pending_bootstrap_grant_id = ?,
				discovered_via_group_id = ? WHERE peer_device_id = ?`)
			.run(bootstrapGrantId, responseGroupId, inviterDeviceId);
		return true;
	} finally {
		conn.close();
	}
}

export async function coordinatorImportInviteAction(opts: {
	inviteValue: string;
	dbPath?: string | null;
	keysDir?: string | null;
	configPath?: string | null;
	recipientActorId?: string | null;
	recipientDisplayName?: string | null;
	deviceDisplayName?: string | null;
	reviewedOnboardingDigest?: string | null;
}): Promise<Record<string, unknown>> {
	const payload = decodeInvitePayload(extractInvitePayload(opts.inviteValue));
	const resolvedDbPath = resolveDbPath(opts.dbPath ?? undefined);
	const keysDir = opts.keysDir ?? (process.env.CODEMEM_KEYS_DIR?.trim() || undefined);
	initDatabase(resolvedDbPath);
	const conn = connect(resolvedDbPath);
	let deviceId = "";
	let fingerprint = "";
	try {
		[deviceId, fingerprint] = ensureDeviceIdentity(conn, { keysDir });
	} finally {
		conn.close();
	}
	const publicKey = loadPublicKey(keysDir);
	if (!publicKey) throw new Error("public key missing");
	const coordinatorUrl = String(payload.coordinator_url ?? "").trim();
	if (!coordinatorUrl) throw new Error("Invite is missing a coordinator URL.");
	const config = opts.configPath
		? readCodememConfigFileAtPath(opts.configPath)
		: readCodememConfigFile();
	const projectInvite = Boolean(payload.operation_id);
	const recipientInvite = payload.kind === "team_member" || payload.kind === "add_device";
	const fallbackDeviceName = friendlyDeviceName({
		explicitName: String(config.sync_device_name ?? ""),
		osName: hostname(),
		fallbackSeed: deviceId,
	});
	const explicitRecipientActorId = String(opts.recipientActorId ?? "").trim();
	const configuredRecipientActorId = String(config.actor_id ?? "").trim();
	const recipientInviteIdentityId = recipientInvite
		? recipientInviteAuthoritativeIdentityId({
				kind: payload.kind as CoordinatorRecipientInviteKind,
				assigned_identity_id: payload.assigned_identity_id,
				target_identity_id: payload.target_identity_id,
			})
		: "";
	let recipientActorId =
		explicitRecipientActorId || configuredRecipientActorId || `local:${deviceId}`;
	if (recipientInvite) {
		if (
			!recipientInviteIdentityId ||
			(explicitRecipientActorId && explicitRecipientActorId !== recipientInviteIdentityId)
		) {
			throw new Error("invite_identity_conflict");
		}
		if (
			configuredRecipientActorId &&
			configuredRecipientActorId !== recipientInviteIdentityId &&
			configuredRecipientActorId !== `local:${deviceId}`
		) {
			throw new Error("invite_identity_conflict");
		}
		const identityConn = connect(resolvedDbPath);
		try {
			assertAddDeviceIdentityAdoptionAllowed(identityConn, recipientInviteIdentityId, deviceId);
		} finally {
			identityConn.close();
		}
		recipientActorId = recipientInviteIdentityId;
	}
	const recipientDisplayName =
		projectInvite || recipientInvite
			? normalizeIdentityDisplayName(
					String(opts.recipientDisplayName ?? config.actor_display_name ?? fallbackDeviceName),
					"recipient_display_name",
				)
			: String(config.actor_display_name ?? deviceId).trim() || deviceId;
	const displayName =
		projectInvite || recipientInvite
			? normalizeIdentityDisplayName(
					String(opts.deviceDisplayName ?? fallbackDeviceName),
					"device_display_name",
				)
			: recipientDisplayName;
	// V1 of multi-team assumes one coordinator hosting multiple groups.
	// If this device is already enrolled in a different coordinator, surface
	// that as a hard error instead of silently overwriting the existing
	// coordinator URL and orphaning the prior group memberships. Normalize
	// trailing slashes before comparing so harmless formatting differences
	// (e.g. `https://coord.example.com` vs. `…/`) don't reject valid same-
	// coordinator invites.
	const normalizeCoordinatorUrl = (value: string): string => stripTrailingSlashes(value.trim());
	const existingCoordinator = normalizeCoordinatorUrl(String(config.sync_coordinator_url ?? ""));
	const incomingCoordinator = normalizeCoordinatorUrl(coordinatorUrl);
	if (existingCoordinator && existingCoordinator !== incomingCoordinator) {
		throw new Error(
			`This device is already enrolled with coordinator ${existingCoordinator}. Multi-team joining is only supported across groups on the same coordinator.`,
		);
	}
	const reviewedOnboardingDigest = String(opts.reviewedOnboardingDigest ?? "").trim();
	if (recipientInvite && !reviewedOnboardingDigest) {
		throw new Error("reviewed_onboarding_digest_required");
	}
	if (recipientInvite) {
		let inspectStatus = 0;
		let inspection: Record<string, unknown> | null = null;
		try {
			[inspectStatus, inspection] = await requestJson(
				"POST",
				`${stripTrailingSlashes(coordinatorUrl)}/v1/invites/inspect`,
				{
					body: { token: String(payload.token) },
					timeoutS: INVITE_IMPORT_TIMEOUT_S,
				},
			);
		} catch (error) {
			throw inviteImportTransportError(error, coordinatorUrl);
		}
		if (inspectStatus < 200 || inspectStatus >= 300) {
			const detail = typeof inspection?.error === "string" ? inspection.error : "unknown";
			if (
				[
					"invite_already_bound",
					"invite_expired",
					"invite_invalid",
					"recipient_invite_review_unavailable",
				].includes(detail)
			) {
				throw new Error(detail);
			}
			throw new Error(`Invite inspection failed (${inspectStatus}): ${detail}`);
		}
		await validateRecipientInviteReview({
			payload,
			response: inspection,
			identityId: recipientActorId,
			deviceId,
			publicKey,
			deviceDisplayName: displayName,
			recipientDisplayName,
			reviewedOnboardingDigest,
		});
	}
	const joinBody: Record<string, unknown> = {
		token: String(payload.token),
		device_id: deviceId,
		public_key: publicKey,
		fingerprint,
		...(recipientInvite ? {} : { display_name: displayName }),
		...(recipientInvite
			? {
					invite_kind: payload.kind,
					identity_id: recipientActorId,
					recipient_display_name: recipientDisplayName,
					device_display_name: displayName,
				}
			: {}),
		...(projectInvite
			? {
					operation_id: payload.operation_id,
					recipient_actor_id: recipientActorId,
					recipient_display_name: recipientDisplayName,
					device_display_name: displayName,
				}
			: {}),
	};
	let status = 0;
	let response: Record<string, unknown> | null = null;
	try {
		[status, response] = await requestJson(
			"POST",
			`${stripTrailingSlashes(coordinatorUrl)}/v1/join`,
			{ body: joinBody, timeoutS: INVITE_IMPORT_TIMEOUT_S },
		);
		if (
			recipientInvite &&
			!projectInvite &&
			"recipient_display_name" in joinBody &&
			status === 400 &&
			response?.error === "unexpected_recipient_invite_fields"
		) {
			const legacyJoinBody = Object.fromEntries(
				Object.entries(joinBody).filter(
					([key]) => key !== "recipient_display_name" && key !== "device_display_name",
				),
			);
			[status, response] = await requestJson(
				"POST",
				`${stripTrailingSlashes(coordinatorUrl)}/v1/join`,
				{
					body: legacyJoinBody,
					timeoutS: INVITE_IMPORT_TIMEOUT_S,
				},
			);
		}
	} catch (error) {
		throw inviteImportTransportError(error, coordinatorUrl);
	}
	if (status < 200 || status >= 300) {
		const detail = typeof response?.error === "string" ? response.error : "unknown";
		if (
			[
				"add_device_invite_self_acceptance_forbidden",
				"invite_already_bound",
				"invite_expired",
				"invite_identity_conflict",
				"invite_invalid",
				"recipient_invite_intent_mismatch",
				"recipient_invite_review_unavailable",
			].includes(detail)
		) {
			throw new Error(detail);
		}
		throw new Error(`Invite import failed (${status}): ${detail}`);
	}
	// A successful consume is trusted coordinator state; malformed authority must fail closed,
	// not be silently downgraded into an invite without its managed-Project projection.
	const acceptedProjectIntent = projectInvite
		? validateAcceptedProjectIntent({ payload, response, coordinatorUrl })
		: null;
	if (projectInvite) {
		persistProjectInviteTrust({
			dbPath: resolvedDbPath,
			recipientActorId,
			recipientDisplayName,
			acceptingDeviceId: deviceId,
			groupId: String(payload.group_id),
			response,
			acceptedIntent: acceptedProjectIntent,
		});
	}
	let persistedRecipientDisplayName = recipientDisplayName;
	let recipientOnboarding: Parameters<typeof persistRecipientInviteOnboarding>[0] | null = null;
	if (recipientInvite) {
		const validatedReview = await validateRecipientInviteReview({
			payload,
			identityId: recipientActorId,
			deviceId,
			publicKey,
			deviceDisplayName: displayName,
			response,
			recipientDisplayName,
			reviewedOnboardingDigest,
			requireResponseIdentity: true,
		});
		persistedRecipientDisplayName = validatedReview.persistedRecipientDisplayName;
		recipientOnboarding = {
			dbPath: resolvedDbPath,
			payload,
			identityId: recipientActorId,
			identityDisplayName: persistedRecipientDisplayName,
			deviceId,
			publicKey,
			deviceDisplayName: displayName,
			reviewedIntent: validatedReview.reviewedIntent,
			reviewedOnboardingDigest,
		};
	}
	const previousConfig = opts.configPath
		? readCodememConfigFileAtPath(opts.configPath)
		: readCodememConfigFile();
	let nextConfig = { ...previousConfig };
	if (projectInvite || recipientInvite) nextConfig = enableInviteSync(nextConfig);
	nextConfig.sync_coordinator_url = coordinatorUrl;
	if (projectInvite || recipientInvite) {
		nextConfig.actor_id = recipientActorId;
		nextConfig.actor_display_name = persistedRecipientDisplayName;
		nextConfig.sync_device_name = displayName;
	}
	// Append the new group to sync_coordinator_groups (dedup) instead of
	// overwriting sync_coordinator_group. The runtime reads both the plural
	// and singular forms; we keep singular pointing at the first group for
	// legacy compatibility.
	const newGroupId = String(payload.group_id);
	const existingGroups = (() => {
		const plural = nextConfig.sync_coordinator_groups;
		if (Array.isArray(plural)) return plural.map((g) => String(g).trim()).filter(Boolean);
		if (typeof plural === "string") {
			return plural
				.split(",")
				.map((g) => g.trim())
				.filter(Boolean);
		}
		const singular = nextConfig.sync_coordinator_group;
		return typeof singular === "string" && singular.trim() ? [singular.trim()] : [];
	})();
	const mergedGroups = Array.from(new Set([...existingGroups, newGroupId]));
	nextConfig.sync_coordinator_groups = mergedGroups;
	nextConfig.sync_coordinator_group = mergedGroups[0] ?? newGroupId;
	let configPath: string;
	try {
		configPath = writeCodememConfigFile(nextConfig, opts.configPath ?? undefined);
	} catch (error) {
		if (projectInvite) {
			throw new ProjectSyncEnablementError({ cause: error });
		}
		throw error;
	}
	if (recipientOnboarding) {
		try {
			persistRecipientInviteOnboarding(recipientOnboarding);
		} catch (error) {
			try {
				writeCodememConfigFile(previousConfig, opts.configPath ?? undefined);
			} catch (restoreError) {
				throw new AggregateError([error, restoreError], "recipient_invite_config_restore_failed");
			}
			throw error;
		}
	}
	const inviterPeerLinked = await persistAddDeviceInviterTrust({
		dbPath: resolvedDbPath,
		payload,
		response,
	}).catch(() => false);
	if (recipientInvite) {
		return {
			group_id: response?.group_id ?? payload.group_id,
			coordinator_url: payload.coordinator_url,
			status: response?.status ?? null,
			invite_kind: response?.kind ?? payload.kind,
			identity_id: recipientActorId,
			inviter_peer_linked: inviterPeerLinked,
			policy_team_id: response?.policy_team_id ?? payload.policy_team_id ?? null,
			target_identity_id: response?.target_identity_id ?? payload.target_identity_id ?? null,
			...(payload.kind === "team_member"
				? {
						assigned_identity_id:
							response?.assigned_identity_id ?? payload.assigned_identity_id ?? null,
					}
				: {}),
			reviewed_preview_digest: response?.reviewed_preview_digest ?? null,
			sync_enabled: true,
		};
	}
	return {
		group_id: payload.group_id,
		coordinator_url: payload.coordinator_url,
		status: projectInvite ? PROJECT_INVITE_PENDING_STATUS : (response?.status ?? null),
		...(projectInvite
			? {
					setup_state: "pending_inviter",
					sync_enabled: true,
					message:
						"Invitation accepted. Project access is still being set up and the first sync has not completed yet.",
				}
			: {}),
		operation_id: response?.operation_id ?? payload.operation_id ?? null,
		trust_state: response?.trust_state ?? null,
		bootstrap_grant_id: response?.bootstrap_grant_id ?? null,
		inviter_device: response?.inviter_device ?? null,
		config_path: configPath,
		groups: mergedGroups,
	};
}

export async function coordinatorListJoinRequestsAction(opts: {
	groupId: string;
	dbPath?: string | null;
	remoteUrl?: string | null;
	adminSecret?: string | null;
}): Promise<CoordinatorJoinRequest[]> {
	const remote = opts.remoteUrl ?? coordinatorRemoteTarget().remoteUrl;
	const adminSecret = opts.adminSecret ?? coordinatorRemoteTarget().adminSecret;
	if (remote) {
		if (!adminSecret) throw new Error("Admin secret required.");
		const payload = await remoteRequest(
			"GET",
			`${stripTrailingSlashes(remote)}/v1/admin/join-requests?group_id=${encodeURIComponent(opts.groupId)}`,
			adminSecret,
		);
		return Array.isArray(payload?.items)
			? payload.items.filter(
					(row): row is CoordinatorJoinRequest => Boolean(row) && typeof row === "object",
				)
			: [];
	}
	const store = new BetterSqliteCoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		return await store.listJoinRequests(opts.groupId);
	} finally {
		await store.close();
	}
}

export async function coordinatorReviewJoinRequestAction(opts: {
	requestId: string;
	approve: boolean;
	reviewedBy?: string | null;
	dbPath?: string | null;
	remoteUrl?: string | null;
	adminSecret?: string | null;
}): Promise<CoordinatorJoinRequestReviewResult | null> {
	const remote = opts.remoteUrl ?? coordinatorRemoteTarget().remoteUrl;
	const adminSecret = opts.adminSecret ?? coordinatorRemoteTarget().adminSecret;
	if (remote) {
		if (!adminSecret) throw new Error("Admin secret required.");
		const endpoint = opts.approve
			? "/v1/admin/join-requests/approve"
			: "/v1/admin/join-requests/deny";
		const payload = await remoteRequest(
			"POST",
			`${stripTrailingSlashes(remote)}${endpoint}`,
			adminSecret,
			{
				request_id: opts.requestId,
				reviewed_by: opts.reviewedBy ?? null,
			},
		);
		const request = payload?.request;
		return request && typeof request === "object"
			? (request as CoordinatorJoinRequestReviewResult)
			: null;
	}
	const store = new BetterSqliteCoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		return await store.reviewJoinRequest({
			requestId: opts.requestId,
			approved: opts.approve,
			reviewedBy: opts.reviewedBy ?? null,
		});
	} finally {
		await store.close();
	}
}

export async function coordinatorListBootstrapGrantsAction(opts: {
	groupId: string;
	dbPath?: string | null;
	remoteUrl?: string | null;
	adminSecret?: string | null;
}): Promise<CoordinatorBootstrapGrant[]> {
	const remote = opts.remoteUrl ?? (opts.dbPath ? null : coordinatorRemoteTarget().remoteUrl);
	const adminSecret = opts.adminSecret ?? coordinatorRemoteTarget().adminSecret;
	if (remote) {
		if (!adminSecret) throw new Error("Admin secret required.");
		const payload = await remoteRequest(
			"GET",
			`${stripTrailingSlashes(remote)}/v1/admin/bootstrap-grants?group_id=${encodeURIComponent(opts.groupId)}`,
			adminSecret,
		);
		return Array.isArray(payload?.items)
			? payload.items.filter(
					(row): row is CoordinatorBootstrapGrant => Boolean(row) && typeof row === "object",
				)
			: [];
	}
	const store = new BetterSqliteCoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		return await store.listBootstrapGrants(opts.groupId);
	} finally {
		await store.close();
	}
}

export async function coordinatorRevokeBootstrapGrantAction(opts: {
	grantId: string;
	dbPath?: string | null;
	remoteUrl?: string | null;
	adminSecret?: string | null;
}): Promise<boolean> {
	const remote = opts.remoteUrl ?? (opts.dbPath ? null : coordinatorRemoteTarget().remoteUrl);
	const adminSecret = opts.adminSecret ?? coordinatorRemoteTarget().adminSecret;
	if (remote) {
		if (!adminSecret) throw new Error("Admin secret required.");
		try {
			await remoteRequest(
				"POST",
				`${stripTrailingSlashes(remote)}/v1/admin/bootstrap-grants/revoke`,
				adminSecret,
				{ grant_id: opts.grantId },
			);
		} catch (error) {
			if (
				error instanceof Error &&
				error.message.includes("(404)") &&
				error.message.includes("grant_not_found")
			) {
				return false;
			}
			throw error;
		}
		return true;
	}
	const store = new BetterSqliteCoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		return await store.revokeBootstrapGrant(opts.grantId);
	} finally {
		await store.close();
	}
}
