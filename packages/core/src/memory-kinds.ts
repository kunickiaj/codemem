/**
 * Canonical memory-kind catalog. The seven kinds below are the ones the
 * MCP remember tools accept; the store additionally allows
 * `session_summary` (written by the observer pipeline). Every surface
 * (MCP schema, store validation, viewer routes) imports this catalog so
 * the kinds never drift.
 */

export const MEMORY_KIND_DESCRIPTIONS: Record<string, string> = {
	discovery: "Something learned about the codebase, architecture, or tools",
	change: "A code change that was made",
	feature: "A new feature that was implemented",
	bugfix: "A bug that was found and fixed",
	refactor: "Code that was refactored or restructured",
	decision: "A design or architecture decision",
	exploration: "An experiment or investigation (may not have shipped)",
};

/** The seven kinds the MCP remember tools accept. */
export const REMEMBER_MEMORY_KINDS = Object.keys(MEMORY_KIND_DESCRIPTIONS);

/** Kinds accepted by the store: remembers plus the observer's session_summary. */
export const ALLOWED_MEMORY_KINDS = new Set<string>([...REMEMBER_MEMORY_KINDS, "session_summary"]);

/** Normalize and validate a memory kind. Throws on invalid kinds. */
export function validateMemoryKind(kind: string): string {
	const normalized = kind.trim().toLowerCase();
	if (!ALLOWED_MEMORY_KINDS.has(normalized)) {
		throw new Error(
			`Invalid memory kind "${kind}". Allowed: ${[...ALLOWED_MEMORY_KINDS].join(", ")}`,
		);
	}
	return normalized;
}
