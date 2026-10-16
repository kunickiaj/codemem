import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";

export const AUTH_SCHEMA_UPGRADE_REQUIRED = "coordinator_auth_schema_upgrade_required";
export const AUTH_SCHEMA_UPGRADE_MESSAGE =
	"Coordinator authentication needs a schema upgrade. Pause auth writers, back up the coordinator database, then run codemem coordinator upgrade-auth-schema --db-path <coordinator.sqlite>. D1 operators must review the exported SQL and apply it separately before deploying new auth writers. Device-signed sync remains available.";

export class CoordinatorAuthSchemaUpgradeRequiredError extends Error {
	constructor() {
		super(AUTH_SCHEMA_UPGRADE_MESSAGE);
		this.name = AUTH_SCHEMA_UPGRADE_REQUIRED;
	}
}

// Inspect six actual columns and three proof triggers, never query the new columns.
// DDL text containing the same words is not sufficient. No writes or I/O cache.
export const AUTH_SCHEMA_READY_COUNT = 9;
export const AUTH_SCHEMA_READINESS_SQL = `SELECT
 (SELECT count(*) FROM pragma_table_info('coordinator_auth_link_attempts') WHERE lower(name) = 'authority_kind')
 + (SELECT count(*) FROM pragma_table_info('coordinator_auth_account_links') WHERE lower(name) IN ('authority_kind','device_claim_id'))
 + (SELECT count(*) FROM pragma_table_info('coordinator_auth_link_audit_log') WHERE lower(name) IN ('authority_kind','device_claim_id'))
 + (SELECT count(*) FROM pragma_table_info('coordinator_auth_device_claims') WHERE lower(name) = 'claim_id')
 + (SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND name IN ('coordinator_auth_device_claims_insert_collision',
 'coordinator_auth_device_claims_immutable_update','coordinator_auth_device_claims_immutable_delete')) AS ready`;

export interface CoordinatorAuthSchemaStore {
	assertAuthSchemaReady(): Promise<void>;
}

export async function assertCoordinatorAuthSchema(
	backend: Pick<AuthLinkBackend, "first">,
): Promise<void> {
	const row = await backend.first<{ ready: number }>({
		sql: AUTH_SCHEMA_READINESS_SQL,
		values: [],
	});
	if (row?.ready !== AUTH_SCHEMA_READY_COUNT) throw new CoordinatorAuthSchemaUpgradeRequiredError();
}

/** Protect every optional-auth SQL entry, including trusted callers outside HTTP. */
export function withCoordinatorAuthSchema(backend: AuthLinkBackend): AuthLinkBackend {
	return {
		first: async <T>(statement: AuthLinkStatement) => {
			await assertCoordinatorAuthSchema(backend);
			return backend.first<T>(statement);
		},
		run: async (statement) => {
			await assertCoordinatorAuthSchema(backend);
			return backend.run(statement);
		},
		batch: async (statements) => {
			await assertCoordinatorAuthSchema(backend);
			return backend.batch(statements);
		},
	};
}

export function authPersistenceError(error: unknown, fallback: string): Error {
	return error instanceof CoordinatorAuthSchemaUpgradeRequiredError ? error : new Error(fallback);
}

export async function assertConfiguredAuthSchema(
	store: Partial<CoordinatorAuthSchemaStore>,
): Promise<void> {
	if (typeof store.assertAuthSchemaReady !== "function")
		throw new Error("auth_schema_readiness_unavailable");
	await store.assertAuthSchemaReady();
}

export function authSchemaUpgradeResponse(): Response {
	return Response.json(
		{ error: AUTH_SCHEMA_UPGRADE_REQUIRED, message: AUTH_SCHEMA_UPGRADE_MESSAGE },
		{
			status: 503,
			headers: {
				"Cache-Control": "no-store",
				"X-Codemem-Auth-Error": AUTH_SCHEMA_UPGRADE_REQUIRED,
				"Referrer-Policy": "no-referrer",
				"X-Content-Type-Options": "nosniff",
			},
		},
	);
}
