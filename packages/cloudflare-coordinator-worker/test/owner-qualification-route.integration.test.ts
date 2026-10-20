import { env } from "cloudflare:workers";
import { registerOwnerQualificationRouteTests } from "./owner-qualification-route-test-harness.js";
import { test } from "./owner-enrollment-qualification-ops-fixture.js";

registerOwnerQualificationRouteTests(test, env.TEST_MIGRATIONS);
