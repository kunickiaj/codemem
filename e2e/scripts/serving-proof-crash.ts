import { connect } from "../../packages/core/src/db.js";
import { prepareOfflineScopeServingStore } from "../../packages/core/src/offline-serving-preparation.js";
import { prepareScopeServingStore } from "../../packages/core/src/scope-serving-proof-store.js";

const [path, coordinatorId, groupId, generation, stage] = process.argv.slice(2);
if (!path || !coordinatorId || !groupId || !generation || path !== process.env.CODEMEM_DB)
	throw new Error("Missing disposable fixture");
if (stage === "format-before-envelope") {
	prepareOfflineScopeServingStore(path, { coordinatorId, groupId, generation }, [
		{
			scopeId: "fixture-team",
			deviceId: "fixture-device",
			keyId: "ab".repeat(32),
			get envelope(): Uint8Array {
				process.kill(process.pid, "SIGKILL");
				throw new Error("Expected fixture process to terminate");
			},
		},
	]);
	throw new Error("Preparation did not reach the envelope insert after format conversion");
}
const db = connect(path);
db.function("crash_fixture", () => process.kill(process.pid, "SIGKILL"));
if (stage === "purge") {
	db.exec(`CREATE TEMP TRIGGER stop_during_purge AFTER DELETE ON scope_membership_authorization_evidence
		BEGIN SELECT crash_fixture(); END`);
} else if (stage === "first-envelope") {
	// Install the real tables for an unrelated fixture group so a TEMP trigger
	// can stop this process after the target group's last legacy proof is gone.
	prepareScopeServingStore(db, { coordinatorId, groupId: "unrelated", generation }, []);
	db.exec(`CREATE TEMP TRIGGER stop_before_insert BEFORE INSERT ON scope_serving_proofs_v2
		WHEN NOT EXISTS (SELECT 1 FROM scope_membership_authorization_evidence
			WHERE coordinator_id=NEW.coordinator_id AND group_id=NEW.group_id)
		BEGIN SELECT crash_fixture(); END`);
} else throw new Error("Unknown crash stage");
prepareScopeServingStore(db, { coordinatorId, groupId, generation }, [
	{
		scopeId: "fixture-team",
		deviceId: "fixture-device",
		keyId: "ab".repeat(32),
		envelope: Buffer.from("fixture"),
	},
]);
throw new Error(`Preparation did not reach ${stage}`);
