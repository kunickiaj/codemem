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
	INVITE_TOKEN_SEAL_STORAGE_PRESENT_SQL,
	type InviteTokenKeyInput,
	InviteTokenKeyring,
	InviteTokenRefusal,
	InviteTokenSealError,
	isPlaintextInviteToken,
	joinRequestStoredDigest,
	joinRequestStoredToken,
	PLAINTEXT_TOKEN_SQL,
	sealedInviteTokenPlaceholder,
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

/** One batch of `sealStoredTokens`, and what is left after it. */
export interface InviteTokenSealProgress {
	sealed_invites: number;
	cleared_spent_invites: number;
	hashed_join_requests: number;
	remaining_plaintext_invites: number;
	remaining_plaintext_join_requests: number;
	/** Consumed invitations that still keep ciphertext, such as after a rollback to an earlier build. */
	remaining_spent_ciphertext: number;
}

/** The fields of a stored invitation that sealing reads. */
export interface StoredInviteTokenRow {
	invite_id: string;
	token: string;
	token_digest?: string | null;
}

/** The fields of an operation invitation that a create retry renews. */
type RenewableInviteRow = StoredInviteTokenRow & {
	operation_id?: string | null;
	revoked_at?: string | null;
	expires_at: string;
	consumed_at?: string | null;
};

/**
 * The most rows of each table that one backfill request changes. Each table
 * takes one read and one write whatever the batch size, because the write
 * carries every row in one JSON value, so a request stays far below D1's
 * per-invocation query limit (50 on the Free plan) and its 2 MB value limit.
 */
export const INVITE_TOKEN_BACKFILL_MAX_ROWS = 100;

/** Invitations from before token digests, which no digest lookup finds. */
export const INVITES_WITHOUT_DIGEST_SQL = `${PLAINTEXT_TOKEN_SQL} AND token_digest IS NULL`;

/** The rows of a backfill write, bound once as one JSON array of arrays. */
const batchRows = (...columns: string[]) =>
	`WITH batch AS (SELECT ${columns
		.map((column, index) => `json_extract(value, '$[${index}]') AS ${column}`)
		.join(", ")} FROM json_each(?))`;

/** Fills the digests of a batch of invitations, unless a row changed meanwhile. */
export const FILL_INVITE_DIGESTS_SQL = `${batchRows("id", "token", "value")}
UPDATE coordinator_invites
	SET token_digest = (SELECT b.value FROM batch b WHERE b.id = coordinator_invites.invite_id)
	WHERE token_digest IS NULL AND EXISTS (SELECT 1 FROM batch b
		WHERE b.id = coordinator_invites.invite_id AND b.token = coordinator_invites.token)`;

/** Replaces the token copies of a batch of join requests, unless a row changed meanwhile. */
export const HASH_JOIN_REQUESTS_SQL = `${batchRows("id", "token", "value")}
UPDATE coordinator_join_requests
	SET token = (SELECT b.value FROM batch b WHERE b.id = coordinator_join_requests.request_id)
	WHERE EXISTS (SELECT 1 FROM batch b
		WHERE b.id = coordinator_join_requests.request_id AND b.token = coordinator_join_requests.token)`;

/** Seals a batch of invitations that still hold their token, unless a row changed meanwhile. */
const SEAL_ROWS_SQL = `${batchRows("id", "token", "digest", "placeholder", "ciphertext", "key_id")}
UPDATE coordinator_invites SET
	token_digest = (SELECT b.digest FROM batch b WHERE b.id = coordinator_invites.invite_id),
	token_ciphertext = (SELECT b.ciphertext FROM batch b WHERE b.id = coordinator_invites.invite_id),
	token_key_id = (SELECT b.key_id FROM batch b WHERE b.id = coordinator_invites.invite_id),
	token = (SELECT b.placeholder FROM batch b WHERE b.id = coordinator_invites.invite_id)
	WHERE EXISTS (SELECT 1 FROM batch b WHERE b.id = coordinator_invites.invite_id
		AND b.token = coordinator_invites.token
		AND (coordinator_invites.token_digest IS NULL OR coordinator_invites.token_digest = b.digest))`;

/** Ciphertext left on consumed invitations, such as those an earlier Worker consumed. */
const SPENT_CIPHERTEXT_SQL = "token GLOB 'consumed:*' AND token_ciphertext IS NOT NULL";

// A renewal keeps issued_after_removal_seq: it does not move the invitation past a later removal.
const RENEW_OPERATION_INVITE_SQL = `UPDATE coordinator_invites
	SET token = ?, token_digest = ?, token_ciphertext = ?, token_key_id = ?,
		expires_at = ?, created_at = ?, created_by = ?, team_name_snapshot = ?, revoked_at = NULL
	WHERE operation_id = ? AND token = ? AND token_digest IS ?
	  AND (revoked_at IS NOT NULL OR expires_at <= ?)`;

