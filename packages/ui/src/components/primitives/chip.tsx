import type { ComponentChildren } from "preact";

export type ChipVariant = "kind" | "provenance" | "tag" | "badge" | "scope";

interface ChipProps {
	variant: ChipVariant;
	/**
	 * Tone sub-class appended to the base variant (e.g. `feature` / `mine` /
	 * `online`). Optional — provenance/kind chips default to their neutral
	 * styling when absent.
	 */
	tone?: string;
	title?: string;
	children?: ComponentChildren;
}

const VARIANT_CLASS: Record<ChipVariant, string> = {
	kind: "kind-chip",
	provenance: "provenance-chip",
	tag: "tag-chip",
	badge: "badge",
	scope: "peer-scope-chip",
};

/**
 * Canonical pill-shaped label. Renders `<span>` with the existing variant
 * class (`kind-chip`, `provenance-chip`, `tag-chip`, `badge`, `peer-scope-chip`)
 * — CSS is owned by the viewer stylesheet so output is identical to
 * hand-written spans. One component so future chips don't each grow their
 * own className concatenation.
 */
export function Chip({ variant, tone, title, children }: ChipProps) {
	const base = VARIANT_CLASS[variant];
	const className = tone ? `${base} ${tone}` : base;
	return (
		<span className={className} title={title}>
			{children}
		</span>
	);
}
