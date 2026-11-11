import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AuthLinkBackend, AuthLinkStatement } from "../../core/src/coordinator-auth-link.js";
import { writeGuarded } from "../../core/src/coordinator-auth-read-set.js";
import { readNegativeOwnerConsistency } from "../../core/src/coordinator-owner-negative-read-set.js";
import { input, seedEnrollmentSql } from "./device-claim-eligibility-fixture.js";
import { db, exec, reset, retain, timestamp } from "./owner-producer-consistency-test-fixtures.js";

beforeEach(async () => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	await reset();
});
afterEach(() => {
	vi.restoreAllMocks();
});

const backend: AuthLinkBackend = {
	first: ({ sql, values }) =>
		db
			.prepare(sql)
			.bind(...values)
			.first(),
	all: async <T>({ sql, values }: AuthLinkStatement) =>
		(
			await db
				.prepare(sql)
				.bind(...values)
				.all<T>()
		).results,
	run: async ({ sql, values }) =>
		(
			await db
				.prepare(sql)
				.bind(...values)
				.run()
		).meta.changes,
	batch: async (statements) => {
		await db.batch(statements.map(({ sql, values }) => db.prepare(sql).bind(...values)));
	},
};

const subject = {
	coordinatorId: "coordinator-a",
	deviceId: input.signer.deviceId,
	publicKey: input.signer.publicKey,
	fingerprint: input.signer.fingerprint,
	ownerIdentityId: input.identityId,
};

async function guardedWrite(guards: Parameters<typeof writeGuarded>[1]) {
	await exec("CREATE TABLE IF NOT EXISTS raced_write (n INTEGER)");
	const result = await writeGuarded(backend, guards, [
		{ sql: "INSERT INTO raced_write (n) VALUES (1)", values: [] },
	]);
	const written = await db.prepare("SELECT count(*) AS n FROM raced_write").first<{ n: number }>();
	return { result, written: written?.n };
}

// Native D1 runs every negative owner read and guard, including the evidence reads that
// replaced the statement production D1 refused. A fact changed after the reads must abort.
it("native D1 allows a retained owner and aborts the write when its evidence changes", async () => {
	// Arrange: the device's enrollment and a retained resolution with its original source.
	await db.batch(
		seedEnrollmentSql
			.split(";")
			.map((sql) => sql.trim())
			.filter(Boolean)
			.map((sql) => db.prepare(sql)),
	);
	await retain(subject);
	const negative = await readNegativeOwnerConsistency(backend, {
		...subject,
		enrollment: { groupId: input.signer.groupId },
	});
	if (!negative) throw new Error("expected the retained owner to be allowed");
	const unchanged = await guardedWrite(negative.guards);
	// Act: an unparseable completion naming the device, which only the history read selects.
	await exec(
		"INSERT INTO coordinator_legacy_team_completions (group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at) VALUES ('raced-group','raced-candidate',1,?,?,?)",
		`not json ${JSON.stringify(subject.deviceId)}`,
		timestamp,
		timestamp,
	);
	const changed = await guardedWrite(negative.guards);
	// Assert
	expect(unchanged).toEqual({ result: "committed", written: 1 });
	expect(changed).toEqual({ result: "changed", written: 1 });
});
