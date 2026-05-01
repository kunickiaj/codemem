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

function rowToRecord<T>(row: unknown): T {
	if (row == null) throw new Error("expected row");
	return row as T;
}

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

function reciprocalPendingPair(
	requestingDeviceId: string,
	requestedDeviceId: string,
): {
	low: string;
	high: string;
} {
	return requestingDeviceId <= requestedDeviceId
		? { low: requestingDeviceId, high: requestedDeviceId }
		: { low: requestedDeviceId, high: requestingDeviceId };
}

function isUniqueConstraintError(error: unknown): boolean {
	return error instanceof Error && /unique|constraint/i.test(error.message);
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

function requireTrimmedBootstrapGrantInput(opts: CoordinatorCreateBootstrapGrantInput): {
	groupId: string;
	seedDeviceId: string;
	workerDeviceId: string;
	expiresAt: string;
	createdBy: string | null;
} {
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
			.prepare(
				"INSERT OR IGNORE INTO groups(group_id, display_name, archived_at, created_at) VALUES (?, ?, NULL, ?)",
			)
			.bind(_groupId, _displayName ?? null, nowISO())
			.run();
	}

	async getGroup(_groupId: string): Promise<CoordinatorGroup | null> {
		const row = await firstRow<CoordinatorGroup>(
			this.db
				.prepare(
					"SELECT group_id, display_name, archived_at, created_at FROM groups WHERE group_id = ?",
				)
				.bind(_groupId),
		);
		return row ? rowToRecord<CoordinatorGroup>(row) : null;
	}

	async listGroups(_includeArchived = false): Promise<CoordinatorGroup[]> {
		const where = _includeArchived ? "" : "WHERE archived_at IS NULL";
		return (
			await allRows<CoordinatorGroup>(
				this.db.prepare(
					`SELECT group_id, display_name, archived_at, created_at FROM groups ${where} ORDER BY created_at ASC`,
				),
			)
		).map((row) => rowToRecord<CoordinatorGroup>(row));
	}

	async renameGroup(_groupId: string, _displayName: string): Promise<boolean> {
		return (
			(await runChanges(
				this.db
					.prepare("UPDATE groups SET display_name = ? WHERE group_id = ?")
					.bind(_displayName, _groupId),
			)) > 0
		);
	}

	async archiveGroup(_groupId: string, _archivedAt = nowISO()): Promise<boolean> {
		return (
			(await runChanges(
				this.db
					.prepare("UPDATE groups SET archived_at = ? WHERE group_id = ? AND archived_at IS NULL")
					.bind(_archivedAt, _groupId),
			)) > 0
		);
	}

	async unarchiveGroup(_groupId: string): Promise<boolean> {
		return (
			(await runChanges(
				this.db
					.prepare(
						"UPDATE groups SET archived_at = NULL WHERE group_id = ? AND archived_at IS NOT NULL",
					)
					.bind(_groupId),
			)) > 0
		);
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
					.prepare(`SELECT group_id, device_id, public_key, fingerprint, display_name, enabled, created_at
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
				.prepare(`SELECT group_id, device_id, public_key, fingerprint, display_name, enabled, created_at
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
		await this.db
			.prepare(
				"DELETE FROM coordinator_reciprocal_approvals WHERE group_id = ? AND (requesting_device_id = ? OR requested_device_id = ?)",
			)
			.bind(_groupId, _deviceId, _deviceId)
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
		return (
			(await runChanges(
				this.db
					.prepare(
						"INSERT OR IGNORE INTO request_nonces(device_id, nonce, created_at) VALUES (?, ?, ?)",
					)
					.bind(_deviceId, _nonce, _createdAt),
			)) > 0
		);
	}

	async cleanupNonces(_cutoff: string): Promise<void> {
		await this.db.prepare("DELETE FROM request_nonces WHERE created_at < ?").bind(_cutoff).run();
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
				.prepare(`SELECT request_id, group_id, device_id, public_key, fingerprint, display_name, token, status, created_at, reviewed_at, reviewed_by
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
					.prepare(`SELECT request_id, group_id, device_id, public_key, fingerprint, display_name, token, status, created_at, reviewed_at, reviewed_by
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
		const bootstrapGrantRequest = normalizeBootstrapGrantRequest(_opts.bootstrapGrant);
		const reviewedAt = nowISO();
		const nextStatus = _opts.approved ? "approved" : "denied";
		let bootstrapGrantInput: CoordinatorCreateBootstrapGrantInput | null = null;
		let bootstrapGrantId: string | null = null;
		if (_opts.approved && bootstrapGrantRequest) {
			const seedEnrollment = await firstRow<{ device_id: string }>(
				this.db
					.prepare(
						`SELECT device_id FROM enrolled_devices WHERE group_id = ? AND device_id = ? AND enabled = 1`,
					)
					.bind(row.group_id, bootstrapGrantRequest.seedDeviceId),
			);
			if (!seedEnrollment) {
				throw new Error("bootstrap grant seed device is not enrolled in the group.");
			}
			if (bootstrapGrantRequest.seedDeviceId === row.device_id) {
				throw new Error("bootstrap grant seed and worker device ids must differ.");
			}
			bootstrapGrantInput = {
				...bootstrapGrantRequest,
				groupId: row.group_id,
				workerDeviceId: row.device_id,
			};
		}
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
				if (bootstrapGrantInput) {
					bootstrapGrantId = tokenUrlSafe(12);
					const createdAt = nowISO();
					// Conditional INSERT: only mint a grant if the join request was
					// actually transitioned to 'approved' by the UPDATE in this batch.
					// This prevents issuing extra grants under concurrent review races.
					statements.push(
						this.db
							.prepare(`INSERT INTO coordinator_bootstrap_grants(
							grant_id, group_id, seed_device_id, worker_device_id, expires_at, created_at, created_by, revoked_at
						) SELECT ?, ?, ?, ?, ?, ?, ?, NULL
						WHERE EXISTS (
							SELECT 1 FROM coordinator_join_requests
							WHERE request_id = ? AND status = 'approved' AND reviewed_at = ?
						)`)
							.bind(
								bootstrapGrantId,
								bootstrapGrantInput.groupId,
								bootstrapGrantInput.seedDeviceId,
								bootstrapGrantInput.workerDeviceId,
								bootstrapGrantInput.expiresAt,
								createdAt,
								bootstrapGrantInput.createdBy ?? null,
								_opts.requestId,
								reviewedAt,
							),
					);
				}
			}
			await this.db.batch(statements);
		} else {
			let createdGrantId: string | null = null;
			if (_opts.approved) {
				await this.enrollDevice(row.group_id, {
					deviceId: row.device_id,
					fingerprint: row.fingerprint,
					publicKey: row.public_key,
					displayName: (row.display_name ?? "").trim() || null,
				});
				if (bootstrapGrantInput) {
					const grant = await this.createBootstrapGrant(bootstrapGrantInput);
					createdGrantId = grant.grant_id;
					bootstrapGrantId = grant.grant_id;
				}
			}
			const changes = await runChanges(
				this.db
					.prepare(`UPDATE coordinator_join_requests
						 SET status = ?, reviewed_at = ?, reviewed_by = ?
						 WHERE request_id = ? AND status = 'pending'`)
					.bind(nextStatus, reviewedAt, _opts.reviewedBy ?? null, _opts.requestId),
			);
			if (changes === 0) {
				if (createdGrantId) {
					await this.revokeBootstrapGrant(createdGrantId);
				}
				const latest = await firstRow<CoordinatorJoinRequestReviewResult>(
					this.db
						.prepare(`SELECT request_id, group_id, device_id, public_key, fingerprint, display_name, token, status, created_at, reviewed_at, reviewed_by
							 FROM coordinator_join_requests WHERE request_id = ?`)
						.bind(_opts.requestId),
				);
				return latest
					? { ...rowToRecord<CoordinatorJoinRequestReviewResult>(latest), _no_transition: true }
					: null;
			}
		}
		const updated = await firstRow<CoordinatorJoinRequestReviewResult>(
			this.db
				.prepare(`SELECT request_id, group_id, device_id, public_key, fingerprint, display_name, token, status, created_at, reviewed_at, reviewed_by
					 FROM coordinator_join_requests WHERE request_id = ?`)
				.bind(_opts.requestId),
		);
		if (!updated) return null;
		const bootstrapGrant = bootstrapGrantInput
			? bootstrapGrantId
				? await this.getBootstrapGrant(bootstrapGrantId)
				: await this.createBootstrapGrant(bootstrapGrantInput)
			: null;
		return {
			...rowToRecord<CoordinatorJoinRequestReviewResult>(updated),
			bootstrap_grant: bootstrapGrant,
		};
	}

	async createReciprocalApproval(
		opts: CoordinatorCreateReciprocalApprovalInput,
	): Promise<CoordinatorReciprocalApproval> {
		const groupId = opts.groupId.trim();
		const requestingDeviceId = opts.requestingDeviceId.trim();
		const requestedDeviceId = opts.requestedDeviceId.trim();
		if (!groupId || !requestingDeviceId || !requestedDeviceId) {
			throw new Error("groupId, requestingDeviceId, and requestedDeviceId are required.");
		}
		if (requestingDeviceId === requestedDeviceId) {
			throw new Error("requesting and requested device ids must differ.");
		}
		const pendingPair = reciprocalPendingPair(requestingDeviceId, requestedDeviceId);
		const existing = await firstRow<CoordinatorReciprocalApproval>(
			this.db
				.prepare(`SELECT request_id, group_id, requesting_device_id, requested_device_id, status, created_at, resolved_at
					 FROM coordinator_reciprocal_approvals
					 WHERE group_id = ? AND requesting_device_id = ? AND requested_device_id = ? AND status = 'pending'
					 ORDER BY created_at DESC LIMIT 1`)
				.bind(groupId, requestingDeviceId, requestedDeviceId),
		);
		if (existing) return rowToRecord<CoordinatorReciprocalApproval>(existing);
		const reverse = await firstRow<CoordinatorReciprocalApproval>(
			this.db
				.prepare(`SELECT request_id, group_id, requesting_device_id, requested_device_id, status, created_at, resolved_at
					 FROM coordinator_reciprocal_approvals
					 WHERE group_id = ? AND requesting_device_id = ? AND requested_device_id = ? AND status = 'pending'
					 ORDER BY created_at DESC LIMIT 1`)
				.bind(groupId, requestedDeviceId, requestingDeviceId),
		);
		if (reverse) {
			const resolvedAt = nowISO();
			await this.db
				.prepare(
					`UPDATE coordinator_reciprocal_approvals SET status = 'completed', resolved_at = ? WHERE request_id = ?`,
				)
				.bind(resolvedAt, reverse.request_id)
				.run();
			const completed = await firstRow<CoordinatorReciprocalApproval>(
				this.db
					.prepare(`SELECT request_id, group_id, requesting_device_id, requested_device_id, status, created_at, resolved_at
						 FROM coordinator_reciprocal_approvals WHERE request_id = ?`)
					.bind(reverse.request_id),
			);
			return rowToRecord<CoordinatorReciprocalApproval>(completed);
		}
		const requestId = tokenUrlSafe(12);
		const createdAt = nowISO();
		try {
			await this.db
				.prepare(`INSERT INTO coordinator_reciprocal_approvals(
						request_id,
						group_id,
						requesting_device_id,
						requested_device_id,
						pending_pair_low_device_id,
						pending_pair_high_device_id,
						status,
						created_at,
						resolved_at
					) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`)
				.bind(
					requestId,
					groupId,
					requestingDeviceId,
					requestedDeviceId,
					pendingPair.low,
					pendingPair.high,
					createdAt,
				)
				.run();
		} catch (error) {
			if (!isUniqueConstraintError(error)) throw error;
			const sameDirection = await firstRow<CoordinatorReciprocalApproval>(
				this.db
					.prepare(`SELECT request_id, group_id, requesting_device_id, requested_device_id, status, created_at, resolved_at
						 FROM coordinator_reciprocal_approvals
						 WHERE group_id = ? AND requesting_device_id = ? AND requested_device_id = ? AND status = 'pending'
						 ORDER BY created_at DESC LIMIT 1`)
					.bind(groupId, requestingDeviceId, requestedDeviceId),
			);
			if (sameDirection) return rowToRecord<CoordinatorReciprocalApproval>(sameDirection);
			const reverseAfterConflict = await firstRow<CoordinatorReciprocalApproval>(
				this.db
					.prepare(`SELECT request_id, group_id, requesting_device_id, requested_device_id, status, created_at, resolved_at
						 FROM coordinator_reciprocal_approvals
						 WHERE group_id = ? AND requesting_device_id = ? AND requested_device_id = ? AND status = 'pending'
						 ORDER BY created_at DESC LIMIT 1`)
					.bind(groupId, requestedDeviceId, requestingDeviceId),
			);
			if (reverseAfterConflict) {
				const resolvedAt = nowISO();
				await this.db
					.prepare(
						`UPDATE coordinator_reciprocal_approvals SET status = 'completed', resolved_at = ? WHERE request_id = ?`,
					)
					.bind(resolvedAt, reverseAfterConflict.request_id)
					.run();
				const completed = await firstRow<CoordinatorReciprocalApproval>(
					this.db
						.prepare(`SELECT request_id, group_id, requesting_device_id, requested_device_id, status, created_at, resolved_at
							 FROM coordinator_reciprocal_approvals WHERE request_id = ?`)
						.bind(reverseAfterConflict.request_id),
				);
				return rowToRecord<CoordinatorReciprocalApproval>(completed);
			}
			throw error;
		}
		const created = await firstRow<CoordinatorReciprocalApproval>(
			this.db
				.prepare(`SELECT request_id, group_id, requesting_device_id, requested_device_id, status, created_at, resolved_at
					 FROM coordinator_reciprocal_approvals WHERE request_id = ?`)
				.bind(requestId),
		);
		return rowToRecord<CoordinatorReciprocalApproval>(created);
	}

	async createBootstrapGrant(
		opts: CoordinatorCreateBootstrapGrantInput,
	): Promise<CoordinatorBootstrapGrant> {
		const normalized = requireTrimmedBootstrapGrantInput(opts);
		const grantId = tokenUrlSafe(12);
		const createdAt = nowISO();
		await this.db
			.prepare(`INSERT INTO coordinator_bootstrap_grants(
				grant_id, group_id, seed_device_id, worker_device_id, expires_at, created_at, created_by, revoked_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`)
			.bind(
				grantId,
				normalized.groupId,
				normalized.seedDeviceId,
				normalized.workerDeviceId,
				normalized.expiresAt,
				createdAt,
				normalized.createdBy,
			)
			.run();
		const row = await firstRow<CoordinatorBootstrapGrant>(
			this.db
				.prepare(`SELECT grant_id, group_id, seed_device_id, worker_device_id, expires_at, created_at, created_by, revoked_at
					 FROM coordinator_bootstrap_grants WHERE grant_id = ?`)
				.bind(grantId),
		);
		return rowToRecord<CoordinatorBootstrapGrant>(row);
	}

	private async getScope(scopeId: string): Promise<CoordinatorScope | null> {
		const row = await firstRow<CoordinatorScope>(
			this.db
				.prepare(`SELECT scope_id, label, kind, authority_type, coordinator_id, group_id,
						manifest_issuer_device_id, membership_epoch, manifest_hash, status, created_at, updated_at
					 FROM coordinator_scopes WHERE scope_id = ?`)
				.bind(scopeId),
		);
		return row ? rowToRecord<CoordinatorScope>(row) : null;
	}

	private async getScopeMembership(
		scopeId: string,
		deviceId: string,
	): Promise<CoordinatorScopeMembership | null> {
		const row = await firstRow<CoordinatorScopeMembership>(
			this.db
				.prepare(`SELECT scope_id, device_id, role, status, membership_epoch, coordinator_id, group_id,
						manifest_issuer_device_id, manifest_hash, signed_manifest_json, updated_at
					 FROM coordinator_scope_memberships
					 WHERE scope_id = ? AND device_id = ?`)
				.bind(scopeId, deviceId),
		);
		return row ? rowToRecord<CoordinatorScopeMembership>(row) : null;
	}

	async createScope(opts: CoordinatorCreateScopeInput): Promise<CoordinatorScope> {
		const normalized = normalizeCreateScopeInput(opts);
		if (await this.getScope(normalized.scopeId)) throw new Error("scopeId already exists.");
		const now = nowISO();
		await this.db
			.prepare(`INSERT INTO coordinator_scopes(
					scope_id, label, kind, authority_type, coordinator_id, group_id,
					manifest_issuer_device_id, membership_epoch, manifest_hash, status, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.bind(
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
			)
			.run();
		const scope = await this.getScope(normalized.scopeId);
		if (!scope) throw new Error("scope insert returned no row");
		return scope;
	}

	async updateScope(opts: CoordinatorUpdateScopeInput): Promise<CoordinatorScope | null> {
		const scopeId = clean(opts.scopeId);
		const existing = scopeId ? await this.getScope(scopeId) : null;
		if (!existing) return null;
		const normalized = normalizeUpdateScopeInput(opts, existing);
		await this.db
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
			.bind(
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
			)
			.run();
		return await this.getScope(normalized.scopeId);
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
		const statement =
			this.db.prepare(`SELECT scope_id, label, kind, authority_type, coordinator_id, group_id,
				manifest_issuer_device_id, membership_epoch, manifest_hash, status, created_at, updated_at
			 FROM coordinator_scopes ${whereSql}
			 ORDER BY coordinator_id ASC, group_id ASC, scope_id ASC`);
		return (
			await allRows<CoordinatorScope>(params.length ? statement.bind(...params) : statement)
		).map((row) => rowToRecord<CoordinatorScope>(row));
	}

	async grantScopeMembership(
		opts: CoordinatorGrantScopeMembershipInput,
	): Promise<CoordinatorScopeMembership> {
		const scopeId = clean(opts.scopeId);
		const deviceId = clean(opts.deviceId);
		const scope = scopeId ? await this.getScope(scopeId) : null;
		if (!scope) throw new Error("scopeId must reference an existing scope.");
		const existing = scopeId && deviceId ? await this.getScopeMembership(scopeId, deviceId) : null;
		const normalized = normalizeGrantInput(opts, scope, existing);
		if (normalized.groupId) {
			const enrollment = await this.getEnrollment(normalized.groupId, normalized.deviceId);
			if (!enrollment) {
				throw new Error("device must be enrolled and enabled in the scope group.");
			}
		}
		const now = nowISO();
		await this.db
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
			.bind(
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
			)
			.run();
		const row = await firstRow<CoordinatorScopeMembership>(
			this.db
				.prepare(`SELECT scope_id, device_id, role, status, membership_epoch, coordinator_id, group_id,
						manifest_issuer_device_id, manifest_hash, signed_manifest_json, updated_at
					 FROM coordinator_scope_memberships
					 WHERE scope_id = ? AND device_id = ?`)
				.bind(normalized.scopeId, normalized.deviceId),
		);
		return rowToRecord<CoordinatorScopeMembership>(row);
	}

	async revokeScopeMembership(opts: CoordinatorRevokeScopeMembershipInput): Promise<boolean> {
		const scopeId = clean(opts.scopeId);
		const deviceId = clean(opts.deviceId);
		if (!scopeId || !deviceId) throw new Error("scopeId and deviceId are required.");
		const membershipEpoch =
			opts.membershipEpoch == null ? null : normalizeEpoch(opts.membershipEpoch);
		const existing = await this.getScopeMembership(scopeId, deviceId);
		if (membershipEpoch != null && existing && membershipEpoch <= existing.membership_epoch) {
			throw new Error("membershipEpoch must increase on revoke.");
		}
		return (
			(await runChanges(
				this.db
					.prepare(`UPDATE coordinator_scope_memberships
						 SET status = 'revoked',
							 membership_epoch = CASE WHEN ? IS NULL THEN membership_epoch + 1 ELSE ? END,
							 manifest_hash = COALESCE(?, manifest_hash),
							 signed_manifest_json = COALESCE(?, signed_manifest_json),
							 updated_at = ?
						 WHERE scope_id = ? AND device_id = ?`)
					.bind(
						membershipEpoch,
						membershipEpoch,
						clean(opts.manifestHash),
						clean(opts.signedManifestJson),
						nowISO(),
						scopeId,
						deviceId,
					),
			)) > 0
		);
	}

	async listScopeMemberships(
		scopeId: string,
		includeRevoked = false,
	): Promise<CoordinatorScopeMembership[]> {
		const normalizedScopeId = clean(scopeId);
		if (!normalizedScopeId) throw new Error("scopeId is required.");
		const statusWhere = includeRevoked ? "" : "AND status = 'active'";
		return (
			await allRows<CoordinatorScopeMembership>(
				this.db
					.prepare(`SELECT scope_id, device_id, role, status, membership_epoch, coordinator_id, group_id,
							manifest_issuer_device_id, manifest_hash, signed_manifest_json, updated_at
						 FROM coordinator_scope_memberships
						 WHERE scope_id = ? ${statusWhere}
						 ORDER BY device_id ASC`)
					.bind(normalizedScopeId),
			)
		).map((row) => rowToRecord<CoordinatorScopeMembership>(row));
	}

	async getBootstrapGrant(grantId: string): Promise<CoordinatorBootstrapGrant | null> {
		const row = await firstRow<CoordinatorBootstrapGrant>(
			this.db
				.prepare(`SELECT grant_id, group_id, seed_device_id, worker_device_id, expires_at, created_at, created_by, revoked_at
					 FROM coordinator_bootstrap_grants WHERE grant_id = ?`)
				.bind(grantId),
		);
		return row ? rowToRecord<CoordinatorBootstrapGrant>(row) : null;
	}

	async listBootstrapGrants(groupId: string): Promise<CoordinatorBootstrapGrant[]> {
		return (
			await allRows<CoordinatorBootstrapGrant>(
				this.db
					.prepare(`SELECT grant_id, group_id, seed_device_id, worker_device_id, expires_at, created_at, created_by, revoked_at
						 FROM coordinator_bootstrap_grants WHERE group_id = ?
						 ORDER BY created_at DESC, grant_id DESC`)
					.bind(groupId),
			)
		).map((row) => rowToRecord<CoordinatorBootstrapGrant>(row));
	}

	async revokeBootstrapGrant(grantId: string, revokedAt = nowISO()): Promise<boolean> {
		return (
			(await runChanges(
				this.db
					.prepare(`UPDATE coordinator_bootstrap_grants
						 SET revoked_at = COALESCE(revoked_at, ?)
						 WHERE grant_id = ?`)
					.bind(revokedAt, grantId),
			)) > 0
		);
	}

	async listReciprocalApprovals(
		opts: CoordinatorListReciprocalApprovalsInput,
	): Promise<CoordinatorReciprocalApproval[]> {
		const directionColumn =
			opts.direction === "incoming" ? "requested_device_id" : "requesting_device_id";
		const status = opts.status?.trim() || "pending";
		return (
			await allRows<CoordinatorReciprocalApproval>(
				this.db
					.prepare(`SELECT request_id, group_id, requesting_device_id, requested_device_id, status, created_at, resolved_at
						 FROM coordinator_reciprocal_approvals
						 WHERE group_id = ? AND ${directionColumn} = ? AND status = ?
						 ORDER BY created_at ASC, request_id ASC`)
					.bind(opts.groupId, opts.deviceId, status),
			)
		).map((row) => rowToRecord<CoordinatorReciprocalApproval>(row));
	}

	async upsertPresence(_opts: CoordinatorUpsertPresenceInput): Promise<CoordinatorPresenceRecord> {
		const now = new Date();
		const expiresAt = new Date(now.getTime() + _opts.ttlS * 1000).toISOString();
		const normalized = mergeAddresses([], _opts.addresses);
		await this.db
			.prepare(`INSERT INTO presence_records(group_id, device_id, addresses_json, last_seen_at, expires_at, capabilities_json)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(group_id, device_id) DO UPDATE SET
					addresses_json = excluded.addresses_json,
					last_seen_at = excluded.last_seen_at,
					expires_at = excluded.expires_at,
					capabilities_json = excluded.capabilities_json`)
			.bind(
				_opts.groupId,
				_opts.deviceId,
				JSON.stringify(normalized),
				now.toISOString(),
				expiresAt,
				JSON.stringify(_opts.capabilities ?? {}),
			)
			.run();
		return {
			group_id: _opts.groupId,
			device_id: _opts.deviceId,
			addresses: normalized,
			expires_at: expiresAt,
		};
	}

	async listGroupPeers(
		_groupId: string,
		_requestingDeviceId: string,
	): Promise<CoordinatorPeerRecord[]> {
		const now = nowISO();
		const rows = await allRows<Record<string, unknown>>(
			this.db
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
				.bind(_groupId, _requestingDeviceId),
		);
		return rows.map((row) => {
			const expiresRaw = String(row.expires_at ?? "").trim();
			let stale = true;
			if (expiresRaw) {
				const expiresAt = new Date(expiresRaw);
				stale = Number.isNaN(expiresAt.getTime()) || expiresAt.toISOString() <= now;
			}
			const addresses = stale
				? []
				: mergeAddresses([], JSON.parse(String(row.addresses_json ?? "[]")) as string[]);
			return {
				device_id: String(row.device_id ?? ""),
				public_key: String(row.public_key ?? ""),
				fingerprint: String(row.fingerprint ?? ""),
				display_name: (row.display_name as string | null) ?? null,
				addresses,
				last_seen_at: (row.last_seen_at as string | null) ?? null,
				expires_at: (row.expires_at as string | null) ?? null,
				stale,
				capabilities: JSON.parse(String(row.capabilities_json ?? "{}")) as Record<string, unknown>,
			} satisfies CoordinatorPeerRecord;
		});
	}
}
