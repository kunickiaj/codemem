import { env } from "cloudflare:workers";
import { D1CoordinatorStore } from "@codemem/core/internal/cloudflare-coordinator";
import { expect, it } from "vitest";
import {
	config,
	denied,
	eligible,
	input,
	labelledCompletionCases,
	NOW,
	seedEnrollmentSql,
} from "./device-claim-eligibility-fixture.js";

// These fixture inserts have no trigger bodies or semicolons in string literals.
async function seed(sql: string) {
	await env.COORDINATOR_DB.batch(
		sql
			.split(";")
			.map((part) => part.trim())
			.filter(Boolean)
			.map((part) => env.COORDINATOR_DB.prepare(part)),
	);
}

it("native D1 lets another device's label neither grant nor block a device claim", async () => {
	// Arrange
	await seed(seedEnrollmentSql);
	const store = new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => NOW });
	const read = () => store.readAuthDeviceClaimReadiness(input, config);
	const results: Record<string, unknown> = {};
	// Act: each recorded row first as ownership, then as another device's guess.
	for (const { name, ownerSql, labelSql } of labelledCompletionCases) {
		await seed(ownerSql);
		results[`${name}: owner`] = await read();
		await seed("DELETE FROM coordinator_legacy_team_completions");
		await seed(labelSql);
		results[`${name}: label`] = await read();
		await seed("DELETE FROM coordinator_legacy_team_completions");
	}
	// Assert
	expect(results).toEqual(
		Object.fromEntries(
			labelledCompletionCases.flatMap(({ name }) => [
				[`${name}: owner`, denied],
				[`${name}: label`, eligible],
			]),
		),
	);
	await store.close();
});
