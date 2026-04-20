/* Pure helpers for the context-inspector panel — query draft seeding,
 * working-set parsing, and the context key used to cache trace results. */

export function syncInspectorQueryDraft(options: {
	feedQuery: string;
	inspectorQuery: string;
	hasInspectorOverride: boolean;
}): string {
	return options.hasInspectorOverride ? options.inspectorQuery : options.feedQuery;
}

export function parseInspectorWorkingSet(value: string): string[] {
	return value
		.split(/\n|,/)
		.map((item) => item.trim())
		.filter(Boolean);
}

export function packTraceContextKey(options: {
	project: string | null;
	query: string;
	workingSetFiles: string[];
}): string {
	return JSON.stringify([options.project, options.query.trim(), options.workingSetFiles]);
}
