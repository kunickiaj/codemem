import { createHash } from "node:crypto";
import type { Database } from "../db.js";
import { resolveSameActorPeerIds } from "../same-actor-peers.js";
import type { AutomaticContext } from "../types.js";
import type { RankInput, RankOutput } from "./semantic-worker-protocol.js";
import {
	isSearchableVectorCatalog,
	rankValidatedIndex,
	readCatalog,
} from "./validated-vector-index.js";

export function contentIdentity(row: Record<string, unknown>): string {
	return createHash("sha256").update(JSON.stringify(row)).digest("hex");
}

export function summarySessionId(
	db: Database,
	context: AutomaticContext | null | undefined,
): number | null | undefined {
	if (context === undefined) return undefined;
	if (context === null) return null;
	const source = context.source.trim().toLowerCase();
	const streamId = context.hostSessionId.trim();
	if (!source || !streamId || streamId.toLowerCase() === "unknown") return null;
	const row = db
		.prepare("SELECT session_id FROM opencode_sessions WHERE source = ? AND stream_id = ? LIMIT 1")
		.get(source, streamId) as { session_id: number | null } | undefined;
	return row?.session_id ?? null;
}

/** Authorization, continuity, model selection, ranking and identities share one short read snapshot. */
export function rankWorkerInput(db: Database, input: RankInput): RankOutput | null {
	return db.transaction(() => {
		const catalog = readCatalog(db);
		if (!isSearchableVectorCatalog(db, catalog) || catalog.generationId !== input.generationId)
			return null;
		const claimedDeviceIds = resolveSameActorPeerIds(db, input.proof.actorId);
		const ranked = rankValidatedIndex(db, {
			query: { model: input.embeddingIdentity, vectors: [input.embedding] },
			limit: input.limit,
			filters: input.filters,
			context: {
				...input.proof,
				claimedDeviceIds,
				legacyActorIds: claimedDeviceIds.map((id) => `legacy-sync:${id}`),
				scopeVisibilityDb: db,
			},
			summarySessionId: summarySessionId(db, input.automaticContext),
		});
		if (!ranked || ranked.generationId !== input.generationId) return null;
		return {
			generationId: ranked.generationId,
			revision: ranked.revision,
			models: ranked.models,
			candidateVersions: ranked.candidateVersions,
			candidates: ranked.results.map((row) => {
				const raw = db.prepare("SELECT * FROM memory_items WHERE id = ?").get(row.id) as Record<
					string,
					unknown
				>;
				return {
					id: row.id,
					distance: row.distance,
					contentIdentity: contentIdentity(raw),
				};
			}),
		};
	})();
}
