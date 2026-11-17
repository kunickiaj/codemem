import {
	clearEnrollmentsAndRemovals,
	d1EnrollmentExec,
} from "../../core/src/coordinator-enrollment-test-fixtures.js";

/**
 * Test-only. The one way a native test clears enrollments and removal
 * tombstones between cases. The cases of a file share one D1 database, and both
 * tables refuse a plain delete once their triggers exist. `where` is the
 * condition after WHERE for the enrollments, and every tombstone is cleared.
 */
export function resetEnrollments(db: D1Database, where = "", ...values: unknown[]): Promise<void> {
	return clearEnrollmentsAndRemovals(d1EnrollmentExec(db), where, ...values);
}
