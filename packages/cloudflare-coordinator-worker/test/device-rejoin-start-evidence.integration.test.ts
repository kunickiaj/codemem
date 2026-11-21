import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe } from "vitest";
import { registerRejoinStartEvidenceTests, registerRejoinStartWriteTests } from "../../core/src/coordinator-device-rejoin-start-evidence-test-harness.js";
import { resetNativeAuthStage } from "./native-auth-stage.js";

describe("native D1 rejoin start evidence", () => {
	const withFixture: Parameters<typeof registerRejoinStartEvidenceTests>[0] = async (run) => {
		await resetNativeAuthStage("prior_extension");
		const db = env.COORDINATOR_DB;
		await applyD1Migrations(db, env.TEST_MIGRATIONS);
		await run({
			first: <T>({ sql, values }: { sql: string; values: (string | number | null)[] }) =>
				db.prepare(sql).bind(...values).first<T>(),
			run: async (sql, ...values) => {
				const result = await db.prepare(sql).bind(...values).run();
				return { changes: result.meta.changes };
			},
		});
	};
	registerRejoinStartEvidenceTests(withFixture);
	registerRejoinStartWriteTests(withFixture);
});
