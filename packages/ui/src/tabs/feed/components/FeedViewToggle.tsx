import { h, type TargetedKeyboardEvent } from "preact";
import type { ItemViewMode } from "../types";

const PREVIOUS_KEYS = new Set(["ArrowLeft", "ArrowUp"]);
const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown"]);

export function FeedViewToggle({
	modes,
	active,
	ariaLabel,
	onSelect,
}: {
	modes: Array<{ id: ItemViewMode; label: string }>;
	active: ItemViewMode;
	ariaLabel: string;
	onSelect: (mode: ItemViewMode) => void;
}) {
	if (modes.length <= 1) return null;

	function moveSelection(event: TargetedKeyboardEvent<HTMLButtonElement>, index: number) {
		let nextIndex = index;
		if (PREVIOUS_KEYS.has(event.key)) nextIndex = (index - 1 + modes.length) % modes.length;
		if (NEXT_KEYS.has(event.key)) nextIndex = (index + 1) % modes.length;
		if (event.key === "Home") nextIndex = 0;
		if (event.key === "End") nextIndex = modes.length - 1;
		if (nextIndex === index && !PREVIOUS_KEYS.has(event.key) && !NEXT_KEYS.has(event.key)) return;
		event.preventDefault();
		const nextMode = modes[nextIndex];
		if (!nextMode) return;
		onSelect(nextMode.id);
		const group = event.currentTarget.parentElement;
		group?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[nextIndex]?.focus();
	}

	return h(
		"div",
		{ "aria-label": ariaLabel, className: "feed-toggle", role: "radiogroup" },
		modes.map((mode, index) =>
			h(
				"button",
				{
					"aria-checked": mode.id === active,
					className: "toggle-button",
					key: mode.id,
					onClick: () => onSelect(mode.id),
					onKeyDown: (event: TargetedKeyboardEvent<HTMLButtonElement>) =>
						moveSelection(event, index),
					role: "radio",
					tabIndex: mode.id === active ? 0 : -1,
					type: "button",
				},
				mode.label,
			),
		),
	);
}
