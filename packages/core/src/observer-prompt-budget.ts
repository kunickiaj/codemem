/**
 * The observer prompt budget (`observer_max_chars`): instructions are always sent
 * whole, and the observed content gets what the budget leaves after them.
 */

/** Default `observer_max_chars`, shared by the observer client, ingest and replay. */
export const DEFAULT_OBSERVER_MAX_CHARS = 24_000;

/**
 * The lowest `observer_max_chars` the configuration accepts. Its quarter-budget content
 * floor (500) always holds the content header and the repair prompt's labels.
 */
export const MIN_OBSERVER_MAX_CHARS = 2_000;

/** The content budget never drops below this share of the budget. */
const MIN_CONTENT_SHARE = 0.25;

/** Lengths only: one section of the observed content before and after fitting. */
export interface ObserverContentSection {
	name: string;
	chars: number;
	sentChars: number;
}

/** Lengths only: what one observer call was allowed and what it sent. */
export interface ObserverPromptBudget {
	/** The configured `observer_max_chars`. */
	maxChars: number;
	instructionChars: number;
	contentBudgetChars: number;
	/** Content length before clipping. */
	contentChars: number;
	/** Content length actually sent. */
	sentContentChars: number;
	contentClipped: boolean;
	/** The instructions alone exceed the budget: a configuration error, sent in full anyway. */
	instructionsOverBudget: boolean;
	/** Per-section lengths when the caller built the content by section, otherwise null. */
	sections: ObserverContentSection[] | null;
}

/** Characters left for content after instructions of this length, with a floor. */
export function observerContentBudget(maxChars: number, instructionChars: number): number {
	return Math.max(Math.floor(maxChars * MIN_CONTENT_SHARE), maxChars - instructionChars);
}

/** Content its builder already fitted by section, with its length before fitting. */
export interface PreparedObserverContent {
	contentChars: number;
	sections: ObserverContentSection[];
}

/** Prepared lengths and the exact content they describe. */
export interface PreparedObserverPrompt extends PreparedObserverContent {
	user: string;
}

/**
 * Send the instructions whole and clip only the content to the budget they leave.
 * Prepared content reports its length before the builder fitted it, so a fitted
 * batch counts as clipped.
 */
export function budgetObserverPrompts(
	systemPrompt: string,
	userPrompt: string,
	maxChars: number,
	prepared: PreparedObserverContent | null = null,
): { system: string; user: string; budget: ObserverPromptBudget } {
	const contentBudgetChars = observerContentBudget(maxChars, systemPrompt.length);
	const clippedHere = userPrompt.length > contentBudgetChars;
	const user = (clippedHere ? userPrompt.slice(0, contentBudgetChars) : userPrompt).toWellFormed();
	const contentChars = Math.max(prepared?.contentChars ?? 0, userPrompt.length);
	return {
		system: systemPrompt.toWellFormed(),
		user,
		budget: {
			maxChars,
			instructionChars: systemPrompt.length,
			contentBudgetChars,
			contentChars,
			sentContentChars: user.length,
			contentClipped: contentChars > user.length,
			instructionsOverBudget: systemPrompt.length > maxChars,
			sections: prepared?.sections.map((section) => ({ ...section })) ?? null,
		},
	};
}
