/**
 * Test utilities for the codemem TS backend.
 */

import type { Database } from "./db.js";
import { bootstrapSchema } from "./schema-bootstrap.js";

/**
 * Create the full schema for test databases.
 */
export function initTestSchema(db: Database): void {
	bootstrapSchema(db);
}

/**
 * Insert a minimal test session and return its ID.
 */
export function insertTestSession(db: Database): number {
	const now = new Date().toISOString();
	const info = db
		.prepare(
			"INSERT INTO sessions(started_at, cwd, project, user, tool_version) VALUES (?, ?, ?, ?, ?)",
		)
		.run(now, "/tmp/test", "test-project", "test-user", "test");
	return Number(info.lastInsertRowid);
}

// Re-export for test convenience
export { MemoryStore } from "./store.js";
