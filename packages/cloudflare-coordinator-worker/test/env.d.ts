import type { D1Migration } from "@cloudflare/vitest-pool-workers/config";
import type { CloudflareCoordinatorEnv } from "../src/index.js";
import type { RelayRealm } from "../src/relay-realm.js";
import type { RelayHealthTestObject } from "./relay-health-do-object.js";
import type { RelayQuotaTestObject } from "./relay-quota-do-object.js";
import type {
	RelayRealmLoopbackTestObject,
	RelayRealmTestObject,
} from "./relay-realm-do-object.js";

declare module "cloudflare:workers" {
	interface ProvidedEnv extends CloudflareCoordinatorEnv {
		TEST_MIGRATIONS: D1Migration[];
		RELAY_QUOTA_TEST: DurableObjectNamespace<RelayQuotaTestObject>;
		RELAY_REALM_TEST: DurableObjectNamespace<RelayRealmTestObject>;
		RELAY_REALM_PRODUCTION: DurableObjectNamespace<RelayRealm>;
		RELAY_REALM_LOOPBACK_TEST: DurableObjectNamespace<RelayRealmLoopbackTestObject>;
		RELAY_HEALTH_TEST: DurableObjectNamespace<RelayHealthTestObject>;
		RELAY_TEST_SERVICE_PUBLIC_KEY: string;
		CODEMEM_RELAY_AUTHORITY_URL: string;
		CODEMEM_RELAY_GROUPS: string;
		CODEMEM_RELAY_SERVICE_KEY: string;
	}
}
