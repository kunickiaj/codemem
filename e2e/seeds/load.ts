import { initDatabase, MemoryStore, resolveDbPath } from "../../packages/core/src/index.ts";

type SeedMode = "empty" | "fixture-small" | "fixture-large";

function parseArgs(argv: string[]): { mode: SeedMode; dbPath: string } {
	let mode: SeedMode = "empty";
	let dbPath = "/data/mem.sqlite";
	for (let index = 2; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--mode") {
			mode = String(argv[index + 1] ?? "empty") as SeedMode;
			index += 1;
		} else if (arg === "--db-path") {
			dbPath = String(argv[index + 1] ?? dbPath);
			index += 1;
		}
	}
	if (!["empty", "fixture-small", "fixture-large"].includes(mode)) {
		throw new Error(`Unsupported seed mode: ${mode}`);
	}
	return { mode, dbPath };
}

function isoAt(offsetMinutes: number): string {
	return new Date(Date.UTC(2026, 0, 1, 12, 0 + offsetMinutes, 0)).toISOString();
}

function createFixture(store: MemoryStore, mode: Exclude<SeedMode, "empty">): number {
	const batchSize = mode === "fixture-large" ? 240 : 12;
	const sessionCount = mode === "fixture-large" ? 8 : 2;
	let created = 0;
	for (let sessionIndex = 0; sessionIndex < sessionCount; sessionIndex += 1) {
		const sessionId = store.startSession({
			cwd: `/workspace/e2e-fixture-${sessionIndex}`,
			project: sessionIndex % 2 === 0 ? "e2e-project-alpha" : "e2e-project-beta",
			user: "e2e",
			toolVersion: "e2e-seed",
			metadata: { seed_mode: mode, session_index: sessionIndex },
		});
		for (let memoryIndex = 0; memoryIndex < batchSize; memoryIndex += 1) {
			const ordinal = sessionIndex * batchSize + memoryIndex;
			const shared = ordinal % 3 !== 0;
			const title = `${mode} memory ${ordinal.toString().padStart(4, "0")}`;
			const body = `Synthetic ${shared ? "shared" : "private"} fixture memory ${ordinal} for ${mode}.`;
			store.remember(sessionId, ordinal % 2 === 0 ? "feature" : "discovery", title, body, 0.5, [mode], {
				visibility: shared ? "shared" : "private",
				workspace_kind: shared ? "shared" : "personal",
				workspace_id: shared ? `shared:${sessionIndex % 2 === 0 ? "alpha" : "beta"}` : undefined,
				files_read: [`src/e2e/${mode}/${ordinal}.ts`],
				created_at: isoAt(ordinal),
				updated_at: isoAt(ordinal),
				seed_mode: mode,
				seed_ordinal: ordinal,
			});
			created += 1;
		}
		store.endSession(sessionId, { seed_mode: mode, created_count: batchSize });
	}
	return created;
}

async function main(): Promise<void> {
	process.env.CODEMEM_EMBEDDING_DISABLED = process.env.CODEMEM_EMBEDDING_DISABLED || "1";
	const { mode, dbPath } = parseArgs(process.argv);
	const resolvedDbPath = resolveDbPath(dbPath);
	initDatabase(resolvedDbPath);
	const store = new MemoryStore(resolvedDbPath);
	try {
		let created = 0;
		if (mode !== "empty") {
			created = createFixture(store, mode);
			await store.flushPendingVectorWrites();
		}
		console.log(
			JSON.stringify(
				{
					ok: true,
					mode,
					db_path: resolvedDbPath,
					created_memories: created,
					device_id: store.deviceId,
				},
				null,
				2,
			),
		);
	} finally {
		store.close();
	}
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exitCode = 1;
});
