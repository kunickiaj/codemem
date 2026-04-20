import { h } from "preact";
import type { ItemViewMode } from "../types";

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
