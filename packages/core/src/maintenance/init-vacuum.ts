/* Database init + vacuum — bootstrap schema, run relink, vacuum on demand.
 *
 * Extracted verbatim from packages/core/src/maintenance.ts as part of
 * the maintenance/ split (tracked under codemem-ug38).
 */

import { statSync } from "node:fs";
import { assertSchemaReady, connect, getSchemaVersion, resolveDbPath } from "../db.js";
import { ensureMaintenanceJobsSchema } from "../maintenance-jobs.js";
import { bootstrapSchema } from "../schema-bootstrap.js";
import { applyRawEventRelinkPlanWithDb } from "./relink.js";
import { withDb } from "./with-db.js";

export function initDatabase(dbPath?: string): { path: string; sizeBytes: number } {
	const resolvedPath = resolveDbPath(dbPath);
	const db = connect(resolvedPath);
	try {
		if (getSchemaVersion(db) === 0) {
			bootstrapSchema(db);
		}
		assertSchemaReady(db);
		ensureMaintenanceJobsSchema(db);
		applyRawEventRelinkPlanWithDb(db);
		const stats = statSync(resolvedPath);
		return { path: resolvedPath, sizeBytes: stats.size };
	} finally {
		db.close();
	}
}

export function vacuumDatabase(dbPath?: string): { path: string; sizeBytes: number } {
	return withDb(dbPath, (db, resolvedPath) => {
		db.exec("VACUUM");
		const stats = statSync(resolvedPath);
		return { path: resolvedPath, sizeBytes: stats.size };
	});
}
