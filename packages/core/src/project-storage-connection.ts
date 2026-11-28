import type { Database } from "better-sqlite3";
import {
	contentStorageShape,
	type TransitionedTable,
	transitionedTables,
} from "./transitioned-store-tables.js";

const converted = new WeakSet<Database>();

export function physicalTableName(db: Database, name: string): string {
	return converted.has(db) && Object.hasOwn(transitionedTables, name)
		? transitionedTables[name as TransitionedTable]
		: name;
}

// Runtime SQL (including ORM-generated SQL) uses four reserved store identifiers.
// Only whole identifiers change. Bound values never pass through here. Skip SQL
// strings, comments, and named parameters before considering identifier tokens.
const tokens =
	/'(?:''|[^'])*(?:'|$)|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:""|[^"])*(?:"|$)|`(?:``|[^`])*(?:`|$)|\[[^\]]*(?:\]|$)|[:@$][\w$\u0080-\uFFFF]+|[\w$\u0080-\uFFFF]+/gu;

function physicalSql(sql: string): string {
	return sql.replace(tokens, (token) => {
		const quoted = token.startsWith('"') || token.startsWith("`") || token.startsWith("[");
		const name = (quoted ? token.slice(1, -1) : token).toLowerCase();
		if (!Object.hasOwn(transitionedTables, name)) return token;
		const physical = transitionedTables[name as TransitionedTable];
		return quoted ? `"${physical}"` : physical;
	});
}

/** Select the on-disk names before bootstrap, schema validation or Drizzle access. */
export function selectProjectStorage(db: Database): void {
	if (converted.has(db) || contentStorageShape(db) === "legacy") return;
	for (const method of ["prepare", "exec", "pragma"] as const) {
		const original = db[method];
		Object.defineProperty(db, method, {
			value: new Proxy(original, {
				apply(target, receiver, args) {
					const [sql, ...rest] = args;
					return Reflect.apply(target, receiver, [physicalSql(sql), ...rest]);
				},
			}),
		});
	}
	converted.add(db);
}
