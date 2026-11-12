import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";

// The complete numbered chain, including the authority cutover and account management.
await applyD1Migrations(env.COORDINATOR_DB, env.TEST_MIGRATIONS);
