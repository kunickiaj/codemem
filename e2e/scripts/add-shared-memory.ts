import { randomUUID } from "node:crypto";
import { initDatabase, resolveDbPath } from "../../packages/core/src/index.ts";
import { connect } from "../../packages/core/src/db.ts";

function parseArgs(argv: string[]): { dbPath: string; title: string; body: string } {
	let dbPath = "/data/mem.sqlite";
	let title = "bootstrap refusal marker";
	let body = "local unsynced shared memory";
	for (let index = 2; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--db-path") {
			dbPath = String(argv[index + 1] ?? dbPath);
			index += 1;
		} else if (arg === "--title") {
			title = String(argv[index + 1] ?? title);
			index += 1;
		} else if (arg === "--body") {
			body = String(argv[index + 1] ?? body);
			index += 1;
		}
	}
	return { dbPath, title, body };
}

async function main(): Promise<void> {
	process.env.CODEMEM_EMBEDDING_DISABLED = process.env.CODEMEM_EMBEDDING_DISABLED || "1";
	const { dbPath, title, body } = parseArgs(process.argv);
	const resolvedDbPath = resolveDbPath(dbPath);
	initDatabase(resolvedDbPath);
	const db = connect(resolvedDbPath);
	try {
		const now = new Date().toISOString();
		const sessionInsert = db
			.prepare(
				"INSERT INTO sessions (started_at, cwd, project, user, tool_version, metadata_json) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(
				now,
				"/workspace/e2e-local-dirty",
				"e2e-bootstrap-refusal",
				"e2e",
				"e2e-local-dirty",
				JSON.stringify({ local_dirty_marker: true }),
			);
		const sessionId = Number(sessionInsert.lastInsertRowid);
		const importKey = `e2e-local-dirty-${randomUUID()}`;
		db.prepare(
			`INSERT INTO memory_items (
				session_id, kind, title, body_text, confidence, tags_text,
				active, created_at, updated_at, metadata_json,
				visibility, workspace_id, workspace_kind, import_key, rev
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			sessionId,
			"exploration",
			title,
			body,
			0.5,
			"e2e,bootstrap",
			1,
			now,
			now,
			JSON.stringify({ local_dirty_marker: true }),
			"shared",
			"shared:bootstrap-refusal",
			"shared",
			importKey,
			0,
		);
		console.log(JSON.stringify({ ok: true, title, import_key: importKey }, null, 2));
	} finally {
		db.close();
	}
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exitCode = 1;
});
