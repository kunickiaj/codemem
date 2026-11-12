import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { COORDINATOR_AUTH_STAGE_MIGRATIONS } from "../../core/src/coordinator-auth-schema-stage.js";

/** The last numbered migration a database at each earlier auth stage has applied. */
const LAST_MIGRATION = {
	legacy: "0044_add_rebind_start_authority.sql",
	v2: COORDINATOR_AUTH_STAGE_MIGRATIONS.authorityCutover,
	prior_extension: COORDINATOR_AUTH_STAGE_MIGRATIONS.accountConnections,
} as const;

/**
 * Rebuilds this test file's isolated D1 database as an earlier deployment left it: drops
 * every object, then applies the numbered chain only through that stage's migration.
 * Historical upgrade tests start here instead of from the current chain.
 */
export async function resetNativeAuthStage(stage: keyof typeof LAST_MIGRATION): Promise<void> {
	const db = env.COORDINATOR_DB;
	const last = env.TEST_MIGRATIONS.findIndex(({ name }) => name === LAST_MIGRATION[stage]);
	if (last < 0) throw new Error(`Missing numbered migration: ${LAST_MIGRATION[stage]}`);
	const { results } = await db
		.prepare(
			"SELECT type, name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
		)
		.all<{ type: string; name: string }>();
	// Dropping a table also drops its indexes and triggers.
	await db.batch([
		db.prepare("PRAGMA defer_foreign_keys = on"),
		...results.map(({ type, name }) =>
			db.prepare(`DROP ${type === "view" ? "VIEW" : "TABLE"} IF EXISTS "${name}"`),
		),
	]);
	await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, last + 1));
}
