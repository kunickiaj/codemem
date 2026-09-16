import type { Database } from "./db.js";
import { hasLocalInventoryIdentity } from "./local-project-inventory.js";

export { isFilesystemRootProjectIdentity } from "./legacy-project-identity.js";

export function isMigratableLegacyTeamProjectIdentity(identity: string, db?: Database): boolean {
	const normalized = identity.trim();
	return (
		normalized !== "shared" &&
		normalized !== "shared:default" &&
		normalized !== "shared:legacy" &&
		!normalized.startsWith("personal:") &&
		(!normalized.startsWith("peer-received:") ||
			Boolean(db && hasLocalInventoryIdentity(db, normalized)))
	);
}
