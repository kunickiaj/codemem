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
	CoordinatorJoinRequest,
	CoordinatorJoinRequestReviewResult,
	CoordinatorRevokeScopeMembershipInput,
	CoordinatorScope,
	CoordinatorScopeMembership,
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
	RecipientReviewedIntentError,
	type RecipientReviewedIntentV1,
	verifyRecipientReviewedIntent,
} from "./recipient-reviewed-intent.js";
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
		return Array.isArray(payload?.items)
			? payload.items.filter(
					(row): row is CoordinatorEnrollment => Boolean(row) && typeof row === "object",
				)
			: [];
	}
	const store = new BetterSqliteCoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		return await store.listEnrolledDevices(groupId, opts.includeDisabled === true);
	} finally {
		await store.close();
	}
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
						reviewed_preview_digest: invite.reviewed_preview_digest ?? undefined,
					}
				: {}),
			...(invite.invite_kind === "add_device"
				? {
						target_identity_id: invite.target_identity_id ?? undefined,
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

interface ProjectInviteTrustResult {
	bootstrapGrantId: string | null;
	inviterPeer?: {
		deviceId: string;
		publicKey: string;
		fingerprint: string;
		displayName?: string;
	};
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

function persistProjectInviteTrust(opts: {
	dbPath: string;
	recipientActorId: string;
	recipientDisplayName: string;
	groupId: string;
	response: Record<string, unknown> | null;
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
			if (!trust.inviterPeer) return;
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
	const addDeviceTargetIdentityId =
		payload.kind === "add_device" ? String(payload.target_identity_id ?? "").trim() : "";
	let recipientActorId =
		explicitRecipientActorId || configuredRecipientActorId || `local:${deviceId}`;
	if (payload.kind === "add_device") {
		if (
			!addDeviceTargetIdentityId ||
			(explicitRecipientActorId && explicitRecipientActorId !== addDeviceTargetIdentityId)
		) {
			throw new Error("invite_identity_conflict");
		}
		if (
			configuredRecipientActorId &&
			configuredRecipientActorId !== addDeviceTargetIdentityId &&
			configuredRecipientActorId !== `local:${deviceId}`
		) {
			throw new Error("invite_identity_conflict");
		}
		const identityConn = connect(resolvedDbPath);
		try {
			assertAddDeviceIdentityAdoptionAllowed(identityConn, addDeviceTargetIdentityId, deviceId);
		} finally {
			identityConn.close();
		}
		recipientActorId = addDeviceTargetIdentityId;
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
	let status = 0;
	let response: Record<string, unknown> | null = null;
	try {
		[status, response] = await requestJson(
			"POST",
			`${stripTrailingSlashes(coordinatorUrl)}/v1/join`,
			{
				body: {
					token: String(payload.token),
					device_id: deviceId,
					public_key: publicKey,
					fingerprint,
					...(recipientInvite ? {} : { display_name: displayName }),
					...(recipientInvite
						? {
								invite_kind: payload.kind,
								identity_id: recipientActorId,
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
				},
				timeoutS: INVITE_IMPORT_TIMEOUT_S,
			},
		);
	} catch (error) {
		throw inviteImportTransportError(error, coordinatorUrl);
	}
	if (status < 200 || status >= 300) {
		const detail = typeof response?.error === "string" ? response.error : "unknown";
		if (
			[
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
	if (projectInvite) {
		persistProjectInviteTrust({
			dbPath: resolvedDbPath,
			recipientActorId,
			recipientDisplayName,
			groupId: String(payload.group_id),
			response,
		});
	}
	let persistedRecipientDisplayName = recipientDisplayName;
	let recipientOnboarding: Parameters<typeof persistRecipientInviteOnboarding>[0] | null = null;
	if (recipientInvite) {
		const responseKind = String(response?.kind ?? "").trim();
		const responseDigest = String(response?.reviewed_preview_digest ?? "").trim();
		if (
			responseKind !== payload.kind ||
			responseDigest !== String(payload.reviewed_preview_digest ?? "").trim() ||
			(payload.kind === "team_member" &&
				String(response?.policy_team_id ?? "").trim() !==
					String(payload.policy_team_id ?? "").trim()) ||
			(payload.kind === "add_device" &&
				String(response?.target_identity_id ?? "").trim() !==
					String(payload.target_identity_id ?? "").trim())
		) {
			throw new Error("recipient_invite_intent_mismatch");
		}
		let reviewedIntent: RecipientReviewedIntentV1;
		try {
			reviewedIntent = await verifyRecipientReviewedIntent(response?.reviewed_intent, {
				target:
					payload.kind === "team_member"
						? {
								kind: "team_member",
								policyTeamId: String(payload.policy_team_id ?? "").trim(),
							}
						: {
								kind: "add_device",
								targetIdentityId: String(payload.target_identity_id ?? "").trim(),
							},
				digest: responseDigest,
			});
		} catch (error) {
			if (error instanceof RecipientReviewedIntentError) {
				throw new Error("recipient_invite_intent_mismatch");
			}
			throw error;
		}
		if (reviewedIntent.journey === "add_device") {
			persistedRecipientDisplayName = reviewedIntent.targetIdentity.displayName;
		}
		const onboardingRequest = recipientInviteOnboardingRequest({
			payload,
			identityId: recipientActorId,
			deviceId,
			publicKey,
			deviceDisplayName: displayName,
		});
		const preview = previewRecipientPolicyOnboardingFromReviewedIntent(
			reviewedIntent,
			onboardingRequest,
		);
		if (reviewedOnboardingDigest !== preview.reviewedOnboardingDigest) {
			throw new Error("reviewed_onboarding_stale");
		}
		recipientOnboarding = {
			dbPath: resolvedDbPath,
			payload,
			identityId: recipientActorId,
			identityDisplayName: persistedRecipientDisplayName,
			deviceId,
			publicKey,
			deviceDisplayName: displayName,
			reviewedIntent,
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
	if (recipientInvite) {
		return {
			group_id: response?.group_id ?? payload.group_id,
			coordinator_url: payload.coordinator_url,
			status: response?.status ?? null,
			invite_kind: response?.kind ?? payload.kind,
			identity_id: response?.identity_id ?? recipientActorId,
			policy_team_id: response?.policy_team_id ?? payload.policy_team_id ?? null,
			target_identity_id: response?.target_identity_id ?? payload.target_identity_id ?? null,
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
