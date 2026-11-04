import type { D1Migration } from "@cloudflare/vitest-pool-workers/config";
import type { CloudflareCoordinatorEnv } from "../src/index.js";
import type { RelayQuotaTestObject } from "./relay-quota-do-object.js";

declare module "cloudflare:workers" {
	interface ProvidedEnv extends CloudflareCoordinatorEnv {
		TEST_MIGRATIONS: D1Migration[];
		RELAY_QUOTA_TEST: DurableObjectNamespace<RelayQuotaTestObject>;
	}
}
