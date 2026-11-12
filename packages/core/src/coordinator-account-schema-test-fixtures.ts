// The account-management schema for ordinary test flows. Runs in Node and in the Worker
// test pool. Historical states live in coordinator-account-schema-sqlite-test-fixtures.ts.
import {
	applyAccountConnectionSchema,
	readConnectionSchemaState,
} from "./coordinator-account-connection-schema.js";
import { connectionOrderAllocation } from "./coordinator-account-connection-session.js";
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

/**
 * For harnesses that seed browser rows through raw SQL on SQLite or D1: the coordinator
 * order row that earlier browser starts would have left on the current account schema.
 * Allocates the first order only when the row is missing; no-op on V2.
 */
export async function seedConnectionOrderWith(
	f: {
		exec(sql: string, ...values: (string | number | null)[]): Promise<void>;
		query(sql: string): Promise<Record<string, unknown>[]>;
	},
	coordinatorId: string,
): Promise<void> {
	const ordered = await f.query(
		"SELECT 1 FROM pragma_table_info('coordinator_auth_browser_transactions') WHERE name = 'start_order'",
	);
	if (ordered.length === 0) return;
	const present = await f.query(
		`SELECT 1 FROM coordinator_auth_account_connection_orders WHERE coordinator_id = '${coordinatorId.replaceAll("'", "''")}'`,
	);
	if (present.length > 0) return;
	for (const { sql, values } of connectionOrderAllocation(coordinatorId))
		await f.exec(sql, ...(values as (string | number | null)[]));
}
