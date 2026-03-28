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

interface D1RunResultLike {
	meta?: {
		changes?: number;
	};
}

/**
 * Experimental D1 adapter scaffold.
 *
 * This is intentionally internal for now while the sync-only store contract
 * is still being validated against an async backend shape.
 */

export interface D1PreparedStatementLike {
	bind(...values: unknown[]): D1PreparedStatementLike;
	first<T = unknown>(): Promise<T | null>;
	run(): Promise<unknown>;
	all<T = unknown>(): Promise<{ results?: T[] }>;
	raw<T = unknown>(): Promise<T[]>;
}

export interface D1DatabaseLike {
	prepare(query: string): D1PreparedStatementLike;
	batch?(statements: D1PreparedStatementLike[]): Promise<unknown[]>;
	exec?(query: string): Promise<unknown>;
}

function notImplemented(method: string): never {
	throw new Error(`D1CoordinatorStore.${method} is not implemented yet.`);
}

function rowToRecord<T>(row: unknown): T {
	if (row == null) throw new Error("expected row");
	return row as T;
}

function nowISO(): string {
	return new Date().toISOString();
}

function tokenUrlSafe(bytes: number): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
	const random = new Uint8Array(bytes);
	globalThis.crypto.getRandomValues(random);
	const output: string[] = [];
	for (const byte of random) {
		output.push(alphabet[byte % alphabet.length] ?? "A");
	}
	return output.join("");
}

async function allRows<T>(statement: D1PreparedStatementLike): Promise<T[]> {
	const result = await statement.all<T>();
	return Array.isArray(result?.results) ? result.results : [];
}

async function firstRow<T>(statement: D1PreparedStatementLike): Promise<T | null> {
	return await statement.first<T>();
}

async function runChanges(statement: D1PreparedStatementLike): Promise<number> {
	const result = (await statement.run()) as D1RunResultLike | undefined;
	return Number(result?.meta?.changes ?? 0);
}

export class D1CoordinatorStore implements CoordinatorStore {
	readonly db: D1DatabaseLike;

	constructor(db: D1DatabaseLike) {
		this.db = db;
	}

	async close(): Promise<void> {
		// No-op for D1 bindings.
	}

	async createGroup(_groupId: string, _displayName?: string | null): Promise<void> {
		await this.db
			.prepare("INSERT OR IGNORE INTO groups(group_id, display_name, created_at) VALUES (?, ?, ?)")
			.bind(_groupId, _displayName ?? null, nowISO())
			.run();
	}

	async getGroup(_groupId: string): Promise<CoordinatorGroup | null> {
		const row = await firstRow<CoordinatorGroup>(
			this.db
				.prepare("SELECT group_id, display_name, created_at FROM groups WHERE group_id = ?")
				.bind(_groupId),
		);
		return row ? rowToRecord<CoordinatorGroup>(row) : null;
	}

	async listGroups(): Promise<CoordinatorGroup[]> {
		return (
			await allRows<CoordinatorGroup>(
				this.db.prepare(
					"SELECT group_id, display_name, created_at FROM groups ORDER BY created_at ASC",
				),
			)
		).map((row) => rowToRecord<CoordinatorGroup>(row));
	}

	async enrollDevice(_groupId: string, _opts: CoordinatorEnrollDeviceInput): Promise<void> {
		await this.db
			.prepare(`INSERT INTO enrolled_devices(
				group_id, device_id, public_key, fingerprint, display_name, enabled, created_at
			) VALUES (?, ?, ?, ?, ?, 1, ?)
			ON CONFLICT(group_id, device_id) DO UPDATE SET
				public_key = excluded.public_key,
				fingerprint = excluded.fingerprint,
				display_name = excluded.display_name,
				enabled = 1`)
			.bind(
				_groupId,
				_opts.deviceId,
				_opts.publicKey,
				_opts.fingerprint,
				_opts.displayName ?? null,
				nowISO(),
			)
			.run();
	}

	async listEnrolledDevices(
		_groupId: string,
		_includeDisabled?: boolean,
	): Promise<CoordinatorEnrollment[]> {
		const where = _includeDisabled ? "" : "AND enabled = 1";
		return (
			await allRows<CoordinatorEnrollment>(
				this.db
					.prepare(`SELECT group_id, device_id, fingerprint, display_name, enabled, created_at
					 FROM enrolled_devices
					 WHERE group_id = ? ${where}
					 ORDER BY created_at ASC, device_id ASC`)
					.bind(_groupId),
			)
		).map((row) => rowToRecord<CoordinatorEnrollment>(row));
	}

