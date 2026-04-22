import {
	coordinatorStatusSnapshot,
	MemoryStore,
	readCoordinatorSyncConfig,
} from "../../packages/core/src/index.ts";
import { runTickOnce } from "../../packages/core/src/sync-daemon.ts";

const E2E_DB_PATH = "/data/mem.sqlite";

function parseArgs(argv: string[]): { runTick: boolean } {
	let runTick = false;
	for (let index = 2; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--run-tick") {
			runTick = true;
		}
	}
	return { runTick };
}

async function main(): Promise<void> {
	const { runTick } = parseArgs(process.argv);
	if (runTick) {
		await runTickOnce(E2E_DB_PATH, process.env.CODEMEM_KEYS_DIR?.trim() || undefined);
	}
	const store = new MemoryStore(E2E_DB_PATH);
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
