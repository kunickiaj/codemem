/**
 * BetterSqliteCoordinatorStore — SQLite-backed state for the coordinator relay server.
 *
 * The coordinator is a cloud relay that manages group membership, device
 * enrollment, presence, invites, and join requests for sync between devices.
 *
 * This store uses its OWN database (separate from the main codemem DB) and
 * owns its own schema — the TS side creates tables directly.
 *
 * Ported from codemem/coordinator_store.py.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Database as DatabaseType } from "better-sqlite3";
import Database from "better-sqlite3";
import type {
	CoordinatorBootstrapGrant,
	CoordinatorCreateBootstrapGrantInput,
	CoordinatorCreateInviteInput,
	CoordinatorCreateJoinRequestInput,
	CoordinatorCreateReciprocalApprovalInput,
	CoordinatorCreateScopeInput,
	CoordinatorEnrollDeviceInput,
	CoordinatorEnrollment,
	CoordinatorGrantScopeMembershipInput,
	CoordinatorGroup,
	CoordinatorInvite,
	CoordinatorJoinRequest,
	CoordinatorJoinRequestReviewResult,
	CoordinatorListReciprocalApprovalsInput,
	CoordinatorListScopesInput,
	CoordinatorPeerRecord,
	CoordinatorPresenceRecord,
	CoordinatorReciprocalApproval,
	CoordinatorReviewJoinRequestBootstrapGrantInput,
	CoordinatorReviewJoinRequestInput,
	CoordinatorRevokeScopeMembershipInput,
	CoordinatorScope,
	CoordinatorScopeMembership,
	CoordinatorStore,
	CoordinatorUpdateScopeInput,
	CoordinatorUpsertPresenceInput,
} from "./coordinator-store-contract.js";

export const DEFAULT_COORDINATOR_DB_PATH = join(homedir(), ".codemem", "coordinator.sqlite");

function normalizeAddress(address: string): string {
	const value = address.trim();
	if (!value) return "";
	const withScheme = value.includes("://") ? value : `http://${value}`;
	try {
		const url = new URL(withScheme);
		if (!url.hostname) return "";
		if (url.port && (Number(url.port) <= 0 || Number(url.port) > 65535)) return "";
		return url.origin + url.pathname.replace(/\/+$/, "");
	} catch {
		return "";
	}
}

function addressDedupeKey(address: string): string {
	if (!address) return "";
	try {
		const parsed = new URL(address);
		const host = parsed.hostname.toLowerCase();
		if (
			(parsed.protocol === "http:" || parsed.protocol === "") &&
			host &&
			parsed.port &&
			parsed.pathname === "/"
		) {
			return `${host}:${parsed.port}`;
		}
	} catch {}
	return address;
}

function mergeAddresses(existing: string[], candidates: string[]): string[] {
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const address of [...existing, ...candidates]) {
		const cleaned = normalizeAddress(address);
		const key = addressDedupeKey(cleaned);
		if (!cleaned || seen.has(key)) continue;
		seen.add(key);
		normalized.push(cleaned);
	}
	return normalized;
}

function nowISO(): string {
	return new Date().toISOString();
}

function tokenUrlSafe(bytes: number): string {
	return randomBytes(bytes).toString("base64url").replace(/=+$/, "");
}

function rowToRecord<T>(row: unknown): T {
	if (row == null) throw new Error("expected row");
	return row as T;
}

function normalizeBootstrapGrantRequest(
	input: CoordinatorReviewJoinRequestBootstrapGrantInput | null | undefined,
): CoordinatorCreateBootstrapGrantInput | null {
	if (!input) return null;
	const seedDeviceId = String(input.seedDeviceId ?? "").trim();
	const expiresAt = String(input.expiresAt ?? "").trim();
	const createdBy = String(input.createdBy ?? "").trim() || null;
	if (!seedDeviceId || !expiresAt) {
		throw new Error("bootstrapGrant.seedDeviceId and expiresAt are required.");
	}
	return {
		groupId: "",
		seedDeviceId,
		workerDeviceId: "",
		expiresAt,
		createdBy,
	};
}

function normalizeBootstrapGrantInput(
	opts: CoordinatorCreateBootstrapGrantInput,
): CoordinatorCreateBootstrapGrantInput {
	const groupId = String(opts.groupId ?? "").trim();
	const seedDeviceId = String(opts.seedDeviceId ?? "").trim();
	const workerDeviceId = String(opts.workerDeviceId ?? "").trim();
	const expiresAt = String(opts.expiresAt ?? "").trim();
	const createdBy = String(opts.createdBy ?? "").trim() || null;
	if (!groupId || !seedDeviceId || !workerDeviceId || !expiresAt) {
		throw new Error("groupId, seedDeviceId, workerDeviceId, and expiresAt are required.");
	}
	return { groupId, seedDeviceId, workerDeviceId, expiresAt, createdBy };
}

function clean(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function normalizeEpoch(value: number | null | undefined, fallback = 0): number {
	if (value == null) return fallback;
	if (!Number.isFinite(value) || value < 0)
		throw new Error("membershipEpoch must be non-negative.");
	return Math.trunc(value);
}

function normalizeCreateScopeInput(opts: CoordinatorCreateScopeInput) {
	const scopeId = clean(opts.scopeId);
	const label = clean(opts.label);
	if (!scopeId || !label) throw new Error("scopeId and label are required.");
	return {
		scopeId,
		label,
		kind: clean(opts.kind) ?? "user",
		authorityType: clean(opts.authorityType) ?? "coordinator",
		coordinatorId: clean(opts.coordinatorId),
		groupId: clean(opts.groupId),
		manifestIssuerDeviceId: clean(opts.manifestIssuerDeviceId),
		membershipEpoch: normalizeEpoch(opts.membershipEpoch),
		manifestHash: clean(opts.manifestHash),
		status: clean(opts.status) ?? "active",
	};
}

function cleanRequiredUpdate(
	value: string | null | undefined,
	current: string,
	fieldName: string,
): string {
	if (value === undefined) return current;
	const cleaned = clean(value);
	if (!cleaned) throw new Error(`${fieldName} must not be empty.`);
	return cleaned;
}

function cleanNullableUpdate(
	value: string | null | undefined,
	current: string | null,
): string | null {
	return value === undefined ? current : clean(value);
}

function normalizeUpdateScopeInput(opts: CoordinatorUpdateScopeInput, existing: CoordinatorScope) {
	const scopeId = clean(opts.scopeId);
	if (!scopeId) throw new Error("scopeId is required.");
	const requestedEpoch = opts.membershipEpoch == null ? null : normalizeEpoch(opts.membershipEpoch);
	if (requestedEpoch != null && requestedEpoch < existing.membership_epoch) {
		throw new Error("membershipEpoch must not move backwards.");
	}
	return {
		scopeId,
		label: cleanRequiredUpdate(opts.label, existing.label, "label"),
		kind: cleanRequiredUpdate(opts.kind, existing.kind, "kind"),
		authorityType: cleanRequiredUpdate(
			opts.authorityType,
			existing.authority_type,
			"authorityType",
		),
		coordinatorId: cleanNullableUpdate(opts.coordinatorId, existing.coordinator_id),
		groupId: cleanNullableUpdate(opts.groupId, existing.group_id),
		manifestIssuerDeviceId: cleanNullableUpdate(
			opts.manifestIssuerDeviceId,
			existing.manifest_issuer_device_id,
		),
		membershipEpoch: requestedEpoch ?? existing.membership_epoch,
		manifestHash: cleanNullableUpdate(opts.manifestHash, existing.manifest_hash),
		status: cleanRequiredUpdate(opts.status, existing.status, "status"),
	};
}

function normalizeGrantInput(
	opts: CoordinatorGrantScopeMembershipInput,
	scope: CoordinatorScope | null,
	existing: CoordinatorScopeMembership | null,
) {
	const scopeId = clean(opts.scopeId);
	const deviceId = clean(opts.deviceId);
	if (!scopeId || !deviceId) throw new Error("scopeId and deviceId are required.");
	const coordinatorId = clean(opts.coordinatorId);
	const groupId = clean(opts.groupId);
	if (coordinatorId && coordinatorId !== scope?.coordinator_id) {
		throw new Error("membership coordinatorId must match the scope coordinatorId.");
	}
	if (groupId && groupId !== scope?.group_id) {
		throw new Error("membership groupId must match the scope groupId.");
	}
	const requestedEpoch = opts.membershipEpoch == null ? null : normalizeEpoch(opts.membershipEpoch);
	const inheritedEpoch = scope?.membership_epoch ?? 0;
	if (requestedEpoch != null && requestedEpoch < inheritedEpoch) {
		throw new Error("membershipEpoch must not be lower than the scope membershipEpoch.");
	}
	if (requestedEpoch != null && existing) {
		const minimumEpoch =
			existing.status === "revoked" ? existing.membership_epoch + 1 : existing.membership_epoch;
		if (requestedEpoch < minimumEpoch) {
			throw new Error("membershipEpoch must not move backwards.");
		}
	}
	const membershipEpoch =
		requestedEpoch ??
		(existing
			? Math.max(
					inheritedEpoch,
					existing.membership_epoch + (existing.status === "revoked" ? 1 : 0),
				)
			: inheritedEpoch);
	return {
		scopeId,
		deviceId,
		role: clean(opts.role) ?? "member",
		membershipEpoch,
		coordinatorId: scope?.coordinator_id ?? null,
		groupId: scope?.group_id ?? null,
		manifestIssuerDeviceId:
			clean(opts.manifestIssuerDeviceId) ?? scope?.manifest_issuer_device_id ?? null,
		manifestHash: clean(opts.manifestHash) ?? scope?.manifest_hash ?? null,
		signedManifestJson: clean(opts.signedManifestJson),
	};
}

function assertScopeMembershipDeviceEnrolled(
	db: DatabaseType,
	groupId: string | null,
	deviceId: string,
): void {
	if (!groupId) return;
	const row = db
		.prepare("SELECT 1 FROM enrolled_devices WHERE group_id = ? AND device_id = ? AND enabled = 1")
		.get(groupId, deviceId);
	if (!row) {
		throw new Error("device must be enrolled and enabled in the scope group.");
	}
}

function insertBootstrapGrantSync(
	db: DatabaseType,
	opts: CoordinatorCreateBootstrapGrantInput,
): CoordinatorBootstrapGrant {
	const normalized = normalizeBootstrapGrantInput(opts);
	const grantId = tokenUrlSafe(12);
	const createdAt = nowISO();
	db.prepare(`INSERT INTO coordinator_bootstrap_grants(
			grant_id, group_id, seed_device_id, worker_device_id, expires_at, created_at, created_by, revoked_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`).run(
		grantId,
		normalized.groupId,
		normalized.seedDeviceId,
		normalized.workerDeviceId,
		normalized.expiresAt,
		createdAt,
		normalized.createdBy,
	);
	const row = db
		.prepare(`SELECT grant_id, group_id, seed_device_id, worker_device_id, expires_at, created_at, created_by, revoked_at
			 FROM coordinator_bootstrap_grants WHERE grant_id = ?`)
		.get(grantId);
	return rowToRecord<CoordinatorBootstrapGrant>(row);
}

function initializeSchema(db: DatabaseType): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS groups (
			group_id TEXT PRIMARY KEY,
			display_name TEXT,
			archived_at TEXT,
			created_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS enrolled_devices (
			group_id TEXT NOT NULL,
			device_id TEXT NOT NULL,
			public_key TEXT NOT NULL,
			fingerprint TEXT NOT NULL,
			display_name TEXT,
			enabled INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL,
			PRIMARY KEY (group_id, device_id)
		);

		CREATE TABLE IF NOT EXISTS presence_records (
			group_id TEXT NOT NULL,
			device_id TEXT NOT NULL,
			addresses_json TEXT NOT NULL,
			last_seen_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			capabilities_json TEXT NOT NULL DEFAULT '{}',
			PRIMARY KEY (group_id, device_id)
		);

		CREATE TABLE IF NOT EXISTS request_nonces (
			device_id TEXT NOT NULL,
			nonce TEXT NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY (device_id, nonce)
		);

		CREATE TABLE IF NOT EXISTS coordinator_invites (
			invite_id TEXT PRIMARY KEY,
			group_id TEXT NOT NULL,
			token TEXT NOT NULL UNIQUE,
			policy TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			created_at TEXT NOT NULL,
			created_by TEXT,
			team_name_snapshot TEXT,
			revoked_at TEXT
		);

		CREATE TABLE IF NOT EXISTS coordinator_join_requests (
			request_id TEXT PRIMARY KEY,
			group_id TEXT NOT NULL,
			device_id TEXT NOT NULL,
			public_key TEXT NOT NULL,
			fingerprint TEXT NOT NULL,
			display_name TEXT,
			token TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			reviewed_at TEXT,
			reviewed_by TEXT
		);

		CREATE TABLE IF NOT EXISTS coordinator_reciprocal_approvals (
			request_id TEXT PRIMARY KEY,
			group_id TEXT NOT NULL,
			requesting_device_id TEXT NOT NULL,
			requested_device_id TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			resolved_at TEXT
		);

		CREATE TABLE IF NOT EXISTS coordinator_bootstrap_grants (
			grant_id TEXT PRIMARY KEY,
			group_id TEXT NOT NULL,
			seed_device_id TEXT NOT NULL,
			worker_device_id TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			created_at TEXT NOT NULL,
			created_by TEXT,
			revoked_at TEXT
		);

		CREATE TABLE IF NOT EXISTS coordinator_scopes (
			scope_id TEXT PRIMARY KEY,
			label TEXT NOT NULL,
			kind TEXT NOT NULL DEFAULT 'user',
			authority_type TEXT NOT NULL DEFAULT 'coordinator',
			coordinator_id TEXT,
			group_id TEXT,
			manifest_issuer_device_id TEXT,
			membership_epoch INTEGER NOT NULL DEFAULT 0,
			manifest_hash TEXT,
			status TEXT NOT NULL DEFAULT 'active',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_coordinator_scopes_status
			ON coordinator_scopes(status);
		CREATE INDEX IF NOT EXISTS idx_coordinator_scopes_authority_group
			ON coordinator_scopes(coordinator_id, group_id);

		CREATE TABLE IF NOT EXISTS coordinator_scope_memberships (
			scope_id TEXT NOT NULL,
			device_id TEXT NOT NULL,
			role TEXT NOT NULL DEFAULT 'member',
			status TEXT NOT NULL DEFAULT 'active',
			membership_epoch INTEGER NOT NULL DEFAULT 0,
			coordinator_id TEXT,
			group_id TEXT,
			manifest_issuer_device_id TEXT,
			manifest_hash TEXT,
			signed_manifest_json TEXT,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (scope_id, device_id)
		);

		CREATE INDEX IF NOT EXISTS idx_coordinator_scope_memberships_device_status
			ON coordinator_scope_memberships(device_id, status);
		CREATE INDEX IF NOT EXISTS idx_coordinator_scope_memberships_scope_status
			ON coordinator_scope_memberships(scope_id, status);
		CREATE INDEX IF NOT EXISTS idx_coordinator_scope_memberships_authority_group
			ON coordinator_scope_memberships(coordinator_id, group_id);
	`);
	try {
		db.prepare("ALTER TABLE groups ADD COLUMN archived_at TEXT").run();
	} catch {
		// already exists
	}
}

export function connectCoordinator(path?: string): DatabaseType {
	const dbPath = path ?? DEFAULT_COORDINATOR_DB_PATH;
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new Database(dbPath);
	db.pragma("foreign_keys = ON");
	db.pragma("busy_timeout = 5000");
	db.pragma("journal_mode = WAL");
	db.pragma("synchronous = NORMAL");
	initializeSchema(db);
	return db;
}

export class BetterSqliteCoordinatorStore implements CoordinatorStore {
	readonly path: string;
	readonly db: DatabaseType;

	constructor(path?: string) {
		this.path = path ?? DEFAULT_COORDINATOR_DB_PATH;
		this.db = connectCoordinator(this.path);
	}

	private enrollDeviceSync(groupId: string, opts: CoordinatorEnrollDeviceInput): void {
		this.db
			.prepare(`INSERT INTO enrolled_devices(
					group_id, device_id, public_key, fingerprint, display_name, enabled, created_at
				) VALUES (?, ?, ?, ?, ?, 1, ?)
				ON CONFLICT(group_id, device_id) DO UPDATE SET
					public_key = excluded.public_key,
					fingerprint = excluded.fingerprint,
					display_name = excluded.display_name,
					enabled = 1`)
			.run(
				groupId,
				opts.deviceId,
				opts.publicKey,
				opts.fingerprint,
				opts.displayName ?? null,
				nowISO(),
			);
	}

	async close(): Promise<void> {
		this.db.close();
	}

	async createGroup(groupId: string, displayName?: string | null): Promise<void> {
		this.db
			.prepare(
				"INSERT OR IGNORE INTO groups(group_id, display_name, archived_at, created_at) VALUES (?, ?, NULL, ?)",
			)
			.run(groupId, displayName ?? null, nowISO());
	}

	async getGroup(groupId: string): Promise<CoordinatorGroup | null> {
		const row = this.db
			.prepare(
				"SELECT group_id, display_name, archived_at, created_at FROM groups WHERE group_id = ?",
			)
			.get(groupId);
		return row ? rowToRecord<CoordinatorGroup>(row) : null;
	}

	async listGroups(includeArchived = false): Promise<CoordinatorGroup[]> {
		const where = includeArchived ? "" : "WHERE archived_at IS NULL";
		return this.db
			.prepare(
				`SELECT group_id, display_name, archived_at, created_at FROM groups ${where} ORDER BY created_at ASC`,
			)
			.all()
			.map((row) => rowToRecord<CoordinatorGroup>(row));
	}

	async renameGroup(groupId: string, displayName: string): Promise<boolean> {
		const result = this.db
			.prepare("UPDATE groups SET display_name = ? WHERE group_id = ?")
			.run(displayName, groupId);
		return result.changes > 0;
	}

	async archiveGroup(groupId: string, archivedAt = nowISO()): Promise<boolean> {
		const result = this.db
			.prepare("UPDATE groups SET archived_at = ? WHERE group_id = ? AND archived_at IS NULL")
			.run(archivedAt, groupId);
		return result.changes > 0;
	}

	async unarchiveGroup(groupId: string): Promise<boolean> {
		const result = this.db
			.prepare(
				"UPDATE groups SET archived_at = NULL WHERE group_id = ? AND archived_at IS NOT NULL",
			)
			.run(groupId);
		return result.changes > 0;
	}

	async enrollDevice(groupId: string, opts: CoordinatorEnrollDeviceInput): Promise<void> {
		this.enrollDeviceSync(groupId, opts);
	}

	async listEnrolledDevices(
		groupId: string,
		includeDisabled = false,
	): Promise<CoordinatorEnrollment[]> {
		const where = includeDisabled ? "" : "AND enabled = 1";
		return this.db
			.prepare(`SELECT group_id, device_id, public_key, fingerprint, display_name, enabled, created_at
				 FROM enrolled_devices
				 WHERE group_id = ? ${where}
				 ORDER BY created_at ASC, device_id ASC`)
			.all(groupId)
			.map((row) => rowToRecord<CoordinatorEnrollment>(row));
	}

	async getEnrollment(groupId: string, deviceId: string): Promise<CoordinatorEnrollment | null> {
		const row = this.db
			.prepare(`SELECT group_id, device_id, public_key, fingerprint, display_name, enabled, created_at
				 FROM enrolled_devices
				 WHERE group_id = ? AND device_id = ? AND enabled = 1`)
			.get(groupId, deviceId);
		return row ? rowToRecord<CoordinatorEnrollment>(row) : null;
	}

	async renameDevice(groupId: string, deviceId: string, displayName: string): Promise<boolean> {
		const result = this.db
			.prepare(`UPDATE enrolled_devices SET display_name = ?
				 WHERE group_id = ? AND device_id = ?`)
			.run(displayName, groupId, deviceId);
		return result.changes > 0;
	}

	async setDeviceEnabled(groupId: string, deviceId: string, enabled: boolean): Promise<boolean> {
		const result = this.db
			.prepare(`UPDATE enrolled_devices SET enabled = ?
				 WHERE group_id = ? AND device_id = ?`)
			.run(enabled ? 1 : 0, groupId, deviceId);
		return result.changes > 0;
	}

	async removeDevice(groupId: string, deviceId: string): Promise<boolean> {
		this.db
			.prepare("DELETE FROM presence_records WHERE group_id = ? AND device_id = ?")
			.run(groupId, deviceId);
		this.db
			.prepare(
				"DELETE FROM coordinator_reciprocal_approvals WHERE group_id = ? AND (requesting_device_id = ? OR requested_device_id = ?)",
			)
			.run(groupId, deviceId, deviceId);
		const result = this.db
			.prepare("DELETE FROM enrolled_devices WHERE group_id = ? AND device_id = ?")
			.run(groupId, deviceId);
		return result.changes > 0;
	}

	async recordNonce(deviceId: string, nonce: string, createdAt: string): Promise<boolean> {
		try {
			this.db
				.prepare("INSERT INTO request_nonces(device_id, nonce, created_at) VALUES (?, ?, ?)")
				.run(deviceId, nonce, createdAt);
			return true;
		} catch {
			return false;
		}
	}

	async cleanupNonces(cutoff: string): Promise<void> {
		this.db.prepare("DELETE FROM request_nonces WHERE created_at < ?").run(cutoff);
	}

	async createInvite(opts: CoordinatorCreateInviteInput): Promise<CoordinatorInvite> {
		const now = nowISO();
		const inviteId = tokenUrlSafe(12);
		const token = tokenUrlSafe(24);
		const group = await this.getGroup(opts.groupId);
		this.db
			.prepare(`INSERT INTO coordinator_invites(
					invite_id, group_id, token, policy, expires_at, created_at, created_by, team_name_snapshot, revoked_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
			.run(
				inviteId,
				opts.groupId,
				token,
				opts.policy,
				opts.expiresAt,
				now,
				opts.createdBy ?? null,
				group?.display_name ?? null,
			);
		const row = this.db
			.prepare(`SELECT invite_id, group_id, token, policy, expires_at, created_at, created_by, team_name_snapshot, revoked_at
				 FROM coordinator_invites WHERE invite_id = ?`)
			.get(inviteId);
		return rowToRecord<CoordinatorInvite>(row);
	}

	async getInviteByToken(token: string): Promise<CoordinatorInvite | null> {
		const row = this.db
			.prepare(`SELECT invite_id, group_id, token, policy, expires_at, created_at, created_by, team_name_snapshot, revoked_at
				 FROM coordinator_invites
				 WHERE token = ?
				   AND revoked_at IS NULL
				   AND expires_at > ?`)
			.get(token, new Date().toISOString());
		return row ? rowToRecord<CoordinatorInvite>(row) : null;
	}

	async listInvites(groupId: string): Promise<CoordinatorInvite[]> {
		return this.db
			.prepare(`SELECT invite_id, group_id, token, policy, expires_at, created_at, created_by, team_name_snapshot, revoked_at
				 FROM coordinator_invites WHERE group_id = ?
				 ORDER BY created_at DESC`)
			.all(groupId)
			.map((row) => rowToRecord<CoordinatorInvite>(row));
	}

	async createJoinRequest(
		opts: CoordinatorCreateJoinRequestInput,
	): Promise<CoordinatorJoinRequest> {
		const now = nowISO();
		const requestId = tokenUrlSafe(12);
		this.db
			.prepare(`INSERT INTO coordinator_join_requests(
					request_id, group_id, device_id, public_key, fingerprint, display_name, token, status, created_at, reviewed_at, reviewed_by
				) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL)`)
			.run(
				requestId,
				opts.groupId,
				opts.deviceId,
				opts.publicKey,
				opts.fingerprint,
				opts.displayName ?? null,
				opts.token,
				now,
			);
		const row = this.db
			.prepare(`SELECT request_id, group_id, device_id, public_key, fingerprint, display_name, token, status, created_at, reviewed_at, reviewed_by
				 FROM coordinator_join_requests WHERE request_id = ?`)
			.get(requestId);
		return rowToRecord<CoordinatorJoinRequest>(row);
	}

	async listJoinRequests(groupId: string, status = "pending"): Promise<CoordinatorJoinRequest[]> {
		return this.db
			.prepare(`SELECT request_id, group_id, device_id, public_key, fingerprint, display_name, token, status, created_at, reviewed_at, reviewed_by
				 FROM coordinator_join_requests
				 WHERE group_id = ? AND status = ?
				 ORDER BY created_at ASC, device_id ASC`)
			.all(groupId, status)
			.map((row) => rowToRecord<CoordinatorJoinRequest>(row));
	}

	async reviewJoinRequest(
		opts: CoordinatorReviewJoinRequestInput,
	): Promise<CoordinatorJoinRequestReviewResult | null> {
		const row = this.db
			.prepare(`SELECT request_id, group_id, device_id, public_key, fingerprint, display_name, token, status,
				        created_at, reviewed_at, reviewed_by
				 FROM coordinator_join_requests WHERE request_id = ?`)
			.get(opts.requestId) as (CoordinatorJoinRequest & { public_key: string }) | undefined;
		if (!row) return null;
		if (row.status !== "pending")
			return { ...rowToRecord<CoordinatorJoinRequest>(row), _no_transition: true };
		const bootstrapGrantRequest = normalizeBootstrapGrantRequest(opts.bootstrapGrant);
		const result = this.db.transaction(() => {
			const reviewedAt = nowISO();
			const nextStatus = opts.approved ? "approved" : "denied";
			let bootstrapGrant: CoordinatorBootstrapGrant | null = null;
			if (opts.approved) {
				this.enrollDeviceSync(row.group_id, {
					deviceId: row.device_id,
					fingerprint: row.fingerprint,
					publicKey: row.public_key,
					displayName: (row.display_name ?? "").trim() || null,
				});
				if (bootstrapGrantRequest) {
					const seedEnrollment = this.db
						.prepare(
							`SELECT device_id FROM enrolled_devices WHERE group_id = ? AND device_id = ? AND enabled = 1`,
						)
						.get(row.group_id, bootstrapGrantRequest.seedDeviceId);
					if (!seedEnrollment) {
						throw new Error("bootstrap grant seed device is not enrolled in the group.");
					}
					if (bootstrapGrantRequest.seedDeviceId === row.device_id) {
						throw new Error("bootstrap grant seed and worker device ids must differ.");
					}
					const bootstrapGrantInput = {
						...bootstrapGrantRequest,
						groupId: row.group_id,
						workerDeviceId: row.device_id,
					};
					bootstrapGrant = insertBootstrapGrantSync(this.db, bootstrapGrantInput);
				}
			}
			this.db
				.prepare(`UPDATE coordinator_join_requests
					 SET status = ?, reviewed_at = ?, reviewed_by = ?
					 WHERE request_id = ?`)
				.run(nextStatus, reviewedAt, opts.reviewedBy ?? null, opts.requestId);
			const updated = this.db
				.prepare(`SELECT request_id, group_id, device_id, public_key, fingerprint, display_name, token, status, created_at, reviewed_at, reviewed_by
					 FROM coordinator_join_requests WHERE request_id = ?`)
				.get(opts.requestId);
			return {
				updated: updated ? rowToRecord<CoordinatorJoinRequestReviewResult>(updated) : null,
				bootstrapGrant,
			};
		})();
		if (!result.updated) return null;
		return {
			...result.updated,
			bootstrap_grant: result.bootstrapGrant,
		};
	}

	async createReciprocalApproval(
		opts: CoordinatorCreateReciprocalApprovalInput,
	): Promise<CoordinatorReciprocalApproval> {
		const groupId = String(opts.groupId ?? "").trim();
		const requestingDeviceId = String(opts.requestingDeviceId ?? "").trim();
		const requestedDeviceId = String(opts.requestedDeviceId ?? "").trim();
		if (!groupId || !requestingDeviceId || !requestedDeviceId) {
			throw new Error("groupId, requestingDeviceId, and requestedDeviceId are required.");
		}
		if (requestingDeviceId === requestedDeviceId) {
			throw new Error("requesting and requested device ids must differ.");
		}
		return this.db.transaction(() => {
			const now = nowISO();
			const existing = this.db
				.prepare(`SELECT request_id, group_id, requesting_device_id, requested_device_id, status, created_at, resolved_at
					 FROM coordinator_reciprocal_approvals
					 WHERE group_id = ?
					   AND requesting_device_id = ?
					   AND requested_device_id = ?
					   AND status = 'pending'
					 ORDER BY created_at DESC
					 LIMIT 1`)
				.get(groupId, requestingDeviceId, requestedDeviceId);
			if (existing) {
				return rowToRecord<CoordinatorReciprocalApproval>(existing);
			}
			const reverse = this.db
				.prepare(`SELECT request_id, group_id, requesting_device_id, requested_device_id, status, created_at, resolved_at
					 FROM coordinator_reciprocal_approvals
					 WHERE group_id = ?
					   AND requesting_device_id = ?
					   AND requested_device_id = ?
					   AND status = 'pending'
					 ORDER BY created_at DESC
					 LIMIT 1`)
				.get(groupId, requestedDeviceId, requestingDeviceId);
			if (reverse) {
				this.db
					.prepare(`UPDATE coordinator_reciprocal_approvals
						 SET status = 'completed', resolved_at = ?
						 WHERE request_id = ?`)
					.run(now, (reverse as CoordinatorReciprocalApproval).request_id);
				const completed = this.db
					.prepare(`SELECT request_id, group_id, requesting_device_id, requested_device_id, status, created_at, resolved_at
						 FROM coordinator_reciprocal_approvals WHERE request_id = ?`)
					.get((reverse as CoordinatorReciprocalApproval).request_id);
				return rowToRecord<CoordinatorReciprocalApproval>(completed);
			}
			const requestId = tokenUrlSafe(12);
			this.db
				.prepare(`INSERT INTO coordinator_reciprocal_approvals(
						request_id, group_id, requesting_device_id, requested_device_id, status, created_at, resolved_at
					) VALUES (?, ?, ?, ?, 'pending', ?, NULL)`)
				.run(requestId, groupId, requestingDeviceId, requestedDeviceId, now);
			const created = this.db
				.prepare(`SELECT request_id, group_id, requesting_device_id, requested_device_id, status, created_at, resolved_at
					 FROM coordinator_reciprocal_approvals WHERE request_id = ?`)
				.get(requestId);
			return rowToRecord<CoordinatorReciprocalApproval>(created);
		})();
	}

	async createBootstrapGrant(
		opts: CoordinatorCreateBootstrapGrantInput,
	): Promise<CoordinatorBootstrapGrant> {
		return insertBootstrapGrantSync(this.db, opts);
	}

	private getScopeSync(scopeId: string): CoordinatorScope | null {
		const row = this.db
			.prepare(`SELECT scope_id, label, kind, authority_type, coordinator_id, group_id,
					manifest_issuer_device_id, membership_epoch, manifest_hash, status, created_at, updated_at
				 FROM coordinator_scopes WHERE scope_id = ?`)
			.get(scopeId);
		return row ? rowToRecord<CoordinatorScope>(row) : null;
	}

	private getScopeMembershipSync(
		scopeId: string,
		deviceId: string,
	): CoordinatorScopeMembership | null {
		const row = this.db
			.prepare(`SELECT scope_id, device_id, role, status, membership_epoch, coordinator_id, group_id,
					manifest_issuer_device_id, manifest_hash, signed_manifest_json, updated_at
				 FROM coordinator_scope_memberships
				 WHERE scope_id = ? AND device_id = ?`)
			.get(scopeId, deviceId);
		return row ? rowToRecord<CoordinatorScopeMembership>(row) : null;
	}

	async createScope(opts: CoordinatorCreateScopeInput): Promise<CoordinatorScope> {
		const normalized = normalizeCreateScopeInput(opts);
		if (this.getScopeSync(normalized.scopeId)) throw new Error("scopeId already exists.");
		const now = nowISO();
		this.db
			.prepare(`INSERT INTO coordinator_scopes(
					scope_id, label, kind, authority_type, coordinator_id, group_id,
					manifest_issuer_device_id, membership_epoch, manifest_hash, status, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(
				normalized.scopeId,
				normalized.label,
				normalized.kind,
				normalized.authorityType,
				normalized.coordinatorId,
				normalized.groupId,
				normalized.manifestIssuerDeviceId,
				normalized.membershipEpoch,
				normalized.manifestHash,
				normalized.status,
				now,
				now,
			);
		const scope = this.getScopeSync(normalized.scopeId);
		if (!scope) throw new Error("scope insert returned no row");
		return scope;
	}

	async updateScope(opts: CoordinatorUpdateScopeInput): Promise<CoordinatorScope | null> {
		const scopeId = clean(opts.scopeId);
		const existing = scopeId ? this.getScopeSync(scopeId) : null;
		if (!existing) return null;
		const normalized = normalizeUpdateScopeInput(opts, existing);
		this.db
			.prepare(`UPDATE coordinator_scopes
				 SET label = ?,
					 kind = ?,
					 authority_type = ?,
					 coordinator_id = ?,
					 group_id = ?,
					 manifest_issuer_device_id = ?,
					 membership_epoch = ?,
					 manifest_hash = ?,
					 status = ?,
					 updated_at = ?
				 WHERE scope_id = ?`)
			.run(
				normalized.label,
				normalized.kind,
				normalized.authorityType,
				normalized.coordinatorId,
				normalized.groupId,
				normalized.manifestIssuerDeviceId,
				normalized.membershipEpoch,
				normalized.manifestHash,
				normalized.status,
				nowISO(),
				normalized.scopeId,
			);
		return this.getScopeSync(normalized.scopeId);
	}

	async listScopes(opts: CoordinatorListScopesInput = {}): Promise<CoordinatorScope[]> {
		const where: string[] = [];
		const params: unknown[] = [];
		const coordinatorId = clean(opts.coordinatorId);
		const groupId = clean(opts.groupId);
		const status = clean(opts.status);
		if (coordinatorId) {
			where.push("coordinator_id = ?");
			params.push(coordinatorId);
		}
		if (groupId) {
			where.push("group_id = ?");
			params.push(groupId);
		}
		if (status) {
			where.push("status = ?");
			params.push(status);
		} else if (!opts.includeInactive) {
			where.push("status = 'active'");
		}
		const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
		return this.db
			.prepare(`SELECT scope_id, label, kind, authority_type, coordinator_id, group_id,
					manifest_issuer_device_id, membership_epoch, manifest_hash, status, created_at, updated_at
				 FROM coordinator_scopes ${whereSql}
				 ORDER BY coordinator_id ASC, group_id ASC, scope_id ASC`)
			.all(...params)
			.map((row) => rowToRecord<CoordinatorScope>(row));
	}

	async grantScopeMembership(
		opts: CoordinatorGrantScopeMembershipInput,
	): Promise<CoordinatorScopeMembership> {
		const scopeId = clean(opts.scopeId);
		const deviceId = clean(opts.deviceId);
		const scope = scopeId ? this.getScopeSync(scopeId) : null;
		if (!scope) throw new Error("scopeId must reference an existing scope.");
		const existing = scopeId && deviceId ? this.getScopeMembershipSync(scopeId, deviceId) : null;
		const normalized = normalizeGrantInput(opts, scope, existing);
		assertScopeMembershipDeviceEnrolled(this.db, normalized.groupId, normalized.deviceId);
		const now = nowISO();
		this.db
			.prepare(`INSERT INTO coordinator_scope_memberships(
					scope_id, device_id, role, status, membership_epoch, coordinator_id, group_id,
					manifest_issuer_device_id, manifest_hash, signed_manifest_json, updated_at
				) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(scope_id, device_id) DO UPDATE SET
					role = excluded.role,
					status = 'active',
					membership_epoch = excluded.membership_epoch,
					coordinator_id = excluded.coordinator_id,
					group_id = excluded.group_id,
					manifest_issuer_device_id = excluded.manifest_issuer_device_id,
					manifest_hash = excluded.manifest_hash,
					signed_manifest_json = excluded.signed_manifest_json,
					updated_at = excluded.updated_at
				WHERE excluded.membership_epoch > coordinator_scope_memberships.membership_epoch
				   OR (
					excluded.membership_epoch = coordinator_scope_memberships.membership_epoch
					AND coordinator_scope_memberships.status != 'revoked'
				   )`)
			.run(
				normalized.scopeId,
				normalized.deviceId,
				normalized.role,
				normalized.membershipEpoch,
				normalized.coordinatorId,
				normalized.groupId,
				normalized.manifestIssuerDeviceId,
				normalized.manifestHash,
				normalized.signedManifestJson,
				now,
			);
		const row = this.db
			.prepare(`SELECT scope_id, device_id, role, status, membership_epoch, coordinator_id, group_id,
					manifest_issuer_device_id, manifest_hash, signed_manifest_json, updated_at
				 FROM coordinator_scope_memberships
				 WHERE scope_id = ? AND device_id = ?`)
			.get(normalized.scopeId, normalized.deviceId);
		return rowToRecord<CoordinatorScopeMembership>(row);
	}

	async revokeScopeMembership(opts: CoordinatorRevokeScopeMembershipInput): Promise<boolean> {
		const scopeId = clean(opts.scopeId);
		const deviceId = clean(opts.deviceId);
		if (!scopeId || !deviceId) throw new Error("scopeId and deviceId are required.");
		const membershipEpoch =
			opts.membershipEpoch == null ? null : normalizeEpoch(opts.membershipEpoch);
		const existing = this.getScopeMembershipSync(scopeId, deviceId);
		if (membershipEpoch != null && existing && membershipEpoch <= existing.membership_epoch) {
			throw new Error("membershipEpoch must increase on revoke.");
		}
		const result = this.db
			.prepare(`UPDATE coordinator_scope_memberships
				 SET status = 'revoked',
					 membership_epoch = CASE WHEN ? IS NULL THEN membership_epoch + 1 ELSE ? END,
					 manifest_hash = COALESCE(?, manifest_hash),
					 signed_manifest_json = COALESCE(?, signed_manifest_json),
					 updated_at = ?
				 WHERE scope_id = ? AND device_id = ?`)
			.run(
				membershipEpoch,
				membershipEpoch,
				clean(opts.manifestHash),
				clean(opts.signedManifestJson),
				nowISO(),
				scopeId,
				deviceId,
			);
		return result.changes > 0;
	}

	async listScopeMemberships(
		scopeId: string,
		includeRevoked = false,
	): Promise<CoordinatorScopeMembership[]> {
		const normalizedScopeId = clean(scopeId);
		if (!normalizedScopeId) throw new Error("scopeId is required.");
		const statusWhere = includeRevoked ? "" : "AND status = 'active'";
		return this.db
			.prepare(`SELECT scope_id, device_id, role, status, membership_epoch, coordinator_id, group_id,
					manifest_issuer_device_id, manifest_hash, signed_manifest_json, updated_at
				 FROM coordinator_scope_memberships
				 WHERE scope_id = ? ${statusWhere}
				 ORDER BY device_id ASC`)
			.all(normalizedScopeId)
			.map((row) => rowToRecord<CoordinatorScopeMembership>(row));
	}

	async getBootstrapGrant(grantId: string): Promise<CoordinatorBootstrapGrant | null> {
		const row = this.db
			.prepare(`SELECT grant_id, group_id, seed_device_id, worker_device_id, expires_at, created_at, created_by, revoked_at
				 FROM coordinator_bootstrap_grants WHERE grant_id = ?`)
			.get(grantId);
		return row ? rowToRecord<CoordinatorBootstrapGrant>(row) : null;
	}

	async listBootstrapGrants(groupId: string): Promise<CoordinatorBootstrapGrant[]> {
		return this.db
			.prepare(`SELECT grant_id, group_id, seed_device_id, worker_device_id, expires_at, created_at, created_by, revoked_at
				 FROM coordinator_bootstrap_grants WHERE group_id = ?
				 ORDER BY created_at DESC, grant_id DESC`)
			.all(groupId)
			.map((row) => rowToRecord<CoordinatorBootstrapGrant>(row));
	}

	async revokeBootstrapGrant(grantId: string, revokedAt = nowISO()): Promise<boolean> {
		const result = this.db
			.prepare(`UPDATE coordinator_bootstrap_grants
				 SET revoked_at = COALESCE(revoked_at, ?)
				 WHERE grant_id = ?`)
			.run(revokedAt, grantId);
		return result.changes > 0;
	}

	async listReciprocalApprovals(
		opts: CoordinatorListReciprocalApprovalsInput,
	): Promise<CoordinatorReciprocalApproval[]> {
		const directionColumn =
			opts.direction === "incoming" ? "requested_device_id" : "requesting_device_id";
		const status = String(opts.status ?? "pending").trim() || "pending";
		return this.db
			.prepare(`SELECT request_id, group_id, requesting_device_id, requested_device_id, status, created_at, resolved_at
				 FROM coordinator_reciprocal_approvals
				 WHERE group_id = ? AND ${directionColumn} = ? AND status = ?
				 ORDER BY created_at ASC, request_id ASC`)
			.all(opts.groupId, opts.deviceId, status)
			.map((row) => rowToRecord<CoordinatorReciprocalApproval>(row));
	}

	async upsertPresence(opts: CoordinatorUpsertPresenceInput): Promise<CoordinatorPresenceRecord> {
		const now = new Date();
		const expiresAt = new Date(now.getTime() + opts.ttlS * 1000).toISOString();
		const normalized = mergeAddresses([], opts.addresses);
		this.db
			.prepare(`INSERT INTO presence_records(group_id, device_id, addresses_json, last_seen_at, expires_at, capabilities_json)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(group_id, device_id) DO UPDATE SET
					addresses_json = excluded.addresses_json,
					last_seen_at = excluded.last_seen_at,
					expires_at = excluded.expires_at,
					capabilities_json = excluded.capabilities_json`)
			.run(
				opts.groupId,
				opts.deviceId,
				JSON.stringify(normalized),
				now.toISOString(),
				expiresAt,
				JSON.stringify(opts.capabilities ?? {}),
			);
		return {
			group_id: opts.groupId,
			device_id: opts.deviceId,
			addresses: normalized,
			expires_at: expiresAt,
		};
	}

	async listGroupPeers(
		groupId: string,
		requestingDeviceId: string,
	): Promise<CoordinatorPeerRecord[]> {
		const now = new Date();
		const rows = this.db
			.prepare(`SELECT enrolled_devices.device_id, enrolled_devices.public_key, enrolled_devices.fingerprint, enrolled_devices.display_name,
					presence_records.addresses_json, presence_records.last_seen_at, presence_records.expires_at,
					presence_records.capabilities_json
				 FROM enrolled_devices
				 LEFT JOIN presence_records
				   ON presence_records.group_id = enrolled_devices.group_id
				  AND presence_records.device_id = enrolled_devices.device_id
				 WHERE enrolled_devices.group_id = ?
				   AND enrolled_devices.enabled = 1
				   AND enrolled_devices.device_id != ?
				 ORDER BY enrolled_devices.device_id ASC`)
			.all(groupId, requestingDeviceId) as Record<string, unknown>[];
		return rows.map((row) => {
			const expiresRaw = String(row.expires_at ?? "").trim();
			let stale = true;
			if (expiresRaw) {
				const expiresAt = new Date(expiresRaw);
				stale = Number.isNaN(expiresAt.getTime()) || expiresAt <= now;
			}
			const addresses = stale
				? []
				: mergeAddresses([], JSON.parse((row.addresses_json as string) || "[]") as string[]);
			return {
				device_id: String(row.device_id ?? ""),
				public_key: String(row.public_key ?? ""),
				fingerprint: String(row.fingerprint ?? ""),
				display_name: (row.display_name as string | null) ?? null,
				addresses,
				last_seen_at: (row.last_seen_at as string | null) ?? null,
				expires_at: (row.expires_at as string | null) ?? null,
				stale,
				capabilities: JSON.parse((row.capabilities_json as string) || "{}") as Record<
					string,
					unknown
				>,
			} satisfies CoordinatorPeerRecord;
		});
	}
}
