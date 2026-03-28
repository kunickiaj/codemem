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
	CoordinatorCreateInviteInput,
	CoordinatorCreateJoinRequestInput,
	CoordinatorEnrollDeviceInput,
	CoordinatorEnrollment,
	CoordinatorGroup,
	CoordinatorInvite,
	CoordinatorJoinRequest,
	CoordinatorJoinRequestReviewResult,
	CoordinatorPeerRecord,
	CoordinatorPresenceRecord,
	CoordinatorReviewJoinRequestInput,
	CoordinatorStore,
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

function initializeSchema(db: DatabaseType): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS groups (
			group_id TEXT PRIMARY KEY,
			display_name TEXT,
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
	`);
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

	close(): void {
		this.db.close();
	}

	createGroup(groupId: string, displayName?: string | null): void {
		this.db
			.prepare("INSERT OR IGNORE INTO groups(group_id, display_name, created_at) VALUES (?, ?, ?)")
			.run(groupId, displayName ?? null, nowISO());
	}

	getGroup(groupId: string): CoordinatorGroup | null {
		const row = this.db
			.prepare("SELECT group_id, display_name, created_at FROM groups WHERE group_id = ?")
			.get(groupId);
		return row ? rowToRecord<CoordinatorGroup>(row) : null;
	}

	listGroups(): CoordinatorGroup[] {
		return this.db
			.prepare("SELECT group_id, display_name, created_at FROM groups ORDER BY created_at ASC")
			.all()
			.map((row) => rowToRecord<CoordinatorGroup>(row));
	}

	enrollDevice(groupId: string, opts: CoordinatorEnrollDeviceInput): void {
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

	listEnrolledDevices(groupId: string, includeDisabled = false): CoordinatorEnrollment[] {
		const where = includeDisabled ? "" : "AND enabled = 1";
		return this.db
			.prepare(`SELECT group_id, device_id, fingerprint, display_name, enabled, created_at
				 FROM enrolled_devices
				 WHERE group_id = ? ${where}
				 ORDER BY created_at ASC, device_id ASC`)
			.all(groupId)
			.map((row) => rowToRecord<CoordinatorEnrollment>(row));
	}

	getEnrollment(groupId: string, deviceId: string): CoordinatorEnrollment | null {
		const row = this.db
			.prepare(`SELECT device_id, public_key, fingerprint, display_name
				 FROM enrolled_devices
				 WHERE group_id = ? AND device_id = ? AND enabled = 1`)
			.get(groupId, deviceId);
		return row ? rowToRecord<CoordinatorEnrollment>(row) : null;
	}

	renameDevice(groupId: string, deviceId: string, displayName: string): boolean {
		const result = this.db
			.prepare(`UPDATE enrolled_devices SET display_name = ?
				 WHERE group_id = ? AND device_id = ?`)
			.run(displayName, groupId, deviceId);
		return result.changes > 0;
	}

	setDeviceEnabled(groupId: string, deviceId: string, enabled: boolean): boolean {
		const result = this.db
			.prepare(`UPDATE enrolled_devices SET enabled = ?
				 WHERE group_id = ? AND device_id = ?`)
			.run(enabled ? 1 : 0, groupId, deviceId);
		return result.changes > 0;
	}

	removeDevice(groupId: string, deviceId: string): boolean {
		this.db
			.prepare("DELETE FROM presence_records WHERE group_id = ? AND device_id = ?")
			.run(groupId, deviceId);
		const result = this.db
			.prepare("DELETE FROM enrolled_devices WHERE group_id = ? AND device_id = ?")
			.run(groupId, deviceId);
		return result.changes > 0;
	}

	recordNonce(deviceId: string, nonce: string, createdAt: string): boolean {
		try {
			this.db
				.prepare("INSERT INTO request_nonces(device_id, nonce, created_at) VALUES (?, ?, ?)")
				.run(deviceId, nonce, createdAt);
			return true;
		} catch {
			return false;
		}
	}

	cleanupNonces(cutoff: string): void {
		this.db.prepare("DELETE FROM request_nonces WHERE created_at < ?").run(cutoff);
	}

	createInvite(opts: CoordinatorCreateInviteInput): CoordinatorInvite {
		const now = nowISO();
		const inviteId = tokenUrlSafe(12);
		const token = tokenUrlSafe(24);
		const group = this.getGroup(opts.groupId);
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

	getInviteByToken(token: string): CoordinatorInvite | null {
		const row = this.db
			.prepare(`SELECT invite_id, group_id, token, policy, expires_at, created_at, created_by, team_name_snapshot, revoked_at
				 FROM coordinator_invites
				 WHERE token = ?
				   AND revoked_at IS NULL
				   AND expires_at > ?`)
			.get(token, new Date().toISOString());
		return row ? rowToRecord<CoordinatorInvite>(row) : null;
	}

	listInvites(groupId: string): CoordinatorInvite[] {
		return this.db
			.prepare(`SELECT invite_id, group_id, token, policy, expires_at, created_at, created_by, team_name_snapshot, revoked_at
				 FROM coordinator_invites WHERE group_id = ?
				 ORDER BY created_at DESC`)
			.all(groupId)
			.map((row) => rowToRecord<CoordinatorInvite>(row));
	}

	createJoinRequest(opts: CoordinatorCreateJoinRequestInput): CoordinatorJoinRequest {
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
			.prepare(`SELECT request_id, group_id, device_id, fingerprint, display_name, token, status, created_at, reviewed_at, reviewed_by
				 FROM coordinator_join_requests WHERE request_id = ?`)
			.get(requestId);
		return rowToRecord<CoordinatorJoinRequest>(row);
	}

	listJoinRequests(groupId: string, status = "pending"): CoordinatorJoinRequest[] {
		return this.db
			.prepare(`SELECT request_id, group_id, device_id, fingerprint, display_name, token, status, created_at, reviewed_at, reviewed_by
				 FROM coordinator_join_requests
				 WHERE group_id = ? AND status = ?
				 ORDER BY created_at ASC, device_id ASC`)
			.all(groupId, status)
			.map((row) => rowToRecord<CoordinatorJoinRequest>(row));
	}

	reviewJoinRequest(
		opts: CoordinatorReviewJoinRequestInput,
	): CoordinatorJoinRequestReviewResult | null {
		const row = this.db
			.prepare(`SELECT request_id, group_id, device_id, public_key, fingerprint, display_name, token, status,
				        created_at, reviewed_at, reviewed_by
				 FROM coordinator_join_requests WHERE request_id = ?`)
			.get(opts.requestId) as (CoordinatorJoinRequest & { public_key: string }) | undefined;
		if (!row) return null;
		if (row.status !== "pending")
			return { ...rowToRecord<CoordinatorJoinRequest>(row), _no_transition: true };
		return this.db.transaction(() => {
			const reviewedAt = nowISO();
			const nextStatus = opts.approved ? "approved" : "denied";
			if (opts.approved) {
				this.enrollDevice(row.group_id, {
					deviceId: row.device_id,
					fingerprint: row.fingerprint,
					publicKey: row.public_key,
					displayName: (row.display_name ?? "").trim() || null,
				});
			}
			this.db
				.prepare(`UPDATE coordinator_join_requests
					 SET status = ?, reviewed_at = ?, reviewed_by = ?
					 WHERE request_id = ?`)
				.run(nextStatus, reviewedAt, opts.reviewedBy ?? null, opts.requestId);
			const updated = this.db
				.prepare(`SELECT request_id, group_id, device_id, fingerprint, display_name, token, status, created_at, reviewed_at, reviewed_by
					 FROM coordinator_join_requests WHERE request_id = ?`)
				.get(opts.requestId);
			return updated ? rowToRecord<CoordinatorJoinRequestReviewResult>(updated) : null;
		})();
	}

	upsertPresence(opts: CoordinatorUpsertPresenceInput): CoordinatorPresenceRecord {
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

	listGroupPeers(groupId: string, requestingDeviceId: string): CoordinatorPeerRecord[] {
		const now = new Date();
		const rows = this.db
			.prepare(`SELECT enrolled_devices.device_id, enrolled_devices.fingerprint, enrolled_devices.display_name,
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