/** Attempts of a renewal whose compare-and-set lost to another write of the row. */
const MAX_RENEWAL_ATTEMPTS = 3;

/** Sealing assumes that no running Worker compares a presented token with the stored column. */
const SEALING_MIN_LOOKUP_VERSION = 1;

/** The new token and fields of an operation invitation that a create retry renews. */
export interface InviteRenewal {
	token: string;
	digest: string;
	expiresAt: string;
	now: string;
	createdBy: string | null;
	teamName: string | null;
}

/** The renewal of an operation invitation, with absent creator and Team name stored as null. */
export function inviteRenewal(
	fields: Pick<InviteRenewal, "token" | "digest" | "expiresAt" | "now">,
	createdBy?: string | null,
	teamName?: string | null,
): InviteRenewal {
	return { ...fields, createdBy: createdBy ?? null, teamName: teamName ?? null };
}

/** Clamps a requested batch size to 1..INVITE_TOKEN_BACKFILL_MAX_ROWS. */
export function inviteTokenBatch(limit: number): number {
	return Math.max(1, Math.min(Math.trunc(limit) || 1, INVITE_TOKEN_BACKFILL_MAX_ROWS));
}

/**
 * Seals invitation tokens and fills their digests, on either coordinator store.
 * Only the stored `token` value of a row is hashed or sealed; a presented token
 * is never compared with that column, so a stale token or a placeholder matches
 * nothing.
 */
export class InviteTokenStorage {
	private metadataSeen = false;
	private keyringPromise: Promise<InviteTokenKeyring> | null = null;
	private schemaSeen = false;
	private floorSeen = false;