	async getEnrollment(_groupId: string, _deviceId: string): Promise<CoordinatorEnrollment | null> {
		const row = await firstRow<CoordinatorEnrollment>(
			this.db
				.prepare(`SELECT device_id, public_key, fingerprint, display_name
					 FROM enrolled_devices
					 WHERE group_id = ? AND device_id = ? AND enabled = 1`)
				.bind(_groupId, _deviceId),
		);
		return row ? rowToRecord<CoordinatorEnrollment>(row) : null;
	}

	async renameDevice(_groupId: string, _deviceId: string, _displayName: string): Promise<boolean> {
		return (
			(await runChanges(
				this.db
					.prepare(`UPDATE enrolled_devices SET display_name = ?
					 WHERE group_id = ? AND device_id = ?`)
					.bind(_displayName, _groupId, _deviceId),
			)) > 0
		);
	}

	async setDeviceEnabled(_groupId: string, _deviceId: string, _enabled: boolean): Promise<boolean> {
		return (
			(await runChanges(
				this.db
					.prepare(`UPDATE enrolled_devices SET enabled = ?
					 WHERE group_id = ? AND device_id = ?`)
					.bind(_enabled ? 1 : 0, _groupId, _deviceId),
			)) > 0
		);
	}

	async removeDevice(_groupId: string, _deviceId: string): Promise<boolean> {
		await this.db
			.prepare("DELETE FROM presence_records WHERE group_id = ? AND device_id = ?")
			.bind(_groupId, _deviceId)
			.run();
		return (
			(await runChanges(
				this.db
					.prepare("DELETE FROM enrolled_devices WHERE group_id = ? AND device_id = ?")
					.bind(_groupId, _deviceId),
			)) > 0
		);
	}

	async recordNonce(_deviceId: string, _nonce: string, _createdAt: string): Promise<boolean> {
		notImplemented("recordNonce");
	}

	async cleanupNonces(_cutoff: string): Promise<void> {
		notImplemented("cleanupNonces");
	}

