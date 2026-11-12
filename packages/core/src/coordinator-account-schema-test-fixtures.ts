// The account-management schema for ordinary test flows. Runs in Node and in the Worker
// test pool. Historical states live in coordinator-account-schema-sqlite-test-fixtures.ts.
import {
	applyAccountConnectionSchema,
	readConnectionSchemaState,
} from "./coordinator-account-connection-schema.js";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";

/**
 * Ordinary flows need the current account schema. A store that opened with it is left
 * as it is; a store that opened on V2 takes the one supported install. Any other state
 * fails, as the installer does.
 */
export async function useCurrentAccountSchema(backend: AuthLinkBackend): Promise<void> {
	if ((await readConnectionSchemaState(backend)) === "ready") return;
	await applyAccountConnectionSchema(backend);
}
