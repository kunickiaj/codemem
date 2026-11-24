import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe } from "vitest";
import type { AuthLinkStatement } from "../../core/src/coordinator-auth-link.js";
import { registerRejoinFinalizeTests } from "../../core/src/coordinator-device-rejoin-finalize-test-harness.js";
import * as proof from "./device-claim-eligibility-fixture.js";
import { resetNativeAuthStage } from "./native-auth-stage.js";

describe("native D1 rejoin finalize", () => {
	registerRejoinFinalizeTests(async (use) => {
		await resetNativeAuthStage("prior_extension");
		const db = env.COORDINATOR_DB;
		await applyD1Migrations(db, env.TEST_MIGRATIONS);
		await use({
			proof,
			first: <T>({ sql, values }: AuthLinkStatement) => db.prepare(sql).bind(...values).first<T>(),
			run: (sql, ...values) => db.prepare(sql).bind(...values).run(),
			changed: async ({ sql, values }) => (await db.prepare(sql).bind(...values).run()).meta.changes,
			batch: (statements) => db.batch(statements.map(({ sql, values }) => db.prepare(sql).bind(...values))),
		});
	});
});