	constructor(
		private readonly backend: InviteTokenBackend,
		private readonly keys: () => InviteTokenKeyInput,
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

	/** Whether the sealed token columns exist. Once seen they are assumed to stay. */
	async schemaReady(): Promise<boolean> {
		if (this.schemaSeen) return true;
		const row = await this.backend.first<{ present: number }>({
			sql: INVITE_TOKEN_SEAL_STORAGE_PRESENT_SQL,
			values: [],
		});
		this.schemaSeen = row?.present === 1;
		return this.schemaSeen;
	}

	private keyring(): Promise<InviteTokenKeyring> {
		this.keyringPromise ??= InviteTokenKeyring.from(this.keys());
		return this.keyringPromise;
	}

	/**
	 * Whether stored tokens may be sealed: this build matches tokens by digest
	 * only, and the database records an operator's confirmation that every build
	 * serving it does too. Sealing before that would leave placeholders that an
	 * earlier build still serving the database accepts. Once true it stays true,
	 * because the recorded floor only rises.
	 */
	async sealingEnabled(): Promise<boolean> {
		if (this.floorSeen) return true;
		if (INVITE_TOKEN_LOOKUP_VERSION < SEALING_MIN_LOOKUP_VERSION) return false;
		const floor = (await this.lookupFence()).min_serving_lookup_version ?? 0;
		this.floorSeen = floor >= SEALING_MIN_LOOKUP_VERSION;
		return this.floorSeen;
	}

	/** Refuses while this build cannot seal or the database lacks the sealed token columns. */
	private async assertSealingStorage(): Promise<void> {
		if (INVITE_TOKEN_LOOKUP_VERSION < SEALING_MIN_LOOKUP_VERSION)
			throw new InviteTokenSealError("invite_token_lookup_floor_unmet");
		if (!(await this.schemaReady()))
			throw new InviteTokenSealError("invite_token_storage_unavailable");
	}

	private async usableKeyring(): Promise<InviteTokenKeyring> {
		const keyring = await this.keyring();
		keyring.assertCanSeal();
		return keyring;
	}

	/**
	 * Checks that a key can seal, whether or not the floor is recorded yet. A SQLite
	 * coordinator without a configured key creates its key file here. Recording
	 * the floor runs this first, so a missing or unusable key leaves the floor
	 * unrecorded.
	 */
	async prepareSealingKey(): Promise<void> {
		await this.assertSealingStorage();
		await this.usableKeyring();
	}

	/** The keyring for a write that must seal, or the reason none can be made. */
	async requireSealing(): Promise<InviteTokenKeyring> {
		await this.assertSealingStorage();
		if (!(await this.sealingEnabled()))
			throw new InviteTokenSealError(
				"invite_token_lookup_floor_unset",
				"Record the invitation token lookup floor once no earlier build serves this database.",
			);
		return this.usableKeyring();
	}

	/**
	 * The token columns of a row that a statement of the caller writes: a random
	 * placeholder with the sealed token, or, until the lookup floor is recorded,
	 * the bearer token itself with no ciphertext.
	 */
	async seal(
		token: string,
		inviteId: string,
	): Promise<{ stored: string; ciphertext: string | null; keyId: string | null }> {
		if (!(await this.schemaReady()))
			throw new InviteTokenSealError("invite_token_storage_unavailable");
		if (!(await this.sealingEnabled())) return { stored: token, ciphertext: null, keyId: null };
		const sealed = await (await this.requireSealing()).seal(token, inviteId);
		return { ...sealed, stored: sealedInviteTokenPlaceholder() };
	}

	/**
	 * Gives a revoked or expired operation invitation a new sealed token and returns
	 * it with its bearer token. When another write changed the row first, such as
	 * the backfill sealing it, the renewal runs again against the row as it is now,
	 * so it never returns the link of an invitation that is still expired.
	 */
	async renewOperationInvite<T extends RenewableInviteRow>(
		existing: T,
		renewal: InviteRenewal,
		reread: () => Promise<T | null>,
	): Promise<T> {
		let current = existing;
		for (let attempt = 0; attempt < MAX_RENEWAL_ATTEMPTS; attempt += 1) {
			if (!current.revoked_at && current.expires_at > renewal.now)
				return { ...current, token: await this.bearerToken(current) };
			await this.writeRenewal(current, renewal);
			const refreshed = await reread();
			if (!refreshed) throw new Error("invite_operation_reissue_failed");
			if (refreshed.token_digest === renewal.digest) return { ...refreshed, token: renewal.token };
			current = refreshed;
		}
		throw new Error("invite_operation_reissue_failed");
	}

	private async writeRenewal(existing: RenewableInviteRow, renewal: InviteRenewal): Promise<void> {
		const sealed = await this.seal(renewal.token, existing.invite_id);
		await this.backend.run({
			sql: RENEW_OPERATION_INVITE_SQL,
			values: [
				sealed.stored,
				renewal.digest,
				sealed.ciphertext,
				sealed.keyId,
				renewal.expiresAt,
				renewal.now,
				renewal.createdBy,
				renewal.teamName,
				existing.operation_id ?? null,
				existing.token,
				existing.token_digest ?? null,
				renewal.now,
			],
		});
	}

	/**
	 * The bearer token of an invitation that is not consumed, for its link, or null.
	 * One read takes the row's consumed state and its ciphertext together, so a
	 * link read that races a consume returns null or the token, never a consumed
	 * token. A row that still holds its token is sealed by this read.
	 */
	/** The bearer token of an open invitation, refusing one whose link cannot be rebuilt. */
	private async bearerToken(invite: Pick<StoredInviteTokenRow, "invite_id">): Promise<string> {
		const token = await this.linkToken(invite);
		if (!token) throw new InviteTokenRefusal("invite_link_unavailable", 409);
		return token;
	}

	async linkToken(invite: Pick<StoredInviteTokenRow, "invite_id">): Promise<string | null> {
		for (let attempt = 0; attempt < MAX_RENEWAL_ATTEMPTS; attempt += 1) {
			const stored = await this.backend.first<{
				token: string;
				consumed_at: string | null;
				token_ciphertext: string | null;
				token_key_id: string | null;
			}>({
				sql: `SELECT token, consumed_at, token_ciphertext, token_key_id
					FROM coordinator_invites WHERE invite_id = ?`,
				values: [invite.invite_id],
			});
			if (!stored || stored.consumed_at || stored.token.startsWith("consumed:")) return null;
			// Until the floor is recorded nothing is sealed, so the column holds the bearer token.
			if (isPlaintextInviteToken(stored.token) && !(await this.sealingEnabled()))
				return stored.token;
			// A placeholder without ciphertext names no token this coordinator can hand out.
			if (!isPlaintextInviteToken(stored.token) && !stored.token_ciphertext)
				throw new InviteTokenRefusal("invite_link_unavailable", 409);
			const keyring = await this.requireSealing();
			if (!isPlaintextInviteToken(stored.token))
				return this.open(keyring, invite.invite_id, stored);
			// Seal the row; when a consume or another seal changed it first, read it again.
			if ((await this.sealRows(keyring, [{ ...stored, invite_id: invite.invite_id }])) === 1)
				return stored.token;
		}
		throw new InviteTokenSealError("invite_token_unreadable");
	}

	private open(
		keyring: InviteTokenKeyring,
		inviteId: string,
		stored: { token_ciphertext: string | null; token_key_id: string | null },
	): Promise<string> {
		if (!stored.token_ciphertext || !stored.token_key_id)
			throw new InviteTokenSealError("invite_token_unreadable");
		return keyring.open(
			{ ciphertext: stored.token_ciphertext, keyId: stored.token_key_id },
			inviteId,
		);
	}

	/** Seals rows that still hold their token in one statement. Returns how many changed. */
	private async sealRows(
		keyring: InviteTokenKeyring,
		rows: StoredInviteTokenRow[],
	): Promise<number> {
		const sealed = await Promise.all(
			rows.map(async (row) => {
				const { ciphertext, keyId } = await keyring.seal(row.token, row.invite_id);
				const digest = await this.digest(row.token);
				return [
					row.invite_id,
					row.token,
					digest,
					sealedInviteTokenPlaceholder(),
					ciphertext,
					keyId,
				];
			}),
		);
		return this.writeRows(SEAL_ROWS_SQL, sealed);
	}

	protected rows<T>(sql: string, values: unknown[]): Promise<T[]> {
		if (!this.backend.all) throw new Error("invite_token_backend_unavailable");
		return this.backend.all<T>({ sql, values });
	}

	protected async count(sql: string): Promise<number> {
		const row = await this.backend.first<{ count: number }>({ sql, values: [] });
		return Number(row?.count ?? 0);
	}

	/** One statement for all rows, or none for an empty batch. Returns the rows it changed. */
	protected async writeRows(sql: string, rows: unknown[][]): Promise<number> {
		if (rows.length === 0) return 0;
		return this.backend.run({ sql, values: [JSON.stringify(rows)] });
	}

	private async hashJoinRequests(batch: number): Promise<number> {
		const requests = await this.rows<{ request_id: string; token: string }>(
			`SELECT request_id, token FROM coordinator_join_requests WHERE ${PLAINTEXT_TOKEN_SQL}
				ORDER BY request_id LIMIT ?`,
			[batch],
		);
		return this.writeRows(
			HASH_JOIN_REQUESTS_SQL,
			await Promise.all(
				requests.map(async (row) => [
					row.request_id,
					row.token,
					joinRequestStoredToken(await this.digest(row.token)),
				]),
			),
		);
	}

	private remainingPlaintextJoinRequests(): Promise<number> {
		return this.count(
			`SELECT COUNT(*) AS count FROM coordinator_join_requests WHERE ${PLAINTEXT_TOKEN_SQL}`,
		);
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
		const filled = await this.writeRows(
			FILL_INVITE_DIGESTS_SQL,
			await Promise.all(
				invites.map(async (row) => [row.invite_id, row.token, await this.digest(row.token)]),
			),
		);
		return {
			filled_invites: filled,
			hashed_join_requests: await this.hashJoinRequests(batch),
			remaining_invites_without_digest: await this.count(
				`SELECT COUNT(*) AS count FROM coordinator_invites WHERE ${INVITES_WITHOUT_DIGEST_SQL}`,
			),
			remaining_plaintext_join_requests: await this.remainingPlaintextJoinRequests(),
		};
	}

	/**
	 * One batch of the sealing backfill: seals invitations that still hold their
	 * token, drops ciphertext that consumed invitations kept, and replaces join
	 * request copies of a token with its digest. Each table takes one read and one
	 * write. Run it until all three remaining counts are 0. It refuses until the
	 * lookup floor is recorded.
	 */
	async sealStoredTokens(limit: number): Promise<InviteTokenSealProgress> {
		const batch = inviteTokenBatch(limit);
		const keyring = await this.requireSealing();
		const invites = await this.rows<StoredInviteTokenRow>(
			`SELECT invite_id, token, token_digest FROM coordinator_invites WHERE ${PLAINTEXT_TOKEN_SQL}
				ORDER BY invite_id LIMIT ?`,
			[batch],
		);
		const sealedInvites = await this.sealRows(keyring, invites);
		const clearedSpent = await this.backend.run({
			sql: `UPDATE coordinator_invites SET token_ciphertext = NULL, token_key_id = NULL
				WHERE invite_id IN (SELECT invite_id FROM coordinator_invites
					WHERE ${SPENT_CIPHERTEXT_SQL} ORDER BY invite_id LIMIT ?)`,
			values: [batch],
		});
		return {
			sealed_invites: sealedInvites,
			cleared_spent_invites: clearedSpent,
			hashed_join_requests: await this.hashJoinRequests(batch),
			remaining_plaintext_invites: await this.count(
				`SELECT COUNT(*) AS count FROM coordinator_invites WHERE ${PLAINTEXT_TOKEN_SQL}`,
			),
			remaining_plaintext_join_requests: await this.remainingPlaintextJoinRequests(),
			remaining_spent_ciphertext: await this.count(
				`SELECT COUNT(*) AS count FROM coordinator_invites WHERE ${SPENT_CIPHERTEXT_SQL}`,
			),
		};
	}

	/** The invitation token digest a join request was made with. */
	async joinRequestDigest(stored: string): Promise<string> {
		return joinRequestStoredDigest(stored) ?? (await this.digest(stored));
	}
}
