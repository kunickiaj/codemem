import Database from "better-sqlite3";
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
