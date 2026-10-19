import { statSync } from "node:fs";
import Database from "better-sqlite3";
import { applyAccountConnectionSchema } from "./coordinator-account-connection-schema.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import { upgradeAuthLinkAuthoritySchema } from "./coordinator-auth-link-authority-upgrade.js";

/** Opens only an existing, explicitly selected coordinator database; no store initialization. */
export function upgradeCoordinatorAuthSchemaFile(path: string): void {
	const db = new Database(path, { fileMustExist: true });
	try {
		upgradeAuthLinkAuthoritySchema(db);
	} finally {
		db.close();
	}
}

/** Explicit existing file only. Never initializes a store or selects a default.
 * Operators must pause auth writers, drain attempts and make their own backup. */
export async function upgradeCoordinatorAccountSchemaFile(path: string): Promise<void> {
	if (path === ":memory:" || path.startsWith("file:"))
		throw new Error(
			"Select an existing coordinator SQLite file path, not an in-memory database or URI.",
		);
	if (!statSync(path).isFile())
		throw new Error("Select an existing coordinator SQLite database file.");
	const db = new Database(path, { fileMustExist: true });
	try {
		const backend: AuthLinkBackend = {
			first: async <T>({ sql, values }: AuthLinkStatement) =>
				(db.prepare(sql).get(...values) as T | undefined) ?? null,
			run: async ({ sql, values }) => db.prepare(sql).run(...values).changes,
			batch: async (statements) =>
				db
					.transaction(() =>
						statements.map(({ sql, values }) => db.prepare(sql).run(...values).changes),
					)
					.immediate(),
		};
		await applyAccountConnectionSchema(backend);
	} finally {
		db.close();
	}
}
