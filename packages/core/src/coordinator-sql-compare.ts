/**
 * SQL comparison rules for TypeScript decisions over rows read from SQLite.
 *
 * In SQL a comparison with NULL is neither true nor false, and WHERE keeps a row only
 * when its condition is true. So `a <> b` does not select a row whose `a` is NULL, while
 * JavaScript's `a !== b` would. Each helper answers "is this SQL comparison true?".
 *
 * Operands must already have the same storage class. SQLite can also convert between
 * text and numbers by column affinity; these helpers never do, so text never equals a
 * number.
 */

/** A value as SQLite returns it through JSON: text, a number, or NULL. */
export type SqlValue = string | number | null;

/** SQL `a = b`. */
export function sqlEq(a: SqlValue, b: SqlValue): boolean {
	return a !== null && b !== null && a === b;
}

/** SQL `a <> b`. */
export function sqlNe(a: SqlValue, b: SqlValue): boolean {
	return a !== null && b !== null && a !== b;
}

/** SQL `a IN (list)` for a list without NULL. */
export function sqlIn(a: SqlValue, list: readonly (string | number)[]): boolean {
	return a !== null && list.includes(a);
}

/** SQL `a IS b`: true when both are NULL or both are the same value. */
export function sqlIs(a: SqlValue, b: SqlValue): boolean {
	return a === b;
}
