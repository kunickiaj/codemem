import { connect } from "../../packages/core/src/db.ts";
import { recordScopeReassignment } from "../../packages/core/src/sync-replication.ts";

/**
 * Recreates what a share made before shares claimed the origin did with the
 * imported memory: it moves the memory into the first fixture Project's
 * boundary without recording this device as its origin. That records a
 * local-default cleanup recipients refuse, which stopped their pulls before
 * owners withheld such cleanups.
 */
const db = connect("/data/mem.sqlite");
try {
	const deviceId = String(db.prepare("SELECT device_id FROM sync_device").pluck().get());
	const boundaryId = String(
		db.prepare("SELECT scope_id FROM memory_items WHERE title = 'fixture-small memory 0001'").pluck().get(),
	);
	const memory = db
		.prepare("SELECT id, COALESCE(scope_id, 'local-default') AS scope_id FROM memory_items WHERE title = 'imported pre-sync memory'")
		.get() as { id: number; scope_id: string };
	const moved = recordScopeReassignment(db, {
		operationId: "e2e_share_before_origin_claims",
		memoryId: memory.id,
		oldScopeId: memory.scope_id,
		newScopeId: boundaryId,
		deviceId,
	});
	console.log(JSON.stringify({ boundary_id: boundaryId, old_op_id: moved.oldOpId, new_op_id: moved.newOpId }));
} finally {
	db.close();
}
