/**
 * Sync bootstrap: client-side snapshot consumer for re-bootstrapping
 * shared memories from a peer when the incremental op log is no longer
 * sufficient (generation mismatch, stale cursor beyond retained floor).
 *
 * The bootstrap protocol:
 * 1. Fetch paginated snapshot pages from GET /v1/snapshot
 * 2. Collect all canonical shared memory items (including tombstones)
 * 3. In a single transaction: wipe local shared memories, apply snapshot,
 *    update replication cursor to baseline_cursor, bump generation
 */

import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { ApiSyncMemorySnapshotPageResponse } from "./api-types.js";
import type { Database } from "./db.js";
import { toJson } from "./db.js";
import * as schema from "./schema.js";
import { redactMemoryFields, SecretScanner } from "./secret-scanner.js";
import { buildAuthHeaders } from "./sync-auth.js";
import { LOCAL_SYNC_CAPABILITY, SYNC_CAPABILITY_HEADER } from "./sync-capability.js";
import { requestJson } from "./sync-http-client.js";
import { setReplicationCursor, setSyncResetState } from "./sync-replication.js";
import type { SyncMemorySnapshotItem, SyncResetRequired } from "./types.js";
import { queueVectorBackfillForSyncBootstrap } from "./vector-migration.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BootstrapResult {
	ok: boolean;
	applied: number;
	deleted: number;
	error?: string;
}

export interface BootstrapOptions {
	keysDir?: string;
	bootstrapGrantId?: string;
	/** Max items per page request. Defaults to 200. */
	pageSize?: number;
	/** Timeout per HTTP request in seconds. Defaults to 10. */
	timeoutS?: number;
	/** Safety cap on total snapshot items. Defaults to 100,000. */
	maxItems?: number;
}

// ---------------------------------------------------------------------------
// Snapshot page fetcher
// ---------------------------------------------------------------------------

type SnapshotPageResponse = ApiSyncMemorySnapshotPageResponse;

/**
 * Fetch all snapshot pages from a peer's /v1/snapshot endpoint.
 * Returns the full list of items and the boundary metadata.
 */
export async function fetchAllSnapshotPages(
	baseUrl: string,
	resetInfo: SyncResetRequired,
	deviceId: string,
	options?: BootstrapOptions,
): Promise<{
	items: SyncMemorySnapshotItem[];
	generation: number;
	snapshot_id: string;
	baseline_cursor: string | null;
}> {
	const pageSize = options?.pageSize ?? 200;
	const timeoutS = options?.timeoutS ?? 10;
	const keysDir = options?.keysDir;
	const bootstrapGrantId = options?.bootstrapGrantId?.trim() || undefined;
	const maxItems = options?.maxItems ?? 100_000;

	const allItems: SyncMemorySnapshotItem[] = [];
	let pageToken: string | null = null;
	let boundary: { generation: number; snapshot_id: string; baseline_cursor: string | null } | null =
		null;

	for (;;) {
		const params = new URLSearchParams({
			generation: String(resetInfo.generation),
			snapshot_id: resetInfo.snapshot_id,
			limit: String(pageSize),
		});
		if (resetInfo.baseline_cursor) {
			params.set("baseline_cursor", resetInfo.baseline_cursor);
		}
		if (pageToken) {
			params.set("page_token", pageToken);
		}

		const url = `${baseUrl}/v1/snapshot?${params.toString()}`;
		const headers = {
			...buildAuthHeaders({
				deviceId,
				method: "GET",
				url,
				bodyBytes: Buffer.alloc(0),
				bootstrapGrantId,
				keysDir,
			}),
			[SYNC_CAPABILITY_HEADER]: LOCAL_SYNC_CAPABILITY,
		};

		const [status, payload] = await requestJson("GET", url, { headers, timeoutS });
		if (status !== 200 || !payload) {
			const detail = payload?.error ? String(payload.error) : `status ${status}`;
			throw new Error(`snapshot fetch failed: ${detail}`);
		}

		const page = payload as unknown as SnapshotPageResponse;
		if (!Array.isArray(page.items) || page.generation == null) {
			throw new Error("invalid snapshot response shape");
		}

		boundary = {
			generation: page.generation,
			snapshot_id: page.snapshot_id,
			baseline_cursor: page.baseline_cursor,
		};
		allItems.push(...page.items);

		if (allItems.length > maxItems) {
			throw new Error(
				`snapshot too large: ${allItems.length} items exceeds safety limit of ${maxItems}`,
			);
		}

		if (!page.has_more || !page.next_page_token) {
			break;
		}
		pageToken = page.next_page_token;
	}

	if (!boundary) {
		throw new Error("no snapshot pages returned");
	}

	return { items: allItems, ...boundary };
}

