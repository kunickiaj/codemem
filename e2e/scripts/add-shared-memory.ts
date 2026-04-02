import { initDatabase, MemoryStore, resolveDbPath } from "../../packages/core/src/index.ts";

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
	const store = new MemoryStore(resolvedDbPath);
	try {
		const sessionId = store.startSession({
			cwd: "/workspace/e2e-local-dirty",
			project: "e2e-bootstrap-refusal",
			user: "e2e",
			toolVersion: "e2e-local-dirty",
		});
		store.remember(sessionId, "exploration", title, body, 0.5, ["e2e", "bootstrap"], {
			visibility: "shared",
			workspace_kind: "shared",
			workspace_id: "shared:bootstrap-refusal",
		});
		store.endSession(sessionId, { local_dirty_marker: true });
		await store.flushPendingVectorWrites();
		console.log(JSON.stringify({ ok: true, title }, null, 2));
	} finally {
		store.close();
	}
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exitCode = 1;
});
