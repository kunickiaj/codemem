/**
 * Test-only. This file exists only to pin equivalence with the pre-port SQL.
 *
 * Between the markers are `withNegativeOwnerWrite` from
 * coordinator-owner-negative-consistency.ts and `withEnrollmentNegativeOwner` from
 * coordinator-owner-enrollment-commit.ts as they were on main at 9a9bf301f, before the
 * producers moved to read-set guards, copied verbatim. Only `export` was added to the
 * second. The functions after the markers rebuild each producer's old batch from the
 * statements the ported producer writes, the way the old call sites composed them:
 * the first account link pinned its first two statements, and owner enrollment pinned
 * its winning update and its binding insert. Do not edit the copy to follow later
 * changes; delete this file with coordinator-owner-producer-equivalence.test.ts.
 */
import type { AuthLinkStatement } from "./coordinator-auth-link.js";

// ---- verbatim copy starts ----
/** Compose only trusted producer statements; all captured data remains bound. */
export function withNegativeOwnerWrite(
	statement: AuthLinkStatement,
	predicate: AuthLinkStatement,
): AuthLinkStatement {
	const sql = statement.sql.trimStart();
	const tail = sql.startsWith("WITH ") ? sql.slice(5) : sql;
	const separator = sql.startsWith("WITH ") ? "," : "";
	const conflict = tail.indexOf("ON CONFLICT");
	const beforeConflict = conflict < 0 ? tail : tail.slice(0, conflict);
	const afterConflict = conflict < 0 ? "" : tail.slice(conflict);
	return {
		sql: `WITH negative_owner_consistency AS MATERIALIZED (${predicate.sql})${separator} ${beforeConflict} AND (SELECT matches FROM negative_owner_consistency) ${afterConflict}`,
		values: [...predicate.values, ...statement.values],
	};
}
/** Join the already materialized negative result rather than adding its SELECT
 * tree beneath the UPDATE's long chain of ordinary pins (native D1 depth 100).
 * These markers belong only to this module's trusted winning UPDATE template.
 */
export function withEnrollmentNegativeOwner(
	update: AuthLinkStatement,
	consistency: AuthLinkStatement,
): AuthLinkStatement {
	const checked = withNegativeOwnerWrite(update, consistency);
	const source = "FROM owner_commit_links p";
	const guard = "AND (SELECT matches FROM negative_owner_consistency)";
	if (!checked.sql.includes(source) || !checked.sql.includes(guard))
		throw new Error("owner_enrollment_statement_invalid");
	return {
		sql: checked.sql
			.replace(source, `${source} CROSS JOIN negative_owner_consistency negative`)
			.replace(guard, "AND negative.matches"),
		values: checked.values,
	};
}
// ---- verbatim copy ends ----

/** The first account link's old batch: its attempt update and claim insert carried the pin. */
export function originalFirstLinkBatch(
	writes: AuthLinkStatement[],
	pin: AuthLinkStatement,
): AuthLinkStatement[] {
	return writes.map((statement, index) =>
		index < 2 ? withNegativeOwnerWrite(statement, pin) : statement,
	);
}

/** Owner enrollment's old batch: its winning update and binding insert carried the pin. */
export function originalOwnerEnrollmentBatch(
	writes: AuthLinkStatement[],
	pin: AuthLinkStatement,
): AuthLinkStatement[] {
	return writes.map((statement, index) => {
		if (index === 0) return withEnrollmentNegativeOwner(statement, pin);
		if (index === 1) return withNegativeOwnerWrite(statement, pin);
		return statement;
	});
}
