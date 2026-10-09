import { createHash } from "node:crypto";
import type { Database } from "./db.js";

function nonblankString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	return value.trim() ? value : null;
}

function hashIdentity(value: string | readonly [string, string]): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function isCanonicalSessionKey(value: string | null): value is string {
	return value != null && /^export-session:v1:[a-f0-9]{64}(?::remap:[a-f0-9]{64})?$/.test(value);
}

/** Resolve export bookkeeping identity without changing source rows or enrollment state. */
export function exportedSessionKey(db: Database, row: Record<string, unknown>): string {
	const sourceKey = nonblankString(row.import_key);
	if (isCanonicalSessionKey(sourceKey)) return sourceKey;
	if (sourceKey) return `export-session:v1:${hashIdentity(["import_key", sourceKey])}`;

	// Historical native sessions use the first immutable memory key across all
	// history, not mutable project/device labels or the export's readable subset.
	const memory = db
		.prepare(`SELECT import_key FROM memory_items
			WHERE session_id = ? AND import_key IS NOT NULL AND trim(import_key) <> ''
			ORDER BY id ASC LIMIT 1`)
		.get(Number(row.id)) as { import_key: string } | undefined;
	if (!memory) throw new Error("session_identity_unavailable: session has no immutable source key");
	return `export-session:v1:${hashIdentity(["memory_key", memory.import_key])}`;
}

/** Apply a project namespace to a validated canonical key, replacing any prior remap. */
export function remappedSessionKey(marker: string, remapProject: string): string {
	const baseKey = marker.replace(/:remap:[a-f0-9]{64}$/, "");
	return `${baseKey}:remap:${hashIdentity(remapProject)}`;
}
