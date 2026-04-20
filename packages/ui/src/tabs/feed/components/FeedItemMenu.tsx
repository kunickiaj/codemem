import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { h } from "preact";

export function FeedItemMenu({
	disabled,
	onForget,
	title,
}: {
	disabled: boolean;
	onForget: () => void;
	title: string;
}) {
	return h(
		DropdownMenu.Root,
		null,
		h(
			DropdownMenu.Trigger,
			{ asChild: true },
			h(
				"button",
				{ "aria-label": `Actions for ${title}`, className: "feed-menu-trigger", type: "button" },
				"⋯",
			),
		),
		h(
			DropdownMenu.Portal,
			null,
			h(
				DropdownMenu.Content,
				{ align: "end", className: "feed-menu-panel", side: "bottom", sideOffset: 4 },
				h(
					DropdownMenu.Item,
					{ className: "feed-menu-item danger", disabled, onSelect: () => onForget() },
					disabled ? "Forgetting…" : "Forget memory",
				),
			),
		),
	);
}
