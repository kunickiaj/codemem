/* Shared types for the Health tab — card inputs, stat rows, action
 * recommendations, and the Lucide runtime shape used by renderIcons.
 * Kept in one module so the component + renderer slices can agree on
 * shapes without bouncing through the barrel. */

export type HealthAction = {
	label: string;
	command: string;
	/** If set, show an actionable button that triggers this async function. */
	action?: (trigger: HTMLButtonElement) => Promise<void> | void;
	actionLabel?: string;
};

export type HealthCardInput = {
	key?: string;
	label: string;
	value: string;
	detail?: string;
	icon?: string;
	className?: string;
	title?: string;
	loading?: boolean;
};

export type HealthActionRowProps = {
	item: HealthAction;
};

export type StatItem = {
	label: string;
	value: string | number | null | undefined;
	icon: string;
	tooltip?: string;
};

export type UsageEvent = {
	event?: string;
	count?: number;
	total_tokens_read?: number;
	total_tokens_written?: number;
	total_tokens_saved?: number;
	token_unit?: "tokens";
	measured_count?: number;
	estimated_count?: number;
	unavailable_count?: number;
	legacy_text_length_count?: number;
};

export type LucideRuntime = {
	createIcons: () => void;
};
