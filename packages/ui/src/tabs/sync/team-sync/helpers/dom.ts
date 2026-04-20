/* DOM utilities shared by the team sync card — reduced-motion aware
 * scroll behavior and the pulse-attention animation used to highlight
 * the destination of an attention item's action. */

export function clearContent(node: HTMLElement | null) {
	if (node) node.textContent = "";
}

export function pulseAttentionTarget(target: HTMLElement | null) {
	if (!(target instanceof HTMLElement)) return;
	target.classList.remove("sync-attention-target");
	void target.offsetWidth;
	target.classList.add("sync-attention-target");
	window.setTimeout(() => target.classList.remove("sync-attention-target"), 900);
}

export function prefersReducedMotion(): boolean {
	return (
		typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

export function syncScrollBehavior(): ScrollBehavior {
	return prefersReducedMotion() ? "auto" : "smooth";
}
