import { h } from "preact";

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
