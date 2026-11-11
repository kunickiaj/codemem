/**
 * Vitest setup file for the D1 statement check. While the core coordinator tests run,
 * it records every SQL statement they prepare, of any length, with the schema of the
 * database it was prepared on and the frames that prepared it. It does nothing unless
 * the capture directory is set.
 */
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { basename, join } from "node:path";
import Database from "better-sqlite3";

const directory = process.env.CODEMEM_D1_STATEMENT_CAPTURE_DIR;
// Frames kept per statement: enough to name an excluded test oracle above its callbacks.
const ORIGIN_FRAMES = 6;

interface SchemaObject {
	type: string;
	name: string;
	sql: string;
}

if (directory) {
	const file = join(directory, `${process.pid}.jsonl`);
	const seen = new Set<string>();
	/** Appends a record the first time its key is seen; reports whether it did. */
	const record = (kind: string, key: string, value: () => unknown): boolean => {
		const id = `${kind}\n${key}`;
		if (seen.has(id)) return false;
		seen.add(id);
		const hash = createHash("sha1").update(id).digest("hex");
		appendFileSync(file, `${JSON.stringify({ kind, hash, value: value() })}\n`);
		return true;
	};
	const prepare = Database.prototype.prepare;
	// The schema each database had when it last changed, so it is read only once per change.
	const schemas = new WeakMap<
		Database.Database,
		{ version: Database.Statement; known?: { version: number; hash: string } }
	>();
	/** The hash of this database's current schema, recorded the first time it is seen. */
	const schemaOf = (db: Database.Database): string => {
		let entry = schemas.get(db);
		if (!entry) {
			entry = { version: prepare.call(db, "PRAGMA schema_version").pluck() };
			schemas.set(db, entry);
		}
		const version = entry.version.get() as number;
		if (entry.known?.version === version) return entry.known.hash;
		const objects = prepare
			.call(db, "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name")
			.all() as SchemaObject[];
		const hash = createHash("sha1").update(JSON.stringify(objects)).digest("hex");
		record("schema", hash, () => ({ hash, objects }));
		entry.known = { version, hash };
		return hash;
	};
	/** The file and function of each frame above the prepare call. */
	const originOf = (above: (...args: never[]) => unknown) => {
		const previous = Error.prepareStackTrace;
		Error.prepareStackTrace = (_error, frames) => frames;
		const holder: { stack?: NodeJS.CallSite[] } = {};
		Error.captureStackTrace(holder, above);
		const frames = holder.stack ?? [];
		Error.prepareStackTrace = previous;
		return frames.slice(0, ORIGIN_FRAMES).map((frame) => ({
			file: basename(frame.getFileName() ?? ""),
			function: frame.getFunctionName() ?? "",
		}));
	};
	Database.prototype.prepare = function capturePrepare(this: Database.Database, sql: string) {
		if (typeof sql === "string") {
			// Each statement is checked against the schema it was prepared on.
			const schema = schemaOf(this);
			record("statement", `${schema}\n${sql}`, () => ({
				sql,
				schema,
				origin: originOf(capturePrepare),
			}));
		}
		return prepare.call(this, sql);
	} as typeof prepare;
}
