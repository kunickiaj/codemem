import { env } from "cloudflare:workers";
import { resetDeviceRemovals } from "./device-removal-reset.js";
import { revocationInput } from "../../core/src/coordinator-device-revocation-test-harness.js";
import { removalDeviceKey } from "../../core/src/coordinator-device-removal-test-harness.js";
import { enrollmentDml, registerReadinessWriterTests } from "../../core/src/coordinator-readiness-writers-test-harness.js";
import { recipientGuardedD1 } from "../../core/src/coordinator-recipient-revocation-test-harness.js";

let seq = 0;
registerReadinessWriterTests(async use => {
	const db = env.COORDINATOR_DB;
	await resetDeviceRemovals(db, env.TEST_MIGRATIONS);
	const input = revocationInput(`readiness-${++seq}`);
	const key = await removalDeviceKey(input.deviceId);
	const counts: number[] = [];
	const store = recipientGuardedD1(db, async () => {}, (sql,result) => {
		if (enrollmentDml.test(sql)) counts.push((result as D1Result).meta.changes);
	});
	await use({store,counts,input:{...input,...key},backend:"D1",
		exec:async (sql,...values) => { await db.prepare(sql).bind(...values).run(); },
		rows:async table => (await db.prepare(`SELECT * FROM ${table}`).all()).results});
});
