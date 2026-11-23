import { connect } from "../../packages/core/src/db.ts";
import { MemoryStore } from "../../packages/core/src/index.ts";

/**
 * Synthetic helpers for the Project withdrawal scenario.
 *
 * - `remember --cwd <dir> --project <name> --title <title>` stores a shared
 *   memory through the normal write path, so scope resolution picks its
 *   boundary, and prints its scope.
 * - `state` prints active memory titles with their scope, managed Project
 *   memberships, and this device's withdrawals. It only reads.
 */
const DB_PATH = "/data/mem.sqlite";

function arg(name: string): string {
	const index = process.argv.indexOf(`--${name}`);
	const value = index > 0 ? process.argv[index + 1] : undefined;
	if (!value) throw new Error(`--${name} is required`);
	return value;
}

function remember(): void {
	process.env.CODEMEM_EMBEDDING_DISABLED = "1";
	const store = new MemoryStore(DB_PATH);
	try {
		const sessionId = store.startSession({
			cwd: arg("cwd"),
			project: arg("project"),
			user: "e2e",
			toolVersion: "project-withdrawal-e2e",
		});
		const title = arg("title");
		const id = store.remember(sessionId, "discovery", title, `${title} body`, 0.5, ["e2e"], {
			visibility: "shared",
		});
		store.endSession(sessionId, { fixture: "project-withdrawal" });
		console.log(
			JSON.stringify(store.db.prepare("SELECT id, title, scope_id FROM memory_items WHERE id = ?").get(id)),
		);
	} finally {
		store.close();
	}
}

function state(): void {
	const db = connect(DB_PATH);
	try {
		console.log(
			JSON.stringify({
				memories: db
					.prepare("SELECT title, scope_id FROM memory_items WHERE active = 1 ORDER BY title")
					.all(),
				memberships: db
					.prepare(
						`SELECT m.scope_id, m.device_id, m.status
						   FROM scope_memberships m
						   JOIN replication_scopes s ON s.scope_id = m.scope_id
						  WHERE s.kind = 'managed_project'
						  ORDER BY m.scope_id, m.device_id`,
					)
					.all(),
				withdrawals: db.prepare("SELECT scope_id FROM project_scope_withdrawals ORDER BY scope_id").all(),
			}),
		);
	} finally {
		db.close();
	}
}

const action = process.argv[2];
if (action === "remember") remember();
else if (action === "state") state();
else throw new Error(`unknown action: ${action}`);
