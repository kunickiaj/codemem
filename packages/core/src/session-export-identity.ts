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

function firstNonblankMemoryKey(db: Database, sessionId: number): string | null {
	// Use all history, independent of mutable labels or the caller's readable subset.
	const candidates = db
		.prepare(`SELECT import_key FROM memory_items
			WHERE session_id = ? AND import_key IS NOT NULL
			ORDER BY id ASC`)
		.iterate(sessionId) as IterableIterator<Record<string, unknown>>;
	for (const candidate of candidates) {
		const key = nonblankString(candidate.import_key);
		if (key) return key;
	}
	return null;
}

/** Resolve export bookkeeping identity without changing source rows or enrollment state. */
export function exportedSessionKey(db: Database, row: Record<string, unknown>): string {
	const sourceKey = nonblankString(row.import_key);
	if (isCanonicalSessionKey(sourceKey)) return sourceKey;
	if (sourceKey) return `export-session:v1:${hashIdentity(["import_key", sourceKey])}`;

	const memoryKey = firstNonblankMemoryKey(db, Number(row.id));
	if (!memoryKey)
		throw new Error("session_identity_unavailable: session has no immutable source key");
	return `export-session:v1:${hashIdentity(["memory_key", memoryKey])}`;
}

/** Apply a project namespace to a validated canonical key, replacing any prior remap. */
export function remappedSessionKey(marker: string, remapProject: string): string {
	const baseKey = marker.replace(/:remap:[a-f0-9]{64}$/, "");
	return `${baseKey}:remap:${hashIdentity(remapProject)}`;
}
