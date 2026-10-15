import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { AUTH_LINK_AUTHORITY_UPGRADE_SQL } from "../../core/src/coordinator-auth-link-authority-upgrade.js";

await applyD1Migrations(env.COORDINATOR_DB, env.TEST_MIGRATIONS);
// Isolated test DB only: exercise the planned cutover without publishing an
// auto-discovered migration that would be incompatible with deployed writers.
await env.COORDINATOR_DB.batch(
	AUTH_LINK_AUTHORITY_UPGRADE_SQL.split(";").map((sql) => sql.trim()).filter(Boolean).map((sql) => env.COORDINATOR_DB.prepare(sql)),
);
