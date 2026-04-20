/* People / actor derivations — detect duplicate-person candidates by
 * normalised display-name collision, and compute the visible actor
 * list that hides unassigned local duplicates so the People tab does
 * not show two entries for the same teammate. */

import { cleanText, normalizeDisplayName } from "./internal";
import type { ActorLike, PeerLike, UiDuplicatePersonCandidate, VisiblePeopleResult } from "./types";

export function deriveDuplicatePeople(actors: ActorLike[]): UiDuplicatePersonCandidate[] {
	const groups = new Map<string, UiDuplicatePersonCandidate>();
	(Array.isArray(actors) ? actors : []).forEach((actor) => {
		const displayName = cleanText(actor?.display_name);
		const actorId = cleanText(actor?.actor_id);
		const normalized = normalizeDisplayName(displayName);
		if (!displayName || !actorId || !normalized) return;
		const current = groups.get(normalized) ?? {
			displayName,
			actorIds: [],
			includesLocal: false,
		};
		current.actorIds = [...current.actorIds, actorId];
		current.includesLocal = current.includesLocal || Boolean(actor?.is_local);
		groups.set(normalized, current);
	});
	return [...groups.values()]
		.filter((item) => item.actorIds.length > 1)
		.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function deriveVisiblePeopleActors(input: {
	actors?: ActorLike[];
	peers?: PeerLike[];
	duplicatePeople?: UiDuplicatePersonCandidate[];
}): VisiblePeopleResult {
	const actors = Array.isArray(input.actors) ? input.actors : [];
	const peers = Array.isArray(input.peers) ? input.peers : [];
	const duplicatePeople = Array.isArray(input.duplicatePeople) ? input.duplicatePeople : [];
	const assignedCounts = new Map<string, number>();
	peers.forEach((peer) => {
		const actorId = cleanText(peer?.actor_id);
		if (!actorId) return;
		assignedCounts.set(actorId, (assignedCounts.get(actorId) ?? 0) + 1);
	});

	const hiddenIds = new Set<string>();
	duplicatePeople.forEach((candidate) => {
		if (!candidate.includesLocal) return;
		candidate.actorIds.forEach((actorId) => {
			const actor = actors.find((item) => cleanText(item?.actor_id) === actorId);
			if (!actor || actor.is_local) return;
			if ((assignedCounts.get(actorId) ?? 0) > 0) return;
			hiddenIds.add(actorId);
		});
	});

	return {
		visibleActors: actors.filter((actor) => !hiddenIds.has(cleanText(actor?.actor_id))),
		hiddenLocalDuplicateCount: hiddenIds.size,
	};
}
