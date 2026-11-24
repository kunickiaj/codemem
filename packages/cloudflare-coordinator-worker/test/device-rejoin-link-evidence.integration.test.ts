import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe } from "vitest";
import type { AuthLinkStatement } from "../../core/src/coordinator-auth-link.js";
import { registerRejoinLinkEvidenceTests } from "../../core/src/coordinator-device-rejoin-link-evidence-test-harness.js";
import * as proof from "./device-claim-eligibility-fixture.js";
import { resetNativeAuthStage } from "./native-auth-stage.js";

describe("native D1 rejoin link evidence", () => {
	registerRejoinLinkEvidenceTests(async (use) => {
		await resetNativeAuthStage("prior_extension");
		const db = env.COORDINATOR_DB;
		await applyD1Migrations(db, env.TEST_MIGRATIONS);
		await use({
			proof,
			first: <T>({ sql, values }: AuthLinkStatement) => db.prepare(sql).bind(...values).first<T>(),
			run: (sql, ...values) => db.prepare(sql).bind(...values).run(),
		});
	});
});
