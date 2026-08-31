import type { Database } from "./db.js";
import { normalizeLegacyProjectMappingIdentity } from "./legacy-recipient-policy-projection.js";
import { SYNC_BOOTSTRAP_CWD_PREFIX } from "./sync-bootstrap-constants.js";

export function hasLocalInventoryIdentity(db: Database, workspaceIdentity: string): boolean {
	const row = db
		.prepare(
			`SELECT 1 AS one
			 FROM sessions s
			 JOIN memory_items mi ON mi.session_id = s.id
			 WHERE (s.cwd IS NULL OR substr(s.cwd, 1, length(?)) <> ?)
			   AND COALESCE(s.tool_version, '') <> 'sync_replication'
			   AND COALESCE(TRIM(s.git_remote), TRIM(s.cwd), '') = ''
			   AND mi.workspace_id IS NOT NULL
			   AND RTRIM(REPLACE(TRIM(mi.workspace_id), CHAR(92), '/'), '/') = ?
			 LIMIT 1`,
		)
		.get(
			SYNC_BOOTSTRAP_CWD_PREFIX,
			SYNC_BOOTSTRAP_CWD_PREFIX,
			normalizeLegacyProjectMappingIdentity(workspaceIdentity),
		) as { one: number } | undefined;
	return Boolean(row);
}
