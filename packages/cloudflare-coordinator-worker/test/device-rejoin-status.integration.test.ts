import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe } from "vitest";
import { registerRejoinStatusTests } from "../../core/src/coordinator-device-rejoin-status-test-harness.js";
import { resetNativeAuthStage } from "./native-auth-stage.js";

describe("native D1 rejoin status verification", () => {
	registerRejoinStatusTests(async (run) => {
		await resetNativeAuthStage("prior_extension");
		const db = env.COORDINATOR_DB;
		await applyD1Migrations(db, env.TEST_MIGRATIONS);
		await run({
			first: <T>({ sql, values }: { sql: string; values: (string | number | null)[] }) =>
				db
					.prepare(sql)
					.bind(...values)
					.first<T>(),
			run: async (sql, ...values) =>
				db
					.prepare(sql)
					.bind(...values)
					.run(),
		});
	});
});