// ---------------------------------------------------------------------------
// Local application
// ---------------------------------------------------------------------------

/**
 * Parse a snapshot item's payload_json into memory fields.
 * Returns null if the payload is malformed.
 */
function parseSnapshotPayload(item: SyncMemorySnapshotItem): Record<string, unknown> | null {
	if (!item.payload_json) return null;
	try {
		const parsed = JSON.parse(item.payload_json);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

function isEmbeddableSnapshotPayload(payload: Record<string, unknown>): boolean {
	const title = typeof payload.title === "string" ? payload.title : "";
	const bodyText = typeof payload.body_text === "string" ? payload.body_text : "";
	return `${title}\n${bodyText}`.trim().length > 0;
}

const bootstrapSessionCache = new Map<string, number>();

function ensureSessionForBootstrap(
	d: ReturnType<typeof drizzle>,
	updatedAt: string,
	project?: string | null,
): number {
	const projectKey = project ?? "__none__";
	const cached = bootstrapSessionCache.get(projectKey);
	if (cached != null) return cached;

	const cwd = project ? `__sync_bootstrap__:${project}` : "__sync_bootstrap__";
	const existing = d
		.select({ id: schema.sessions.id })
		.from(schema.sessions)
		.where(eq(schema.sessions.cwd, cwd))
		.limit(1)
		.get();
	if (existing) {
		bootstrapSessionCache.set(projectKey, existing.id);
		return existing.id;
	}

	const rows = d
		.insert(schema.sessions)
		.values({
			started_at: updatedAt,
			cwd,
			project: project ?? null,
			user: "sync",
			tool_version: "bootstrap",
		})
		.returning({ id: schema.sessions.id })
		.all();
	const id = rows[0]?.id ?? 0;
	bootstrapSessionCache.set(projectKey, id);
	return id;
}

/**
 * Apply a bootstrap snapshot to the local database, atomically replacing
 * all shared memories with the snapshot contents.
 *
 * This runs in a single IMMEDIATE transaction:
 * 1. Delete all local shared-visibility memory_items (preserving private)
 * 2. Insert all snapshot items (upsert handles tombstones via active/deleted_at)
 * 3. Update the replication cursor to baseline_cursor
 * 4. Bump the local generation + snapshot_id to match the peer
 */
export function applyBootstrapSnapshot(
	db: Database,
	peerDeviceId: string,
	items: SyncMemorySnapshotItem[],
	resetInfo: SyncResetRequired,
	scanner?: SecretScanner,
): BootstrapResult {
	const result: BootstrapResult = { ok: false, applied: 0, deleted: 0 };
	// Bootstrap items are peer-authored content. Run them through the same
	// scanner as locally-authored writes; without this, a single bootstrap
	// from a misbehaving peer could re-populate the local store with secrets
	// the peer emitted before they ran scanner-aware versions.
	const activeScanner = scanner ?? new SecretScanner();

	db.transaction(() => {
		const d = drizzle(db, { schema });
		let embeddableApplied = 0;

		// 1. Delete all local sync-eligible memories that have been synced.
		// - Only memories with import_key (i.e. previously synced) are deleted.
		// - Only explicitly private memories are preserved; NULL visibility is
		//   treated as sync-eligible (matching syncVisibilityAllowed semantics)
		//   to avoid leaving stale rows that could create duplicate import_keys.
		// - The dirty-local gate in sync-pass ensures we only reach here when
		//   no unsynced shared changes exist.
		const deleteResult = d
			.delete(schema.memoryItems)
			.where(
				and(
					isNotNull(schema.memoryItems.import_key),
					ne(sql`COALESCE(${schema.memoryItems.visibility}, '')`, "private"),
				),
			)
			.run();
		result.deleted = deleteResult.changes;

		// 2. Insert snapshot items, grouping by project.
		bootstrapSessionCache.clear();

		for (const item of items) {
			const payload = parseSnapshotPayload(item);
			if (!payload) continue;
			redactMemoryFields(payload, activeScanner);
			const project =
				typeof payload.project === "string" && payload.project.trim()
					? payload.project.trim()
					: null;
			const sessionId = ensureSessionForBootstrap(d, new Date().toISOString(), project);

			const metaRaw = payload.metadata_json;
			const meta =
				metaRaw && typeof metaRaw === "object" && !Array.isArray(metaRaw)
					? (metaRaw as Record<string, unknown>)
					: {};
			meta.clock_device_id = item.clock_device_id;

			const isDeleted = item.op_type === "delete";
			if (!isDeleted && isEmbeddableSnapshotPayload(payload)) {
				embeddableApplied++;
			}

			d.insert(schema.memoryItems)
				.values({
					session_id: sessionId,
					kind: typeof payload.kind === "string" ? payload.kind : "discovery",
					title: typeof payload.title === "string" ? payload.title : "",
					subtitle: typeof payload.subtitle === "string" ? payload.subtitle : null,
					body_text: typeof payload.body_text === "string" ? payload.body_text : "",
					confidence: typeof payload.confidence === "number" ? payload.confidence : 0.5,
					tags_text: typeof payload.tags_text === "string" ? payload.tags_text : "",
					active: isDeleted ? 0 : 1,
					created_at:
						typeof payload.created_at === "string" ? payload.created_at : item.clock_updated_at,
					updated_at: item.clock_updated_at,
					metadata_json: toJson(meta),
					import_key: item.entity_id,
					deleted_at: isDeleted ? item.clock_updated_at : null,
					rev: item.clock_rev,
					actor_id: typeof payload.actor_id === "string" ? payload.actor_id : null,
					actor_display_name:
						typeof payload.actor_display_name === "string" ? payload.actor_display_name : null,
					visibility: typeof payload.visibility === "string" ? payload.visibility : "shared",
					workspace_id:
						typeof payload.workspace_id === "string" ? payload.workspace_id : "shared:default",
					workspace_kind:
						typeof payload.workspace_kind === "string" ? payload.workspace_kind : "shared",
					origin_device_id:
						typeof payload.origin_device_id === "string"
							? payload.origin_device_id
							: item.clock_device_id,
					origin_source: typeof payload.origin_source === "string" ? payload.origin_source : null,
					trust_state: typeof payload.trust_state === "string" ? payload.trust_state : "trusted",
					narrative: typeof payload.narrative === "string" ? payload.narrative : null,
					facts: Array.isArray(payload.facts) ? JSON.stringify(payload.facts) : null,
					concepts: Array.isArray(payload.concepts) ? JSON.stringify(payload.concepts) : null,
					files_read: Array.isArray(payload.files_read) ? JSON.stringify(payload.files_read) : null,
					files_modified: Array.isArray(payload.files_modified)
						? JSON.stringify(payload.files_modified)
						: null,
					user_prompt_id:
						typeof payload.user_prompt_id === "number" ? payload.user_prompt_id : null,
					prompt_number: typeof payload.prompt_number === "number" ? payload.prompt_number : null,
					scope_id: typeof payload.scope_id === "string" ? payload.scope_id : null,
				})
				.run();
			result.applied++;
		}

		// 3. Update replication cursor to baseline_cursor.
		if (resetInfo.baseline_cursor) {
			setReplicationCursor(db, peerDeviceId, {
				lastApplied: resetInfo.baseline_cursor,
			});
		}

		// 4. Bump local generation + snapshot_id to match the peer.
		setSyncResetState(db, {
			generation: resetInfo.generation,
			snapshot_id: resetInfo.snapshot_id,
			baseline_cursor: resetInfo.baseline_cursor,
		});

		queueVectorBackfillForSyncBootstrap(db, { embeddableTotal: embeddableApplied });

		result.ok = true;
	}).immediate();

	return result;
}
