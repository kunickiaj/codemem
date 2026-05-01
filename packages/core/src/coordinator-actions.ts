import { homedir } from "node:os";
import { join } from "node:path";
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
import { connect } from "./db.js";
import { initDatabase } from "./maintenance.js";
import { readCodememConfigFile, writeCodememConfigFile } from "./observer-config.js";
import { buildBaseUrl, requestJson } from "./sync-http-client.js";
import { ensureDeviceIdentity, loadPublicKey } from "./sync-identity.js";

const VALID_INVITE_POLICIES = new Set(["auto_admit", "approval_required"]);
const INVITE_IMPORT_TIMEOUT_S = 10;

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
): Promise<Record<string, unknown> | null> {
	const [status, payload] = await requestJson(method, url, {
		headers: { "X-Codemem-Coordinator-Admin": adminSecret },
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
			`${remote.replace(/\/+$/, "")}/v1/admin/groups`,
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
				`${remote.replace(/\/+$/, "")}/v1/admin/groups/rename`,
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
				`${remote.replace(/\/+$/, "")}/v1/admin/groups/archive`,
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
				`${remote.replace(/\/+$/, "")}/v1/admin/groups/unarchive`,
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
			`${remote.replace(/\/+$/, "")}/v1/admin/groups${includeArchived ? "?include_archived=1" : ""}`,
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
			`${remote.replace(/\/+$/, "")}/v1/admin/groups/${encodeURIComponent(groupId)}/scopes${opts.includeInactive ? "?include_inactive=1" : ""}`,
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
			`${remote.replace(/\/+$/, "")}/v1/admin/groups/${encodeURIComponent(groupId)}/scopes`,
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
				`${remote.replace(/\/+$/, "")}/v1/admin/groups/${encodeURIComponent(groupId)}/scopes/${encodeURIComponent(scopeId)}`,
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
			`${remote.replace(/\/+$/, "")}/v1/admin/groups/${encodeURIComponent(groupId)}/scopes/${encodeURIComponent(scopeId)}/members${opts.includeRevoked ? "?include_revoked=1" : ""}`,
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
			`${remote.replace(/\/+$/, "")}/v1/admin/groups/${encodeURIComponent(groupId)}/scopes/${encodeURIComponent(scopeId)}/members`,
			adminSecret,
			{
				device_id: deviceId,
				role: opts.role ?? null,
				membership_epoch: opts.membershipEpoch ?? null,
				coordinator_id: opts.coordinatorId ?? null,
				manifest_issuer_device_id: opts.manifestIssuerDeviceId ?? null,
				manifest_hash: opts.manifestHash ?? null,
				signed_manifest_json: opts.signedManifestJson ?? null,
			},
		);
		const membership = payload?.membership;
		if (!membership || typeof membership !== "object") {
			throw new Error("Remote coordinator did not return membership payload.");
		}
		return membership as CoordinatorScopeMembership;
	}
	const store = new BetterSqliteCoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		const scope = await localScopeForGroup(store, groupId, scopeId);
		if (!scope) throw new Error(`Scope not found: ${scopeId}`);
		if (scope.status !== "active") throw new Error(`Scope is not active: ${scopeId}`);
		return await store.grantScopeMembership({
			scopeId,
			deviceId,
			role: opts.role ?? null,
			membershipEpoch: opts.membershipEpoch ?? null,
			coordinatorId: opts.coordinatorId ?? null,
			groupId,
			manifestIssuerDeviceId: opts.manifestIssuerDeviceId ?? null,
			manifestHash: opts.manifestHash ?? null,
			signedManifestJson: opts.signedManifestJson ?? null,
		});
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
				`${remote.replace(/\/+$/, "")}/v1/admin/groups/${encodeURIComponent(groupId)}/scopes/${encodeURIComponent(scopeId)}/members/${encodeURIComponent(deviceId)}/revoke`,
				adminSecret,
				{
					membership_epoch: opts.membershipEpoch ?? null,
					manifest_hash: opts.manifestHash ?? null,
					signed_manifest_json: opts.signedManifestJson ?? null,
				},
			);
		} catch (error) {
			if (error instanceof Error && error.message.includes("membership_not_found")) return false;
			throw error;
		}
		return true;
	}
	const store = new BetterSqliteCoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		if (!(await localScopeForGroup(store, groupId, scopeId))) return false;
		return await store.revokeScopeMembership({
			scopeId,
			deviceId,
			membershipEpoch: opts.membershipEpoch ?? null,
			manifestHash: opts.manifestHash ?? null,
			signedManifestJson: opts.signedManifestJson ?? null,
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
			`${remote.replace(/\/+$/, "")}/v1/admin/devices?group_id=${encodeURIComponent(groupId)}&include_disabled=${opts.includeDisabled ? "1" : "0"}`,
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
				`${remote.replace(/\/+$/, "")}/v1/admin/devices/rename`,
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
				`${remote.replace(/\/+$/, "")}/v1/admin/devices/disable`,
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
				`${remote.replace(/\/+$/, "")}/v1/admin/devices/enable`,
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
				`${remote.replace(/\/+$/, "")}/v1/admin/devices/remove`,
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
}): Promise<Record<string, unknown>> {
	if (!VALID_INVITE_POLICIES.has(opts.policy)) throw new Error(`Invalid policy: ${opts.policy}`);
	const expiresAt = new Date(Date.now() + opts.ttlHours * 3600 * 1000).toISOString();
	const remote = opts.remoteUrl ?? coordinatorRemoteTarget().remoteUrl;
	const adminSecret = opts.adminSecret ?? coordinatorRemoteTarget().adminSecret;
	if (remote) {
		if (!adminSecret)
			throw new Error("Admin secret required to create invites via the coordinator API.");
		const payload = await remoteRequest(
			"POST",
			`${remote.replace(/\/+$/, "")}/v1/admin/invites`,
			adminSecret,
			{
				group_id: opts.groupId,
				policy: opts.policy,
				expires_at: expiresAt,
				created_by: opts.createdBy ?? null,
				coordinator_url: opts.coordinatorUrl || remote,
			},
		);
		return {
			group_id: opts.groupId,
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
		});
		const payload: InvitePayload = {
			v: 1,
			kind: "coordinator_team_invite",
			coordinator_url: resolvedCoordinatorUrl,
			group_id: opts.groupId,
			policy: opts.policy,
			token: String(invite.token ?? ""),
			expires_at: expiresAt,
			team_name: (invite.team_name_snapshot as string) ?? null,
		};
		const encoded = encodeInvitePayload(payload);
		return {
			group_id: opts.groupId,
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

export async function coordinatorImportInviteAction(opts: {
	inviteValue: string;
	dbPath?: string | null;
	keysDir?: string | null;
	configPath?: string | null;
}): Promise<Record<string, unknown>> {
	const payload = decodeInvitePayload(extractInvitePayload(opts.inviteValue));
	const resolvedDbPath = opts.dbPath ?? join(homedir(), ".codemem", "mem.sqlite");
	initDatabase(resolvedDbPath);
	const conn = connect(resolvedDbPath);
	let deviceId = "";
	let fingerprint = "";
	try {
		[deviceId, fingerprint] = ensureDeviceIdentity(conn, { keysDir: opts.keysDir ?? undefined });
	} finally {
		conn.close();
	}
	const publicKey = loadPublicKey(opts.keysDir ?? undefined);
	if (!publicKey) throw new Error("public key missing");
	const coordinatorUrl = String(payload.coordinator_url ?? "").trim();
	if (!coordinatorUrl) throw new Error("Invite is missing a coordinator URL.");
	const config = readCodememConfigFile();
	const displayName = String(config.actor_display_name ?? deviceId).trim() || deviceId;
	// V1 of multi-team assumes one coordinator hosting multiple groups.
	// If this device is already enrolled in a different coordinator, surface
	// that as a hard error instead of silently overwriting the existing
	// coordinator URL and orphaning the prior group memberships. Normalize
	// trailing slashes before comparing so harmless formatting differences
	// (e.g. `https://coord.example.com` vs. `…/`) don't reject valid same-
	// coordinator invites.
	const normalizeCoordinatorUrl = (value: string): string => value.trim().replace(/\/+$/, "");
	const existingCoordinator = normalizeCoordinatorUrl(String(config.sync_coordinator_url ?? ""));
	const incomingCoordinator = normalizeCoordinatorUrl(coordinatorUrl);
	if (existingCoordinator && existingCoordinator !== incomingCoordinator) {
		throw new Error(
			`This device is already enrolled with coordinator ${existingCoordinator}. Multi-team joining is only supported across groups on the same coordinator.`,
		);
	}
	let status = 0;
	let response: Record<string, unknown> | null = null;
	try {
		[status, response] = await requestJson(
			"POST",
			`${coordinatorUrl.replace(/\/+$/, "")}/v1/join`,
			{
				body: {
					token: String(payload.token),
					device_id: deviceId,
					public_key: publicKey,
					fingerprint,
					display_name: displayName,
				},
				timeoutS: INVITE_IMPORT_TIMEOUT_S,
			},
		);
	} catch (error) {
		throw inviteImportTransportError(error, coordinatorUrl);
	}
	if (status < 200 || status >= 300) {
		const detail = typeof response?.error === "string" ? response.error : "unknown";
		throw new Error(`Invite import failed (${status}): ${detail}`);
	}
	const nextConfig = readCodememConfigFile();
	nextConfig.sync_coordinator_url = coordinatorUrl;
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
	const configPath = writeCodememConfigFile(nextConfig, opts.configPath ?? undefined);
	return {
		group_id: payload.group_id,
		coordinator_url: payload.coordinator_url,
		status: response?.status ?? null,
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
			`${remote.replace(/\/+$/, "")}/v1/admin/join-requests?group_id=${encodeURIComponent(opts.groupId)}`,
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
			`${remote.replace(/\/+$/, "")}${endpoint}`,
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
			`${remote.replace(/\/+$/, "")}/v1/admin/bootstrap-grants?group_id=${encodeURIComponent(opts.groupId)}`,
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
				`${remote.replace(/\/+$/, "")}/v1/admin/bootstrap-grants/revoke`,
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
