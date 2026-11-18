import { projectBasename } from "./project.js";
import { syncProjectAllowedByFilters } from "./sync-replication.js";

export interface PeerProjectFilters {
	include: string[];
	exclude: string[];
}

/** Stored lists are trimmed and empty entries removed by the delivery reader. */
function normalized(filters: PeerProjectFilters): PeerProjectFilters {
	const clean = (values: string[]) => [
		...new Set(values.map((value) => value.trim()).filter(Boolean)),
	];
	return { include: clean(filters.include), exclude: clean(filters.exclude) };
}

/** A value not named literally by either filter. */
function unnamedValue(values: Set<string>, basename: string): string {
	let prefix = "/filter-comparison/";
	while (values.has(`${prefix}${basename}`)) prefix += "nested/";
	return `${prefix}${basename}`;
}

/**
 * Checks every class the filter predicate distinguishes: each literal value,
 * unnamed paths with each named basename, and values matching neither list.
 * Outside the literal values, only the basename can affect the decision.
 */
export function peerProjectFiltersOnlyNarrow(
	currentFilters: PeerProjectFilters,
	nextFilters: PeerProjectFilters,
): boolean {
	const current = normalized(currentFilters);
	const next = normalized(nextFilters);
	const literals = new Set([
		...current.include,
		...current.exclude,
		...next.include,
		...next.exclude,
	]);
	const basenames = [...literals].filter((value) => projectBasename(value) === value);
	const candidates = [...literals, ...basenames.map((value) => unnamedValue(literals, value))];
	let other = "unlisted-project";
	while (literals.has(other)) other += "-other";
	candidates.push(unnamedValue(literals, other));
	return candidates.every(
		(value) =>
			!syncProjectAllowedByFilters(value, next) || syncProjectAllowedByFilters(value, current),
	);
}
