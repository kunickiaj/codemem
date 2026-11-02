import { TRAVERSAL_COORDINATOR_ATTEMPT_SCHEMA_STATEMENTS } from "./peer-traversal-coordinator-attempt-schema.js";
import { TRAVERSAL_COORDINATOR_METADATA_SCHEMA_STATEMENTS } from "./peer-traversal-coordinator-metadata-schema.js";

/** Definition composition only. No installation, startup wiring, or admission grant. */
export const TRAVERSAL_COORDINATOR_SCHEMA_STATEMENTS: readonly string[] = Object.freeze([
	...TRAVERSAL_COORDINATOR_METADATA_SCHEMA_STATEMENTS,
	...TRAVERSAL_COORDINATOR_ATTEMPT_SCHEMA_STATEMENTS,
]);
