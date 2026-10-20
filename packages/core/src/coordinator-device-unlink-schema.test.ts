import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import {
	cleanupAccountChangeHttpFixtures,
	fixture,
} from "./coordinator-account-change-http-test-fixtures.js";
import { BROWSER_ACCOUNT_ARCHIVE_GUARD } from "./coordinator-account-change-schema.js";
import {
	ACCOUNT_UNLINK_MIGRATION_STATEMENTS,
	applyAccountConnectionSchema,
	PRIOR_ACCOUNT_CONNECTION_MIGRATION_STATEMENTS,
	readConnectionSchemaState,
} from "./coordinator-account-connection-schema.js";
import { ACCOUNT_UNLINK_SCHEMA_STATEMENTS } from "./coordinator-account-unlink-schema.js";

afterEach(cleanupAccountChangeHttpFixtures);
async function prior() {
	const f = await fixture("device_claim", {}, { install: false });
	await f.backend.batch(
		PRIOR_ACCOUNT_CONNECTION_MIGRATION_STATEMENTS.map((sql) => ({ sql, values: [] })),
	);
	return f;
}
it("preserves the frozen 38-statement prior account schema and upgrades without rewriting rows", async () => {
	const f = await fixture();
	expect(PRIOR_ACCOUNT_CONNECTION_MIGRATION_STATEMENTS).toHaveLength(38);
	// A changed prior contract must not silently redefine which deployed databases qualify.
	expect(
		createHash("sha256")
			.update(JSON.stringify(PRIOR_ACCOUNT_CONNECTION_MIGRATION_STATEMENTS))
			.digest("hex"),
	).toBe("b2d4d1617cf5c201b7693514da20a01fc6251cee2bfa44cf8743a8e34c21ea0b");
	await f.prepare("refresh");
	expect(
		(await f.send("POST", "/v1/auth/account-changes/change-a/finalize", f.finalBody())).status,
	).toBe(200);
	// Browser receipt format is unchanged: restore the exact deployed schema around real rows.
	f.db.exec(
		`DROP TABLE coordinator_auth_account_connection_unlinks; DROP TRIGGER account_change_archive_receipt; ${BROWSER_ACCOUNT_ARCHIVE_GUARD}`,
	);
	const before = f.snapshot();
	const rowids = f.db.prepare("SELECT rowid,* FROM coordinator_auth_account_links").all();
	expect(await readConnectionSchemaState(f.backend)).toBe("upgrade_required");
	await applyAccountConnectionSchema(f.backend);
	expect(await readConnectionSchemaState(f.backend)).toBe("ready");
	expect(
		f.snapshot().filter(([name]) => name !== "coordinator_auth_account_connection_unlinks"),
	).toEqual(before);
	expect(f.db.prepare("SELECT rowid,* FROM coordinator_auth_account_links").all()).toEqual(rowids);
	// The exact old postflight is also the old binary's canonical readiness predicate.
	const fence = PRIOR_ACCOUNT_CONNECTION_MIGRATION_STATEMENTS.at(-1);
	expect(() => f.db.exec(fence ?? "")).toThrow();
});
it.each(["late failure", "ignored trigger", "partial"])(
	"rejects %s without a partial schema upgrade",
	async (mode) => {
		const f = await prior();
		const before = f.snapshot();
		const definitions = () =>
			f.db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all();
		const schema = definitions();
		if (mode === "partial") {
			f.db.exec(ACCOUNT_UNLINK_SCHEMA_STATEMENTS[0]);
			await expect(applyAccountConnectionSchema(f.backend)).rejects.toThrow();
			expect(await readConnectionSchemaState(f.backend)).toBe("upgrade_required");
			return;
		}
		const statements = ACCOUNT_UNLINK_MIGRATION_STATEMENTS.map((sql) => ({ sql, values: [] }));
		if (mode === "late failure")
			statements.splice(-1, 0, {
				sql: "INSERT INTO coordinator_auth_account_connection_orders (coordinator_id,last_order) VALUES(NULL,0)",
				values: [],
			});
		else statements.splice(2, 1); // Postflight must reject a silently omitted receipt guard.
		await expect(f.backend.batch(statements)).rejects.toThrow();
		expect(definitions()).toEqual(schema);
		expect(f.snapshot()).toEqual(before);
		await applyAccountConnectionSchema(f.backend);
		expect(await readConnectionSchemaState(f.backend)).toBe("ready");
	},
);
