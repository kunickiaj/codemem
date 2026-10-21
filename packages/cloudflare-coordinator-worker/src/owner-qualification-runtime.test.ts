import { test } from "../test/owner-enrollment-qualification-ops-sqlite-fixture.js";
import { registerOwnerQualificationRuntimeTests } from "../test/owner-qualification-runtime-test-harness.js";

registerOwnerQualificationRuntimeTests(test);
