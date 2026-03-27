import { homedir } from "node:os";
import { join } from "node:path";
import {
	decodeInvitePayload,
	encodeInvitePayload,
	extractInvitePayload,
	type InvitePayload,
	inviteLink,
} from "./coordinator-invites.js";
import { CoordinatorStore, DEFAULT_COORDINATOR_DB_PATH } from "./coordinator-store.js";
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
	const adminSecret = remoteUrl
		? String(
				process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET ??
					config.sync_coordinator_admin_secret ??
					"",
			).trim() || null
		: null;
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

export function coordinatorCreateGroupAction(opts: {
	groupId: string;
	displayName?: string | null;
	dbPath?: string | null;
}): Record<string, unknown> {
	const groupId = String(opts.groupId ?? "").trim();
	if (!groupId) throw new Error("Group id required.");
	const store = new CoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		store.createGroup(groupId, opts.displayName ?? null);
		return store.getGroup(groupId) ?? {};
	} finally {
		store.close();
	}
}

export function coordinatorListGroupsAction(opts?: {
	dbPath?: string | null;
}): Record<string, unknown>[] {
	const store = new CoordinatorStore(opts?.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		return store.listGroups();
	} finally {
		store.close();
	}
}

export function coordinatorEnrollDeviceAction(opts: {
	groupId: string;
	deviceId: string;
	fingerprint: string;
	publicKey: string;
	displayName?: string | null;
	dbPath?: string | null;
}): Record<string, unknown> {
	const groupId = String(opts.groupId ?? "").trim();
	const deviceId = String(opts.deviceId ?? "").trim();
	const fingerprint = String(opts.fingerprint ?? "").trim();
	const publicKey = String(opts.publicKey ?? "").trim();
	if (!groupId || !deviceId || !fingerprint || !publicKey) {
		throw new Error("group_id, device_id, fingerprint, and public_key are required.");
	}
	const store = new CoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		if (!store.getGroup(groupId)) throw new Error(`Group not found: ${groupId}`);
		store.enrollDevice(groupId, {
			deviceId,
			fingerprint,
			publicKey,
			displayName: opts.displayName ?? null,
		});
		return store.getEnrollment(groupId, deviceId) ?? {};
	} finally {
		store.close();
	}
}

export function coordinatorListDevicesAction(opts: {
	groupId: string;
	includeDisabled?: boolean;
	dbPath?: string | null;
}): Record<string, unknown>[] {
	const groupId = String(opts.groupId ?? "").trim();
	if (!groupId) throw new Error("Group id required.");
	const store = new CoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		return store.listEnrolledDevices(groupId, opts.includeDisabled === true);
	} finally {
		store.close();
	}
}

export function coordinatorRenameDeviceAction(opts: {
	groupId: string;
	deviceId: string;
	displayName: string;
	dbPath?: string | null;
}): Record<string, unknown> | null {
	const groupId = String(opts.groupId ?? "").trim();
	const deviceId = String(opts.deviceId ?? "").trim();
	const displayName = String(opts.displayName ?? "").trim();
	if (!groupId || !deviceId || !displayName) {
		throw new Error("group_id, device_id, and display_name are required.");
	}
	const store = new CoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		const ok = store.renameDevice(groupId, deviceId, displayName);
		return ok ? (store.getEnrollment(groupId, deviceId) ?? {}) : null;
	} finally {
		store.close();
	}
}

export function coordinatorDisableDeviceAction(opts: {
	groupId: string;
	deviceId: string;
	dbPath?: string | null;
}): boolean {
	const groupId = String(opts.groupId ?? "").trim();
	const deviceId = String(opts.deviceId ?? "").trim();
	if (!groupId || !deviceId) throw new Error("group_id and device_id are required.");
	const store = new CoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		return store.setDeviceEnabled(groupId, deviceId, false);
	} finally {
		store.close();
	}
}

export function coordinatorRemoveDeviceAction(opts: {
	groupId: string;
	deviceId: string;
	dbPath?: string | null;
}): boolean {
	const groupId = String(opts.groupId ?? "").trim();
	const deviceId = String(opts.deviceId ?? "").trim();
	if (!groupId || !deviceId) throw new Error("group_id and device_id are required.");
	const store = new CoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		return store.removeDevice(groupId, deviceId);
	} finally {
		store.close();
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
	const store = new CoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		const group = store.getGroup(opts.groupId);
		if (!group) throw new Error(`Group not found: ${opts.groupId}`);
		const invite = store.createInvite({
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
		store.close();
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
	nextConfig.sync_coordinator_group = String(payload.group_id);
	const configPath = writeCodememConfigFile(nextConfig, opts.configPath ?? undefined);
	return {
		group_id: payload.group_id,
		coordinator_url: payload.coordinator_url,
		status: response?.status ?? null,
		config_path: configPath,
	};
}

export async function coordinatorListJoinRequestsAction(opts: {
	groupId: string;
	dbPath?: string | null;
	remoteUrl?: string | null;
	adminSecret?: string | null;
}): Promise<Record<string, unknown>[]> {
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
					(row): row is Record<string, unknown> => Boolean(row) && typeof row === "object",
				)
			: [];
	}
	const store = new CoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		return store.listJoinRequests(opts.groupId);
	} finally {
		store.close();
	}
}

export async function coordinatorReviewJoinRequestAction(opts: {
	requestId: string;
	approve: boolean;
	reviewedBy?: string | null;
	dbPath?: string | null;
	remoteUrl?: string | null;
	adminSecret?: string | null;
}): Promise<Record<string, unknown> | null> {
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
		return request && typeof request === "object" ? (request as Record<string, unknown>) : null;
	}
	const store = new CoordinatorStore(opts.dbPath ?? DEFAULT_COORDINATOR_DB_PATH);
	try {
		return store.reviewJoinRequest({
			requestId: opts.requestId,
			approved: opts.approve,
			reviewedBy: opts.reviewedBy ?? null,
		});
	} finally {
		store.close();
	}
}
