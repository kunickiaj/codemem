import { DurableObject } from "cloudflare:workers";

/** Test-only SQLite object. The production Wrangler config never binds it. */
export class RelayQuotaTestObject extends DurableObject {}
