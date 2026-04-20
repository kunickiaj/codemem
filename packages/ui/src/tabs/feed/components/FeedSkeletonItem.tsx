import { h } from "preact";

export function FeedSkeletonItem({ index }: { index: number }) {
	// Alternate widths across the skeleton set so the stack doesn't look
	// mechanically repeated. Three variants is enough to read as "loading."
	const bodyWidths = [
		["w-85", "w-65"],
		["w-85", "w-40"],
		["w-65", "w-85"],
	];
	const [first, second] = bodyWidths[index % bodyWidths.length];
	return h(
		"div",
		{ className: "feed-skeleton-item", "aria-hidden": "true" },
		h("div", { className: "feed-skeleton-banner" }),
		h(
			"div",
			{ className: "feed-skeleton-body" },
			h("div", { className: `feed-skeleton-line ${first}` }),
			h("div", { className: `feed-skeleton-line ${second}` }),
			h(
				"div",
				{ className: "feed-skeleton-footer" },
				h("div", { className: "feed-skeleton-chip w-36" }),
				h("div", { className: "feed-skeleton-chip w-56" }),
				h("div", { className: "feed-skeleton-chip" }),
			),
		),
	);
}
