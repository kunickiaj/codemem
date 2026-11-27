/**
 * The memory reads that decide what an Identity may see, as functions over a connection
 * and an Identity.
 *
 * `MemoryStore` answers `get`, `recent`, `recentByKinds` and its ownership checks through
 * these functions. {@link createMemoryReadHandle} answers the same questions on any
 * connection, including a read-only one, for an Identity it is given. It reads no
 * configuration, environment or key file, so code that runs away from the store, such as a
 * worker thread, sees exactly what the store would show that Identity.
 */
import { and, type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { type Database, fromJson } from "./db.js";
import { buildFilterClausesWithContext, type OwnershipFilterContext } from "./filters.js";
import { resolveSameActorPeerIds } from "./same-actor-peers.js";
import * as schema from "./schema.js";
import { resolveVisibleScopeIds, type ScopeVisibilityOptions } from "./scope-visibility.js";
import type { StoreHandle } from "./search.js";
import { summaryContinuityFilter } from "./summary-memory.js";
import type { MemoryFilters, MemoryItem, MemoryItemResponse, MemoryResult } from "./types.js";

type OwnedItem = MemoryItem | MemoryResult | Record<string, unknown>;

/** Whose reads these are: the acting person and the device they act from. */
interface ReaderIdentity {
	readonly actorId: string;
	readonly deviceId: string;
}

/** What building the ownership and scope-visibility filter context needs from a reader. */
interface FilterContextSource extends ReaderIdentity {
	readonly db: Database;
	sameActorPeerIds(): string[];
}

/** What snapshotting the ownership predicate needs from a reader. */
interface OwnershipSource extends ReaderIdentity {
	sameActorPeerIds(): string[];
}

/** What a filtered memory query needs from a reader. */
interface FilteredQuerySource {
	readonly db: Database;
	ownershipFilterContext(): OwnershipFilterContext;
}

/** Trim a string value, returning null for empty/non-string. Matches Python's _clean_optional_str. */
export function cleanStr(value: unknown): string | null {
	if (value == null || typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function countQuestionPlaceholders(clause: string): number {
	return (clause.match(/\?/g) ?? []).length;
}

function sqlFromParameterizedClause(clause: string, params: unknown[]): SQL {
	const parts = clause.split("?");
	let acc: SQL = sql.raw(parts[0] ?? "");
	for (let i = 1; i < parts.length; i++) {
		acc = sql`${acc}${params[i - 1]}${sql.raw(parts[i] ?? "")}`;
	}
	return acc;
}

function buildWhereSql(clauses: string[], params: unknown[]): SQL {
	const sqlClauses: SQL[] = [];
	let cursor = 0;
	for (const clause of clauses) {
		const count = countQuestionPlaceholders(clause);
		const clauseParams = params.slice(cursor, cursor + count);
		sqlClauses.push(sqlFromParameterizedClause(clause, clauseParams));
		cursor += count;
	}
	if (cursor !== params.length) {
		throw new Error("filter parameter mismatch while building SQL clauses");
	}
	if (sqlClauses.length === 1) return sqlClauses[0] ?? sql`1=1`;
	const combined = and(...sqlClauses);
	if (!combined) throw new Error("failed to combine filter SQL clauses");
	return combined;
}

/**
 * Parse a row's metadata_json string into a plain object.
 * Returns a new MemoryItemResponse with metadata_json as a parsed object.
 */
function parseMetadata(row: MemoryItem): MemoryItemResponse {
	const { metadata_json, ...rest } = row;
	return { ...rest, metadata_json: fromJson(metadata_json) };
}

const queryWrappers = new WeakMap<Database, ReturnType<typeof drizzle>>();

/** One Drizzle wrapper per connection, for the parameterized SQL the filters produce. */
function queries(db: Database): ReturnType<typeof drizzle> {
	let wrapper = queryWrappers.get(db);
	if (!wrapper) {
		wrapper = drizzle(db, { schema });
		queryWrappers.set(db, wrapper);
	}
	return wrapper;
}

/**
 * Build the ownership/scope-visibility filter context for SQL filter
 * builders. Snapshots claimed same-actor peers (and their legacy-sync actor
 * ids) once so `ownership_scope=mine/theirs` SQL matches
 * {@link snapshotOwnershipPredicate}.
 */
export function resolveOwnershipFilterContext(
	reader: FilterContextSource,
	options: ScopeVisibilityOptions,
): OwnershipFilterContext {
	const claimedDeviceIds = reader.sameActorPeerIds();
	return {
		actorId: reader.actorId,
		deviceId: reader.deviceId,
		claimedDeviceIds,
		legacyActorIds: claimedDeviceIds.map((peerId) => `legacy-sync:${peerId}`),
		enforceScopeVisibility: true,
		// Resolve the visible scope set once per request so the SQL filter can
		// use the index-eligible `scope_id IN (...)` fast path instead of the
		// per-row EXISTS predicate. Fronts get()/recent()/recentByKinds() and
		// every viewer-server route.
		visibleScopeIds: resolveVisibleScopeIds(reader.db, reader.deviceId, options),
		scopeVisibilityDb: reader.db,
		expectedPublicKey: options.expectedPublicKey,
		loadExpectedPublicKey: options.loadExpectedPublicKey,
	};
}

/** Who wrote an item and from which device, from its columns or else its metadata. */
function authorOf(item: OwnedItem): { actorId: string | null; deviceId: string | null } {
	const rec = item as Record<string, unknown>;
	let meta = (rec.metadata ?? {}) as Record<string, unknown>;
	if (!rec.metadata && typeof rec.metadata_json === "string") {
		meta = fromJson(rec.metadata_json);
	}
	return {
		actorId: cleanStr(rec.actor_id) ?? cleanStr(meta.actor_id),
		deviceId: cleanStr(rec.origin_device_id) ?? cleanStr(meta.origin_device_id),
	};
}

/**
 * Snapshot the current ownership state into a fast inline predicate.
 *
 * The closure captures the actor + device + claimed-peer sets at construction
 * time and returns synchronous boolean checks without touching sqlite. Because
 * the snapshot is frozen, callers should rebuild the predicate once per request.
 */
export function snapshotOwnershipPredicate(reader: OwnershipSource): (item: OwnedItem) => boolean {
	const peerIds = reader.sameActorPeerIds();
	const claimedDeviceIds = new Set(peerIds);
	const legacyActorIds = new Set(peerIds.map((peerId) => `legacy-sync:${peerId}`));
	const ownerActorId = reader.actorId;
	const ownerDeviceId = reader.deviceId;
	return (item) => {
		const { actorId, deviceId } = authorOf(item);
		if (actorId === ownerActorId) return true;
		if (deviceId === ownerDeviceId) return true;
		if (deviceId && claimedDeviceIds.has(deviceId)) return true;
		if (actorId && legacyActorIds.has(actorId)) return true;
		return false;
	};
}

/**
 * Fetch a single memory item by ID.
 * Returns null if not found (does not filter by active status).
 */
export function getMemory(
	reader: FilteredQuerySource,
	memoryId: number,
): MemoryItemResponse | null {
	const filterResult = buildFilterClausesWithContext(null, reader.ownershipFilterContext());
	const whereSql = buildWhereSql(
		["memory_items.id = ?", ...filterResult.clauses],
		[memoryId, ...filterResult.params],
	);
	const row = queries(reader.db).get<MemoryItem>(
		sql`SELECT memory_items.* FROM memory_items WHERE ${whereSql}`,
	);
	if (!row) return null;
	return parseMetadata(row);
}

/**
 * Which of `memoryIds` may be delivered to the reader now: memories it may see that are
 * active and not deleted. {@link getMemory} also returns a forgotten memory to a reader who
 * may see it. A pack must not.
 */
export function deliverableMemoryIds(
	reader: FilteredQuerySource,
	memoryIds: readonly number[],
): Set<number> {
	if (memoryIds.length === 0) return new Set();
	const filterResult = buildFilterClausesWithContext(null, reader.ownershipFilterContext());
	const whereSql = buildWhereSql(
		[
			"memory_items.id IN (SELECT value FROM json_each(?))",
			"memory_items.active = 1",
			"memory_items.deleted_at IS NULL",
			...filterResult.clauses,
		],
		[JSON.stringify(memoryIds), ...filterResult.params],
	);
	const rows = queries(reader.db).all<{ id: number }>(
		sql`SELECT memory_items.id FROM memory_items WHERE ${whereSql}`,
	);
	return new Set(rows.map((row) => row.id));
}

export interface RecentMemoriesQuery {
	limit: number;
	filters: MemoryFilters | null | undefined;
	offset: number;
	summarySessionId: number | null | undefined;
}

/** Recent active memories matching `baseClauses`, newest first. */
function recentMatching(
	reader: FilteredQuerySource,
	base: { clauses: string[]; params: unknown[] },
	query: RecentMemoriesQuery,
): MemoryItemResponse[] {
	const filterResult = buildFilterClausesWithContext(
		query.filters,
		reader.ownershipFilterContext(),
	);
	// Automatic continuity applies inside the query so LIMIT counts eligible rows only.
	const continuity = summaryContinuityFilter(query.summarySessionId);
	const allClauses = [...base.clauses, ...filterResult.clauses, ...continuity.clauses];
	const params = [...base.params, ...filterResult.params, ...continuity.params];
	const whereSql = buildWhereSql(allClauses, params);

	const fromSql = filterResult.joinSessions
		? sql.raw("memory_items JOIN sessions ON sessions.id = memory_items.session_id")
		: sql.raw("memory_items");

	const rows = queries(reader.db).all<MemoryItem>(
		sql`SELECT memory_items.* FROM ${fromSql}
				WHERE ${whereSql}
				ORDER BY created_at DESC, id DESC
				LIMIT ${query.limit} OFFSET ${Math.max(query.offset, 0)}`,
	);

	return rows.map((row) => parseMetadata(row));
}

/** Return recent active memories, newest first. */
export function recentMemories(
	reader: FilteredQuerySource,
	query: RecentMemoriesQuery,
): MemoryItemResponse[] {
	return recentMatching(reader, { clauses: ["memory_items.active = 1"], params: [] }, query);
}

/** Return recent active memories filtered to specific kinds, newest first. */
export function recentMemoriesByKinds(
	reader: FilteredQuerySource,
	kinds: string[],
	query: RecentMemoriesQuery,
): MemoryItemResponse[] {
	const kindsList = kinds.filter((k) => k.length > 0);
	if (kindsList.length === 0) return [];

	const kindPlaceholders = kindsList.map(() => "?").join(", ");
	return recentMatching(
		reader,
		{
			clauses: ["memory_items.active = 1", `memory_items.kind IN (${kindPlaceholders})`],
			params: kindsList,
		},
		query,
	);
}

/** The Identity a read handle answers for, with the device's actual public key if it has one. */
export interface MemoryReadIdentity extends ReaderIdentity {
	/** Public key of the device's signing key, already loaded by whoever vouches for it. */
	readonly expectedPublicKey: string | undefined;
}

/**
 * The store's reads for one fixed Identity on `db`. Everything it knows about who is
 * reading comes from `identity`: it loads no key and reads no configuration.
 */
export function createMemoryReadHandle(db: Database, identity: MemoryReadIdentity): StoreHandle {
	const scopeVisibility: ScopeVisibilityOptions = {
		expectedPublicKey: identity.expectedPublicKey,
	};
	const reader = {
		db,
		actorId: identity.actorId,
		deviceId: identity.deviceId,
		sameActorPeerIds: () => resolveSameActorPeerIds(db, identity.actorId),
		ownershipFilterContext: () => resolveOwnershipFilterContext(reader, scopeVisibility),
	};
	const query = (
		limit: number | undefined,
		filters: MemoryFilters | null | undefined,
		offset: number | undefined,
		summarySessionId: number | null | undefined,
	): RecentMemoriesQuery => ({
		limit: limit ?? 10,
		filters,
		offset: offset ?? 0,
		summarySessionId,
	});
	return {
		db,
		actorId: identity.actorId,
		deviceId: identity.deviceId,
		scopeResolutionDeviceContext: () => ({ ...scopeVisibility }),
		sameActorPeerIds: reader.sameActorPeerIds,
		get: (memoryId) => getMemory(reader, memoryId),
		memoryOwnedBySelf: (item) => snapshotOwnershipPredicate(reader)(item),
		buildOwnershipPredicate: () => snapshotOwnershipPredicate(reader),
		recent: (limit, filters, offset, summarySessionId) =>
			recentMemories(reader, query(limit, filters, offset, summarySessionId)),
		recentByKinds: (kinds, limit, filters, offset, summarySessionId) =>
			recentMemoriesByKinds(reader, kinds, query(limit, filters, offset, summarySessionId)),
	};
}