	async createInvite(_opts: CoordinatorCreateInviteInput): Promise<CoordinatorInvite> {
		const now = nowISO();
		const inviteId = tokenUrlSafe(12);
		const token = tokenUrlSafe(24);
		const group = await this.getGroup(_opts.groupId);
		await this.db
			.prepare(`INSERT INTO coordinator_invites(
				invite_id, group_id, token, policy, expires_at, created_at, created_by, team_name_snapshot, revoked_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
			.bind(
				inviteId,
				_opts.groupId,
				token,
				_opts.policy,
				_opts.expiresAt,
				now,
				_opts.createdBy ?? null,
				group?.display_name ?? null,
			)
			.run();
		const row = await firstRow<CoordinatorInvite>(
			this.db
				.prepare(`SELECT invite_id, group_id, token, policy, expires_at, created_at, created_by, team_name_snapshot, revoked_at
					 FROM coordinator_invites WHERE invite_id = ?`)
				.bind(inviteId),
		);
		return rowToRecord<CoordinatorInvite>(row);
	}

	async getInviteByToken(_token: string): Promise<CoordinatorInvite | null> {
		const row = await firstRow<CoordinatorInvite>(
			this.db
				.prepare(`SELECT invite_id, group_id, token, policy, expires_at, created_at, created_by, team_name_snapshot, revoked_at
					 FROM coordinator_invites
					 WHERE token = ?
					   AND revoked_at IS NULL
					   AND expires_at > ?`)
				.bind(_token, nowISO()),
		);
		return row ? rowToRecord<CoordinatorInvite>(row) : null;
	}

	async listInvites(_groupId: string): Promise<CoordinatorInvite[]> {
		return (
			await allRows<CoordinatorInvite>(
				this.db
					.prepare(`SELECT invite_id, group_id, token, policy, expires_at, created_at, created_by, team_name_snapshot, revoked_at
					 FROM coordinator_invites WHERE group_id = ?
					 ORDER BY created_at DESC`)
					.bind(_groupId),
			)
		).map((row) => rowToRecord<CoordinatorInvite>(row));
	}

	async createJoinRequest(
		_opts: CoordinatorCreateJoinRequestInput,
	): Promise<CoordinatorJoinRequest> {
		const now = nowISO();
		const requestId = tokenUrlSafe(12);
		await this.db
			.prepare(`INSERT INTO coordinator_join_requests(
				request_id, group_id, device_id, public_key, fingerprint, display_name, token, status, created_at, reviewed_at, reviewed_by
			) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL)`)
			.bind(
				requestId,
				_opts.groupId,
				_opts.deviceId,
				_opts.publicKey,
				_opts.fingerprint,
				_opts.displayName ?? null,
				_opts.token,
				now,
			)
			.run();
		const row = await firstRow<CoordinatorJoinRequest>(
			this.db
				.prepare(`SELECT request_id, group_id, device_id, fingerprint, display_name, token, status, created_at, reviewed_at, reviewed_by
					 FROM coordinator_join_requests WHERE request_id = ?`)
				.bind(requestId),
		);
		return rowToRecord<CoordinatorJoinRequest>(row);
	}

	async listJoinRequests(_groupId: string, _status?: string): Promise<CoordinatorJoinRequest[]> {
		const status = _status ?? "pending";
		return (
			await allRows<CoordinatorJoinRequest>(
				this.db
					.prepare(`SELECT request_id, group_id, device_id, fingerprint, display_name, token, status, created_at, reviewed_at, reviewed_by
					 FROM coordinator_join_requests
					 WHERE group_id = ? AND status = ?
					 ORDER BY created_at ASC, device_id ASC`)
					.bind(_groupId, status),
			)
		).map((row) => rowToRecord<CoordinatorJoinRequest>(row));
	}

	async reviewJoinRequest(
		_opts: CoordinatorReviewJoinRequestInput,
	): Promise<CoordinatorJoinRequestReviewResult | null> {
		const row = await firstRow<CoordinatorJoinRequest & { public_key: string }>(
			this.db
				.prepare(`SELECT request_id, group_id, device_id, public_key, fingerprint, display_name, token, status,
					        created_at, reviewed_at, reviewed_by
					 FROM coordinator_join_requests WHERE request_id = ?`)
				.bind(_opts.requestId),
		);
		if (!row) return null;
		if (row.status !== "pending") {
			return { ...rowToRecord<CoordinatorJoinRequest>(row), _no_transition: true };
		}
		const reviewedAt = nowISO();
		const nextStatus = _opts.approved ? "approved" : "denied";
		if (this.db.batch) {
			const statements: D1PreparedStatementLike[] = [];
			statements.push(
				this.db
					.prepare(`UPDATE coordinator_join_requests
						 SET status = ?, reviewed_at = ?, reviewed_by = ?
						 WHERE request_id = ? AND status = 'pending'`)
					.bind(nextStatus, reviewedAt, _opts.reviewedBy ?? null, _opts.requestId),
			);
			if (_opts.approved) {
				statements.push(
					this.db
						.prepare(`INSERT INTO enrolled_devices(
							group_id, device_id, public_key, fingerprint, display_name, enabled, created_at
						)
						SELECT group_id, device_id, public_key, fingerprint, display_name, 1, ?
						FROM coordinator_join_requests
						WHERE request_id = ?
						  AND status = 'approved'
						  AND reviewed_at = ?
						ON CONFLICT(group_id, device_id) DO UPDATE SET
							public_key = excluded.public_key,
							fingerprint = excluded.fingerprint,
							display_name = excluded.display_name,
							enabled = 1`)
						.bind(nowISO(), _opts.requestId, reviewedAt),
				);
			}
			await this.db.batch(statements);
		} else {
			const changes = await runChanges(
				this.db
					.prepare(`UPDATE coordinator_join_requests
						 SET status = ?, reviewed_at = ?, reviewed_by = ?
						 WHERE request_id = ? AND status = 'pending'`)
					.bind(nextStatus, reviewedAt, _opts.reviewedBy ?? null, _opts.requestId),
			);
			if (changes === 0) {
				const latest = await firstRow<CoordinatorJoinRequestReviewResult>(
					this.db
						.prepare(`SELECT request_id, group_id, device_id, fingerprint, display_name, token, status, created_at, reviewed_at, reviewed_by
							 FROM coordinator_join_requests WHERE request_id = ?`)
						.bind(_opts.requestId),
				);
				return latest
					? { ...rowToRecord<CoordinatorJoinRequestReviewResult>(latest), _no_transition: true }
					: null;
			}
			if (_opts.approved) {
				await this.enrollDevice(row.group_id, {
					deviceId: row.device_id,
					fingerprint: row.fingerprint,
					publicKey: row.public_key,
					displayName: (row.display_name ?? "").trim() || null,
				});
			}
		}
		const updated = await firstRow<CoordinatorJoinRequestReviewResult>(
			this.db
				.prepare(`SELECT request_id, group_id, device_id, fingerprint, display_name, token, status, created_at, reviewed_at, reviewed_by
					 FROM coordinator_join_requests WHERE request_id = ?`)
				.bind(_opts.requestId),
		);
		return updated ? rowToRecord<CoordinatorJoinRequestReviewResult>(updated) : null;
	}

	async upsertPresence(_opts: CoordinatorUpsertPresenceInput): Promise<CoordinatorPresenceRecord> {
		notImplemented("upsertPresence");
	}

	async listGroupPeers(
		_groupId: string,
		_requestingDeviceId: string,
	): Promise<CoordinatorPeerRecord[]> {
		notImplemented("listGroupPeers");
	}
}
