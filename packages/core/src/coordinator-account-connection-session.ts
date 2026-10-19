import {
	CoordinatorAuthSchemaUpgradeRequiredError,
	readConnectionSchemaState,
} from "./coordinator-account-connection-schema.js";
import {
	CONNECTION_ALLOCATE_ORDER_SQL,
	CONNECTION_ASSERT_ONE_WRITE_SQL,
} from "./coordinator-account-connection-storage.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";

export {
	CONNECTION_SESSION_SCHEMA_STATEMENTS,
	connectionAdmissionSql,
} from "./coordinator-account-connection-schema.js";

/** Schema choice is database-derived, never a caller-selected exemption.
 * Readiness checks all extension definitions; legacy NULL browser orders cannot
 * admit new sessions after installation. Existing sessions retain their validity. */
export async function hasConnectionSessionSchema(
	backend: Pick<AuthLinkBackend, "first" | "readAuthSchemaState">,
): Promise<boolean> {
	const state = await (backend.readAuthSchemaState?.() ?? readConnectionSchemaState(backend));
	if (state === "upgrade_required") throw new CoordinatorAuthSchemaUpgradeRequiredError();
	return state === "ready";
}

/** All allocation, insertion and exact-row stamping share the caller's batch. */
export async function orderedBrowserStart(
	backend: AuthLinkBackend,
	statements: AuthLinkStatement[],
	coordinator: string,
	hash: string,
): Promise<void> {
	if (!(await hasConnectionSessionSchema(backend))) {
		await backend.batch(statements);
		return;
	}
	const orders = "coordinator_auth_account_connection_orders";
	await backend.batch([
		{
			sql: `INSERT INTO ${orders} (coordinator_id,last_order) SELECT ?,0 WHERE NOT EXISTS (SELECT 1 FROM ${orders} WHERE coordinator_id = ?)`,
			values: [coordinator, coordinator],
		},
		{ sql: CONNECTION_ALLOCATE_ORDER_SQL, values: [coordinator] },
		{ sql: CONNECTION_ASSERT_ONE_WRITE_SQL, values: [] },
		...statements,
		{
			sql: `UPDATE coordinator_auth_browser_transactions SET start_order = (SELECT last_order FROM ${orders} WHERE coordinator_id = ?) WHERE coordinator_id = ? AND browser_transaction_hash = ? AND start_order IS NULL`,
			values: [coordinator, coordinator, hash],
		},
		{ sql: CONNECTION_ASSERT_ONE_WRITE_SQL, values: [] },
	]);
}

/** Publish the browser floor and reject a continuation missing its prior pin.
 * The caller must already compose the successor CAS in this winning batch. */
export async function initialConnectionFloor(
	backend: AuthLinkBackend,
	coordinator: string,
	link: string,
): Promise<AuthLinkStatement[]> {
	if (!(await hasConnectionSessionSchema(backend))) return [];
	return [
		{
			sql: `INSERT INTO coordinator_auth_account_connection_orders (coordinator_id,last_order) SELECT NULL,0 WHERE EXISTS (SELECT 1 FROM coordinator_auth_account_links l JOIN coordinator_auth_link_attempts a ON a.coordinator_id=l.coordinator_id AND a.attempt_id=l.attempt_id JOIN coordinator_auth_account_connection_history h ON h.coordinator_id = l.coordinator_id AND h.identity_id = l.identity_id WHERE l.coordinator_id = ? AND l.link_id = ? AND a.prior_link_id IS NULL)`,
			values: [coordinator, link],
		},
		{
			sql: `UPDATE coordinator_auth_account_links SET signin_floor = coalesce((SELECT last_order FROM coordinator_auth_account_connection_orders WHERE coordinator_id = ?),0) WHERE coordinator_id = ? AND link_id = ?`,
			values: [coordinator, coordinator, link],
		},
	];
}

/** Source aliases are fixed internal SQL, not request input. Refresh payloads
 * become readable only after their own immutable completed management receipt. */
export function connectionProfileColumns(signin: "p" | "m"): string {
	// Order one is the migration's already-verified legacy display snapshot.
	// Its expired receipt may have been legitimately purged before installation.
	const validSignin = `(${signin}.source_order = 1 OR EXISTS (SELECT 1 FROM coordinator_auth_session_receipts r WHERE r.coordinator_id = ${signin}.coordinator_id AND r.link_id = ${signin}.link_id AND r.session_id = ${signin}.source_session_id AND r.source = 'signin' AND r.attempt_id IS NULL AND r.created_at_ms = ${signin}.source_signed_in_at_ms AND (${signin}.source_order IS NULL OR r.source_order = ${signin}.source_order)))`;
	const validBirth = `(b.source_change_attempt_id IS NULL OR EXISTS (SELECT 1 FROM coordinator_account_change_attempts x WHERE x.coordinator_id = b.coordinator_id AND x.attempt_id = b.source_change_attempt_id AND x.state = 'completed' AND x.intent = 'refresh' AND x.target_link_id = l.link_id AND x.identity_id = l.identity_id AND x.issuer = l.issuer AND x.target_subject = l.subject AND x.browser_order = b.source_order))`;
	const preferSignin = `${validSignin} AND (NOT ${validBirth} OR coalesce(${signin}.source_order,1) > coalesce(b.source_order,0))`;
	return ["display_name", "email", "email_verified", "picture_url"]
		.map(
			(field) =>
				`CASE WHEN ${preferSignin} THEN ${signin}.${field} WHEN ${validBirth} THEN b.${field} END AS ${field}`,
		)
		.join(",\n");
}
