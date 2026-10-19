import {
	AUTH_SCHEMA_UPGRADE_MESSAGE,
	AUTH_SCHEMA_UPGRADE_REQUIRED,
	AUTH_V2_SCHEMA_READINESS_SQL,
	CoordinatorAuthSchemaUpgradeRequiredError,
	readConnectionSchemaState,
} from "./coordinator-account-connection-schema.js";

export {
	AUTH_SCHEMA_UPGRADE_MESSAGE,
	AUTH_SCHEMA_UPGRADE_REQUIRED,
	CoordinatorAuthSchemaUpgradeRequiredError,
} from "./coordinator-account-connection-schema.js";

import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import {
	captureAuthLinkBrowserSource,
	captureAuthLinkSource,
} from "./coordinator-auth-link-source.js";

// Inspect five authority columns, four proof definitions and the display staging table.
// No writes or I/O cache; unknown proof variants fail closed.
export const AUTH_SCHEMA_READY_COUNT = 10;
export const AUTH_SCHEMA_READINESS_SQL = AUTH_V2_SCHEMA_READINESS_SQL;

export interface CoordinatorAuthSchemaStore {
	assertAuthSchemaReady(): Promise<void>;
}

export async function assertCoordinatorAuthSchema(
	backend: Pick<AuthLinkBackend, "first">,
	options: { connections?: boolean } = {},
): Promise<void> {
	const state = await readConnectionSchemaState(backend);
	if (state === "upgrade_required" || (options.connections && state !== "ready"))
		throw new CoordinatorAuthSchemaUpgradeRequiredError();
}

/** Protect every optional-auth SQL entry, including trusted callers outside HTTP. */
export function withCoordinatorAuthSchema(
	backend: AuthLinkBackend,
	options: { connections?: boolean } = {},
): AuthLinkBackend {
	return {
		prepareAuthLinkSource: (...args) => captureAuthLinkSource(backend, ...args),
		prepareAuthLinkBrowserSource: (...args) => captureAuthLinkBrowserSource(backend, ...args),
		readAuthSchemaState: () => readConnectionSchemaState(backend),
		first: async <T>(statement: AuthLinkStatement) => {
			await assertCoordinatorAuthSchema(backend, options);
			return backend.first<T>(statement);
		},
		run: async (statement) => {
			await assertCoordinatorAuthSchema(backend, options);
			return backend.run(statement);
		},
		batch: async (statements) => {
			await assertCoordinatorAuthSchema(backend, options);
			return backend.batch(statements);
		},
	};
}

export function authPersistenceError(error: unknown, fallback: string): Error {
	if (String(error).includes("no such table: coordinator_auth_link_profiles"))
		return new CoordinatorAuthSchemaUpgradeRequiredError();
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
