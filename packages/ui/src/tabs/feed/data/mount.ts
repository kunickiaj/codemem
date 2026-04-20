/* Feed render boundary helpers — mark the render root and wrap every
 * render in a single TooltipProvider so adjacent feed-item tooltips share
 * skipDelayDuration. */

import { type ComponentChildren, h, render } from "preact";
import { TooltipProvider } from "../../../components/primitives/tooltip";

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
	render(h(TooltipProvider, null, content), mount);
}
