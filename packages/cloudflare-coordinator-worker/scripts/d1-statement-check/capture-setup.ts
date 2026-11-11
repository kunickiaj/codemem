/**
 * Vitest setup file for the D1 statement check. While the core coordinator tests
 * run, it records every large SQL statement they prepare and the schema of the
 * database it was prepared on. It does nothing unless the capture directory is set.
 */
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

const directory = process.env.CODEMEM_D1_STATEMENT_CAPTURE_DIR;
// Short statements cannot reach D1's nesting limits.
const MIN_STATEMENT_LENGTH = 1500;

interface SchemaObject {
	type: string;
	name: string;
	sql: string;
}

if (directory) {
	const file = join(directory, `${process.pid}.jsonl`);
	const seen = new Set<string>();
	const hashOf = (text: string) => createHash("sha1").update(text).digest("hex");
	/** Appends a record the first time its key is seen, and reports whether it did. */
	const record = (kind: string, key: string, value: unknown): boolean => {
		const hash = hashOf(key);
		if (seen.has(hash)) return false;
		seen.add(hash);
		appendFileSync(file, `${JSON.stringify({ kind, hash, value })}\n`);
		return true;
	};
	const prepare = Database.prototype.prepare;
	Database.prototype.prepare = function capturePrepare(this: Database.Database, sql: string) {
		const isLarge = typeof sql === "string" && sql.length >= MIN_STATEMENT_LENGTH;
		if (isLarge && record("statement", sql, sql)) {
			const objects = prepare
				.call(this, "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL")
				.all() as SchemaObject[];
			for (const object of objects) record("schema", `${object.name}\n${object.sql}`, object);
		}
		return prepare.call(this, sql);
	} as typeof prepare;
}
