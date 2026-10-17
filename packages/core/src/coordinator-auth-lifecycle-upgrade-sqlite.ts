import type { Database } from "better-sqlite3";
import { AUTH_LIFECYCLE_SQLITE_TEMP_SCHEMA_CHECK_SQL } from "./coordinator-auth-lifecycle-recognition.js";
import { AUTH_LIFECYCLE_UPGRADE_STATEMENTS } from "./coordinator-auth-lifecycle-upgrade.js";

export class CoordinatorAuthLifecycleUpgradeRejectedError extends Error {
	constructor() {
		super(
			"Coordinator lifecycle upgrade rejected. No migration changes were committed. Use a dedicated connection and review the predecessor schema; do not delete or restore data automatically.",
		);
		this.name = "CoordinatorAuthLifecycleUpgradeRejectedError";
	}
}

/** Explicit invocation only. Never call from store open or normal auth requests.
 * SQLite-only connection checks run inside the same reserved write transaction,
 * before preparing or executing any migration SQL that TEMP could shadow.
 */
export function upgradeAuthLifecycleSchema(db: Database): void {
	try {
		db.transaction(() => {
			const checks = db.prepare("PRAGMA ignore_check_constraints").get() as {
				ignore_check_constraints: number;
			};
			if (checks.ignore_check_constraints !== 0) {
				throw new CoordinatorAuthLifecycleUpgradeRejectedError();
			}
			const temp = db
				.prepare(`SELECT ${AUTH_LIFECYCLE_SQLITE_TEMP_SCHEMA_CHECK_SQL} AS safe`)
				.get() as { safe: number };
			const databases = db.prepare("PRAGMA database_list").all() as { name: string }[];
			if (temp.safe !== 1 || databases.some(({ name }) => name !== "main" && name !== "temp")) {
				throw new CoordinatorAuthLifecycleUpgradeRejectedError();
			}
			for (const statement of AUTH_LIFECYCLE_UPGRADE_STATEMENTS) db.exec(statement);
		}).immediate();
	} catch {
		throw new CoordinatorAuthLifecycleUpgradeRejectedError();
	}
}
