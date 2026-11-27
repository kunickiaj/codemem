import {
	COORDINATOR_METADATA_STORAGE_PRESENT_SQL,
	type InviteTokenLookupFence,
	LOOKUP_VERSION_SEEN,
	lookupFence,
	MIN_SERVING_LOOKUP_VERSION,
	RAISE_METADATA_SQL,
	READ_FENCE_SQL,
} from "./coordinator-invite-token-fence.js";
import {
	INVITE_TOKEN_LOOKUP_VERSION,
	InviteTokenRefusal,
	joinRequestStoredDigest,
	joinRequestStoredToken,
	PLAINTEXT_TOKEN_SQL,
} from "./coordinator-invite-token-seal.js";

/** The reads and writes both coordinator stores provide, with SQLite-dialect SQL. */
export interface InviteTokenBackend {
	first<T>(statement: { sql: string; values: unknown[] }): Promise<T | null>;
	all?<T>(statement: { sql: string; values: unknown[] }): Promise<T[]>;
	run(statement: { sql: string; values: unknown[] }): Promise<number>;
}

export type InviteTokenDigest = (token: string) => string | Promise<string>;

/** One batch of `fillDigests`, and what is left after it. */
export interface InviteTokenDigestProgress {
	filled_invites: number;
	hashed_join_requests: number;
	remaining_invites_without_digest: number;
	remaining_plaintext_join_requests: number;
}

/** The fields of a stored invitation that a digest fill reads. */
export interface StoredInviteTokenRow {
	invite_id: string;
	token: string;
	token_digest?: string | null;
}

/**
 * The most rows of each table that one backfill request changes. Each table
 * takes one read and one write whatever the batch size, because the write
 * carries every row in one JSON value, so a request stays far below D1's
 * per-invocation query limit (50 on the Free plan) and its 2 MB value limit.
 */
export const INVITE_TOKEN_BACKFILL_MAX_ROWS = 100;

/** Invitations from before token digests, which no digest lookup finds. */
export const INVITES_WITHOUT_DIGEST_SQL = `${PLAINTEXT_TOKEN_SQL} AND token_digest IS NULL`;

/** The `[id, token, value]` rows of a backfill write, bound once as one JSON value. */
const BATCH_ROWS = `WITH batch AS (SELECT json_extract(value, '$[0]') AS id,
	json_extract(value, '$[1]') AS token, json_extract(value, '$[2]') AS value FROM json_each(?))`;

/** Fills the digests of a batch of invitations, unless a row changed meanwhile. */
export const FILL_INVITE_DIGESTS_SQL = `${BATCH_ROWS}
UPDATE coordinator_invites
	SET token_digest = (SELECT b.value FROM batch b WHERE b.id = coordinator_invites.invite_id)
	WHERE token_digest IS NULL AND EXISTS (SELECT 1 FROM batch b
		WHERE b.id = coordinator_invites.invite_id AND b.token = coordinator_invites.token)`;

/** Replaces the token copies of a batch of join requests, unless a row changed meanwhile. */
export const HASH_JOIN_REQUESTS_SQL = `${BATCH_ROWS}
UPDATE coordinator_join_requests
	SET token = (SELECT b.value FROM batch b WHERE b.id = coordinator_join_requests.request_id)
	WHERE EXISTS (SELECT 1 FROM batch b
		WHERE b.id = coordinator_join_requests.request_id AND b.token = coordinator_join_requests.token)`;

/** Clamps a requested batch size to 1..INVITE_TOKEN_BACKFILL_MAX_ROWS. */
export function inviteTokenBatch(limit: number): number {
	return Math.max(1, Math.min(Math.trunc(limit) || 1, INVITE_TOKEN_BACKFILL_MAX_ROWS));
}

/**
 * Fills invitation token digests on either coordinator store. Only the stored
 * `token` value of a row is hashed; a presented token is never compared with
 * that column, so a stale token or a placeholder matches nothing.
 */
export class InviteTokenStorage {
	private metadataSeen = false;

	constructor(
		private readonly backend: InviteTokenBackend,
		private readonly digest: InviteTokenDigest,
	) {}

	/** Whether the metadata table of migration 0054 exists. Once seen it is assumed to stay. */
	async metadataReady(): Promise<boolean> {
		if (this.metadataSeen) return true;
		const row = await this.backend.first<{ present: number }>({
			sql: COORDINATOR_METADATA_STORAGE_PRESENT_SQL,
			values: [],
		});
		this.metadataSeen = row?.present === 1;
		return this.metadataSeen;
	}

