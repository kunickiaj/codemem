import { test } from "../../cloudflare-coordinator-worker/test/owner-enrollment-qualification-ops-sqlite-fixture.js";
import { registerQualificationOpsTests } from "../../cloudflare-coordinator-worker/test/owner-enrollment-qualification-ops-test-harness.js";

registerQualificationOpsTests(test);
