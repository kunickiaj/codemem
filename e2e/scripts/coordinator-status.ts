import {
	coordinatorStatusSnapshot,
	MemoryStore,
	readCoordinatorSyncConfig,
	resolveDbPath,
} from "../../packages/core/src/index.ts";
import { runTickOnce } from "../../packages/core/src/sync-daemon.ts";

function parseArgs(argv: string[]): { dbPath: string; runTick: boolean } {
	let dbPath = "/data/mem.sqlite";
	let runTick = false;
	for (let index = 2; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--db-path") {
			dbPath = String(argv[index + 1] ?? dbPath);
			index += 1;
		} else if (arg === "--run-tick") {
			runTick = true;
		}
	}
	return { dbPath, runTick };
}

async function main(): Promise<void> {
	const { dbPath, runTick } = parseArgs(process.argv);
	const resolvedDbPath = resolveDbPath(dbPath);
	if (runTick) {
		await runTickOnce(resolvedDbPath, process.env.CODEMEM_KEYS_DIR?.trim() || undefined);
	}
	const store = new MemoryStore(resolvedDbPath);
	try {
		const snapshot = await coordinatorStatusSnapshot(store, readCoordinatorSyncConfig());
		console.log(JSON.stringify(snapshot, null, 2));
	} finally {
		store.close();
	}
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exitCode = 1;
});
