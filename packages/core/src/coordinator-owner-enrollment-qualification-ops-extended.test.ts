import { registerExtendedQualificationOpsTests } from "../../cloudflare-coordinator-worker/test/owner-enrollment-qualification-ops-extended-test-harness.js";
import { test } from "../../cloudflare-coordinator-worker/test/owner-enrollment-qualification-ops-sqlite-fixture.js";

registerExtendedQualificationOpsTests(test);
