/* Feed render boundary helpers + the ProvenanceChip wrapper. */

import { type ComponentChildren, h, render } from "preact";
import { Chip } from "../../components/primitives/chip";
import { TooltipProvider } from "../../components/primitives/tooltip";

export function markFeedMount(mount: HTMLElement) {
	mount.dataset.feedRenderRoot = "preact";
}

export function ensureFeedRenderBoundary() {
	const feedTab = document.getElementById("tab-feed");
	if (!feedTab) return;
	feedTab.dataset.feedRenderBoundary = "preact-hybrid";
}

export function renderIntoFeedMount(mount: HTMLElement, content: ComponentChildren) {
	markFeedMount(mount);
	// Wrap every feed render in a TooltipProvider so adjacent feed-item
	// tooltips share skipDelayDuration and don't each pay the full open
	// delay when the user hovers from one card to the next.
	render(h(TooltipProvider, null, content), mount);
}

export function ProvenanceChip({ label, variant = "" }: { label: string; variant?: string }) {
	return h(Chip, { variant: "provenance", tone: variant || undefined }, label);
}
