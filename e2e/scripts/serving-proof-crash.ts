import { connect } from "../../packages/core/src/db.js";
import { prepareScopeServingStore } from "../../packages/core/src/scope-serving-proof-store.js";

const [path, coordinatorId, groupId, generation] = process.argv.slice(2);
if (!path || !coordinatorId || !groupId || !generation || path !== process.env.CODEMEM_DB)
	throw new Error("Missing disposable fixture");
const db = connect(path);
db.function("crash_fixture", () => process.kill(process.pid, "SIGKILL"));
db.exec(`CREATE TEMP TRIGGER stop_during_purge AFTER DELETE ON scope_membership_authorization_evidence
	BEGIN SELECT crash_fixture(); END`);
prepareScopeServingStore(db, { coordinatorId, groupId, generation });
throw new Error("Preparation did not reach legacy proof deletion");
