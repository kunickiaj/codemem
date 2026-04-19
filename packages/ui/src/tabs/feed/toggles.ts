/* Feed toggle buttons + tag chip — tiny leaf components shared across
 * the feed tab. */

import { h } from "preact";
import { Chip } from "../../components/primitives/chip";
import { formatTagLabel } from "../../lib/format";
import type { ItemViewMode } from "./types";

export function FeedViewToggle({
	modes,
	active,
	onSelect,
}: {
	modes: Array<{ id: ItemViewMode; label: string }>;
	active: ItemViewMode;
	onSelect: (mode: ItemViewMode) => void;
}) {
	if (modes.length <= 1) return null;
	return h(
		"div",
		{ className: "feed-toggle" },
		modes.map((mode) =>
			h(
				"button",
				{
					key: mode.id,
					className: `toggle-button${mode.id === active ? " active" : ""}`,
					"data-filter": mode.id,
					onClick: () => onSelect(mode.id),
					type: "button",
				},
				mode.label,
			),
		),
	);
}

export function FeedToggle({
	id,
	active,
	options,
	onSelect,
}: {
	id: string;
	active: string;
	options: Array<{ value: string; label: string }>;
	onSelect: (value: string) => void;
}) {
	return h(
		"div",
		{ className: "feed-toggle", id },
		options.map(({ value, label }) => {
			const selected = value === active;
			return h(
				"button",
				{
					"aria-pressed": selected ? "true" : "false",
					className: `toggle-button${selected ? " active" : ""}`,
					"data-filter": value,
					key: value,
					onClick: () => onSelect(value),
					type: "button",
				},
				label,
			);
		}),
	);
}

export function TagChip({ tag }: { tag: unknown }) {
	const display = formatTagLabel(tag);
	if (!display) return null;
	return h(Chip, { variant: "tag", title: String(tag) }, display);
}
