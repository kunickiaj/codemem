import { connect } from "../../packages/core/src/db.ts";
import { hasUnsyncedSharedMemoryChanges } from "../../packages/core/src/index.ts";

// The same check `codemem sync bootstrap` uses to refuse, without its 25-row
// cap, so a scenario can compare counts before and after a local change.
const UNCAPPED = Number.MAX_SAFE_INTEGER;

const db = connect("/data/mem.sqlite");
try {
	console.log(JSON.stringify({ count: hasUnsyncedSharedMemoryChanges(db, UNCAPPED).count }));
} finally {
	db.close();
}
