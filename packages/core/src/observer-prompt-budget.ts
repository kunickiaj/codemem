/**
 * The observer prompt budget (`observer_max_chars`): instructions are always sent
 * whole, and the observed content gets what the budget leaves after them.
 */

/** Default `observer_max_chars`, shared by the observer client, ingest and replay. */
export const DEFAULT_OBSERVER_MAX_CHARS = 12_000;

/** The content budget never drops below this share of the budget. */
const MIN_CONTENT_SHARE = 0.25;

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
}

/** Characters left for content after instructions of this length, with a floor. */
export function observerContentBudget(maxChars: number, instructionChars: number): number {
	return Math.max(Math.floor(maxChars * MIN_CONTENT_SHARE), maxChars - instructionChars);
}

/** Send the instructions whole and clip only the content to the budget they leave. */
export function budgetObserverPrompts(
	systemPrompt: string,
	userPrompt: string,
	maxChars: number,
): { system: string; user: string; budget: ObserverPromptBudget } {
	const contentBudgetChars = observerContentBudget(maxChars, systemPrompt.length);
	const contentClipped = userPrompt.length > contentBudgetChars;
	const user = (
		contentClipped ? userPrompt.slice(0, contentBudgetChars) : userPrompt
	).toWellFormed();
	return {
		system: systemPrompt.toWellFormed(),
		user,
		budget: {
			maxChars,
			instructionChars: systemPrompt.length,
			contentBudgetChars,
			contentChars: userPrompt.length,
			sentContentChars: user.length,
			contentClipped,
			instructionsOverBudget: systemPrompt.length > maxChars,
		},
	};
}
