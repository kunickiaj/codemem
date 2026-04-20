/* Database init + vacuum — bootstrap schema, run relink, vacuum on demand.
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
