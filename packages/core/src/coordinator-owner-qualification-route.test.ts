import { readBrowserFixtureMigrations } from "../../cloudflare-coordinator-worker/test/browser-purpose-migrations-fixture.js";
import { test } from "../../cloudflare-coordinator-worker/test/owner-enrollment-qualification-ops-sqlite-fixture.js";
import { registerOwnerQualificationRouteTests } from "../../cloudflare-coordinator-worker/test/owner-qualification-route-test-harness.js";

registerOwnerQualificationRouteTests(test, await readBrowserFixtureMigrations());
