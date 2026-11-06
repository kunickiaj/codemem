import { registerQualifiedHeadlessTests } from "../../core/src/owner-qualified-headless-test-harness.js";
import { test } from "./owner-qualified-consumer-test-fixture.js";

registerQualifiedHeadlessTests(test);
