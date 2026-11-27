import type { AuthLinkBackend } from "./coordinator-auth-link.js";

export const enrollmentDml = /\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+enrolled_devices\b/i;

/** Some fixtures return SQLite run results, some return D1Result, and the
 * production auth backend projects each D1Result to its own change count.
 */
export function captureEnrollmentBatch(
	backend: AuthLinkBackend,
	counts: number[],
): AuthLinkBackend {
	return {
		...backend,
		batch: async (statements) => {
			const results = await backend.batch(statements);
			for (const [index, statement] of statements.entries()) {
				if (!enrollmentDml.test(statement.sql)) continue;
				if (!Array.isArray(results)) throw new Error("missing enrollment receipts");
				const result = results[index] as number | { meta?: { changes: number }; changes?: number };
				const count =
					typeof result === "number" ? result : (result.meta?.changes ?? result.changes);
				if (typeof count !== "number") throw new Error("missing enrollment count");
				counts.push(count);
			}
			return results;
		},
	};
}
