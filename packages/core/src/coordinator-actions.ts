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
import { requestJson } from "./sync-http-client.js";
import { ensureDeviceIdentity, loadPublicKey } from "./sync-identity.js";

const VALID_INVITE_POLICIES = new Set(["auto_admit", "approval_required"]);

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
	const [status, response] = await requestJson(
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
			timeoutS: 3,
		},
	);
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
