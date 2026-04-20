/* Feed summary-line text — shows counts, scope, filters, "scroll for more". */

import { state } from "../../../lib/state";
import { feedScopeLabel } from "./helpers";

export function feedMetaText(visibleCount: number, hasMorePages: boolean): string {
	const filterLabel =
		state.feedTypeFilter === "observations"
			? " · observations"
			: state.feedTypeFilter === "summaries"
				? " · session summaries"
				: "";
	const scopeLabel = feedScopeLabel(state.feedScopeFilter);
	const filteredLabel =
		!state.feedQuery.trim() && state.lastFeedFilteredCount
			? ` · ${state.lastFeedFilteredCount} observations filtered`
			: "";
	const queryLabel = state.feedQuery.trim() ? ` · matching "${state.feedQuery.trim()}"` : "";
	const moreLabel = hasMorePages ? " · scroll for more" : "";
	return `${visibleCount} items${filterLabel}${scopeLabel}${queryLabel}${filteredLabel}${moreLabel}`;
}
