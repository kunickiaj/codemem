import type { Database } from "./db.js";
import { hasLocalInventoryIdentity } from "./local-project-inventory.js";

export function isFilesystemRootProjectIdentity(value: string): boolean {
	const normalized = value.trim().replaceAll("\\", "/");
	if (normalized === "/" || /^[A-Za-z]:\/?$/u.test(normalized)) return true;
	if (/^\/\/[^/]+\/[^/]+\/?$/u.test(normalized)) return true;
	try {
		const parsed = new URL(normalized);
		if (parsed.protocol !== "file:") return false;
		if (parsed.pathname === "/" || parsed.pathname === "") return true;
		if (parsed.hostname === "" && /^\/[A-Za-z]:\/?$/u.test(parsed.pathname)) return true;
		if (parsed.hostname === "" && /^\/\/[^/]+\/[^/]+\/?$/u.test(parsed.pathname)) return true;
		return parsed.hostname !== "" && parsed.pathname.split("/").filter(Boolean).length === 1;
	} catch {
		return false;
	}
}

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
