import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectReadOnly } from "./db.js";
import { MemoryStore } from "./store.js";

/** Run initialization and diagnostics on a private SQLite backup, never on the source. */
export async function withDiagnosticStoreSnapshot<T>(
	dbPath: string,
	diagnose: (store: MemoryStore) => Promise<T>,
): Promise<T> {
	const directory = mkdtempSync(join(tmpdir(), "codemem-diagnosis-"));
	const snapshotPath = join(directory, "mem.sqlite");
	try {
		const source = connectReadOnly(dbPath);
		try {
			// SQLite backup includes committed WAL pages. A filesystem copy does not.
			await source.backup(snapshotPath);
		} finally {
			source.close();
		}
		const store = new MemoryStore(snapshotPath);
		try {
			return await diagnose(store);
		} finally {
			store.close();
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
