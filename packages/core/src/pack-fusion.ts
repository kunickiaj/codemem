import type { MemoryResult, PackFusionEvidence } from "./types.js";

/** Equal-weight reciprocal rank fusion; 60 dampens differences near the top. */
export const PACK_RRF_RANK_CONSTANT = 60;

function rankChannel(results: MemoryResult[]): MemoryResult[] {
	const seen = new Set<number>();
	return results
		.filter((item) => Number.isSafeInteger(item.id) && item.id > 0 && Number.isFinite(item.score))
		.toSorted((a, b) => b.score - a.score || a.id - b.id)
		.filter((item) => {
			if (seen.has(item.id)) return false;
			seen.add(item.id);
			return true;
		});
}

/** Rank only within each raw-score scale. Never replace a result's public score. */
export function fusePackCandidates(
	fts: MemoryResult[],
	semantic: MemoryResult[],
	secondaryScore: (item: MemoryResult) => number,
): Array<{ item: MemoryResult; evidence: PackFusionEvidence }> {
	const candidates = new Map<number, { item: MemoryResult; evidence: PackFusionEvidence }>();
	for (const [channel, results] of [
		["fts", fts],
		["semantic", semantic],
	] as const) {
		for (const [index, item] of rankChannel(results).entries()) {
			const rank = index + 1;
			const entry = candidates.get(item.id) ?? {
				item,
				evidence: {
					fts_score: null,
					fts_rank: null,
					semantic_score: null,
					semantic_rank: null,
					fused_score: 0,
					rank_constant: PACK_RRF_RANK_CONSTANT,
					fusion_rank: 0,
					secondary_score: secondaryScore(item),
				},
			};
			entry.evidence[`${channel}_score`] = item.score;
			entry.evidence[`${channel}_rank`] = rank;
			entry.evidence.fused_score += 1 / (PACK_RRF_RANK_CONSTANT + rank);
			candidates.set(item.id, entry);
		}
	}
	const ranked = [...candidates.values()].sort(
		(a, b) =>
			b.evidence.fused_score - a.evidence.fused_score ||
			b.evidence.secondary_score - a.evidence.secondary_score ||
			a.item.id - b.item.id,
	);
	return ranked.map((entry, index) => ({
		...entry,
		evidence: { ...entry.evidence, fusion_rank: index + 1 },
	}));
}
