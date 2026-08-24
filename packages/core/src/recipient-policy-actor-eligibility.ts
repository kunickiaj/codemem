import type { Database } from "./db.js";

export interface RecipientPolicyActorEligibilityState {
	status: string;
	mergedIntoActorId: string | null;
}

export function isActiveUnmergedActorState(
	actor: RecipientPolicyActorEligibilityState | null | undefined,
): boolean {
	return actor?.status === "active" && actor.mergedIntoActorId === null;
}

function actorEligibility(
	db: Database,
	actorId: string,
): (RecipientPolicyActorEligibilityState & { isLocal: boolean }) | null {
	const row = db
		.prepare("SELECT is_local, status, merged_into_actor_id FROM actors WHERE actor_id = ? LIMIT 1")
		.get(actorId) as
		| { is_local: number; status: string; merged_into_actor_id: string | null }
		| undefined;
	return row
		? {
				isLocal: row.is_local === 1,
				status: row.status,
				mergedIntoActorId: row.merged_into_actor_id,
			}
		: null;
}

export function isActiveUnmergedActor(db: Database, actorId: string): boolean {
	return isActiveUnmergedActorState(actorEligibility(db, actorId));
}

export function isActiveUnmergedLocalActor(db: Database, actorId: string): boolean {
	const actor = actorEligibility(db, actorId);
	return actor?.isLocal === true && isActiveUnmergedActorState(actor);
}

export function activeUnmergedActorIds(db: Database): string[] {
	return db
		.prepare(
			"SELECT actor_id FROM actors WHERE status = 'active' AND merged_into_actor_id IS NULL ORDER BY actor_id",
		)
		.pluck()
		.all() as string[];
}

export function activeUnmergedActorIdsFor(db: Database, actorIds: readonly string[]): string[] {
	const uniqueActorIds = [...new Set(actorIds)];
	if (uniqueActorIds.length === 0) return [];
	return db
		.prepare(
			`SELECT actor_id FROM actors
			 WHERE actor_id IN (${uniqueActorIds.map(() => "?").join(", ")})
			   AND status = 'active' AND merged_into_actor_id IS NULL
			 ORDER BY actor_id`,
		)
		.pluck()
		.all(...uniqueActorIds) as string[];
}

export function preferredActiveUnmergedLocalActorId(
	db: Database,
	primaryActorId: string,
	secondaryActorId: string,
): string | null {
	if (isActiveUnmergedLocalActor(db, primaryActorId)) return primaryActorId;
	if (secondaryActorId !== primaryActorId && isActiveUnmergedLocalActor(db, secondaryActorId)) {
		return secondaryActorId;
	}
	return (
		(db
			.prepare(
				`SELECT actor_id FROM actors
				 WHERE is_local = 1 AND status = 'active' AND merged_into_actor_id IS NULL
				 ORDER BY actor_id LIMIT 1`,
			)
			.pluck()
			.get() as string | undefined) ?? null
	);
}