	/** Records this build's lookup version, when it is the highest yet. False without the table. */
	async recordLookupVersion(now: string): Promise<boolean> {
		if (!(await this.metadataReady())) return false;
		await this.backend.run({
			sql: RAISE_METADATA_SQL,
			values: [LOOKUP_VERSION_SEEN, INVITE_TOKEN_LOOKUP_VERSION, now],
		});
		return true;
	}

	/** The lookup versions the database records. Null values without the table. */
	async lookupFence(): Promise<InviteTokenLookupFence> {
		if (!(await this.metadataReady())) return lookupFence(null);
		return lookupFence(await this.backend.first({ sql: READ_FENCE_SQL, values: [] }));
	}

	/**
	 * Records, as an operator's confirmation, that every build serving the database
	 * has at least `version`. It can only rise, and never above this build's version.
	 */
	async raiseLookupFloor(version: number, now: string): Promise<InviteTokenLookupFence> {
		if (!Number.isSafeInteger(version) || version < 1 || version > INVITE_TOKEN_LOOKUP_VERSION)
			throw new InviteTokenRefusal("invite_token_lookup_floor_invalid", 409);
		if (!(await this.recordLookupVersion(now)))
			throw new InviteTokenRefusal("coordinator_metadata_unavailable", 503);
		await this.backend.run({
			sql: RAISE_METADATA_SQL,
			values: [MIN_SERVING_LOOKUP_VERSION, version, now],
		});
		return this.lookupFence();
	}

	protected rows<T>(sql: string, values: unknown[]): Promise<T[]> {
		if (!this.backend.all) throw new Error("invite_token_backend_unavailable");
		return this.backend.all<T>({ sql, values });
	}

	protected async count(sql: string): Promise<number> {
		const row = await this.backend.first<{ count: number }>({ sql, values: [] });
		return Number(row?.count ?? 0);
	}

	/**
	 * One batch of the digest backfill: gives invitations from before token digests
	 * their digest, so a digest lookup finds them, and replaces join request copies
	 * of a token with its digest. Run it until both remaining counts are 0.
	 */
	async fillDigests(limit: number, now: string): Promise<InviteTokenDigestProgress> {
		// The backfill is the admin's first step with this build, so it records the build's lookup version.
		await this.recordLookupVersion(now);
		const batch = inviteTokenBatch(limit);
		const invites = await this.rows<StoredInviteTokenRow>(
			`SELECT invite_id, token FROM coordinator_invites WHERE ${INVITES_WITHOUT_DIGEST_SQL}
				ORDER BY invite_id LIMIT ?`,
			[batch],
		);
		const requests = await this.rows<{ request_id: string; token: string }>(
			`SELECT request_id, token FROM coordinator_join_requests WHERE ${PLAINTEXT_TOKEN_SQL}
				ORDER BY request_id LIMIT ?`,
			[batch],
		);
		const filled = await this.writeRows(
			FILL_INVITE_DIGESTS_SQL,
			await Promise.all(
				invites.map(async (row) => [row.invite_id, row.token, await this.digest(row.token)]),
			),
		);
		const hashed = await this.writeRows(
			HASH_JOIN_REQUESTS_SQL,
			await Promise.all(
				requests.map(async (row) => [
					row.request_id,
					row.token,
					joinRequestStoredToken(await this.digest(row.token)),
				]),
			),
		);
		return {
			filled_invites: filled,
			hashed_join_requests: hashed,
			remaining_invites_without_digest: await this.count(
				`SELECT COUNT(*) AS count FROM coordinator_invites WHERE ${INVITES_WITHOUT_DIGEST_SQL}`,
			),
			remaining_plaintext_join_requests: await this.count(
				`SELECT COUNT(*) AS count FROM coordinator_join_requests WHERE ${PLAINTEXT_TOKEN_SQL}`,
			),
		};
	}

	/** One statement for all rows, or none for an empty batch. Returns the rows it changed. */
	protected async writeRows(sql: string, rows: unknown[][]): Promise<number> {
		if (rows.length === 0) return 0;
		return this.backend.run({ sql, values: [JSON.stringify(rows)] });
	}

	/** The invitation token digest a join request was made with. */
	async joinRequestDigest(stored: string): Promise<string> {
		return joinRequestStoredDigest(stored) ?? (await this.digest(stored));
	}
}
