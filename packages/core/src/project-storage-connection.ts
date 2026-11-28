import type { Database, Statement } from "better-sqlite3";
import {
	isCatalogSql,
	logicalRow,
	physicalSql,
	physicalValue,
} from "./transitioned-store-names.js";
import { contentStorageShape } from "./transitioned-store-tables.js";

const converted = new WeakSet<Database>();
const statementMethods = new Set(["get", "all", "iterate", "run", "bind"]);

/**
 * A catalog statement looks objects up by name: bound names are translated to
 * on-disk names and returned names and schema text are translated back, so
 * existence checks and definition comparisons read the same on both shapes.
 */
function catalogStatement(statement: Statement): Statement {
	const proxy: Statement = new Proxy(statement, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				const bound = statementMethods.has(String(property)) ? args.map(physicalValue) : args;
				const result = value.apply(target, bound);
				if (result === target) return proxy;
				if (property === "get") return logicalRow(result);
				if (property === "all") return (result as unknown[]).map(logicalRow);
				if (property === "iterate")
					return (function* () {
						for (const row of result as Iterable<unknown>) yield logicalRow(row);
					})();
				return result;
			};
		},
	});
	return proxy;
}

/**
 * Select the on-disk names before bootstrap, schema validation or Drizzle access.
 * Runtime SQL (including ORM-generated SQL) keeps the released names.
 */
export function selectProjectStorage(db: Database): void {
	if (converted.has(db) || contentStorageShape(db) === "legacy") return;
	const { prepare, exec, pragma } = db;
	Object.defineProperty(db, "prepare", {
		configurable: true,
		value: (sql: string) => {
			const statement = prepare.call(db, physicalSql(sql));
			return isCatalogSql(sql) ? catalogStatement(statement) : statement;
		},
	});
	Object.defineProperty(db, "exec", {
		configurable: true,
		value: (sql: string) => {
			exec.call(db, physicalSql(sql));
			return db;
		},
	});
	Object.defineProperty(db, "pragma", {
		configurable: true,
		value: (sql: string, options?: { simple?: boolean }) =>
			pragma.call(db, physicalSql(sql), options),
	});
	converted.add(db);
}
