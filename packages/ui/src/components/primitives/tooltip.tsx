import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ComponentChildren } from "preact";

export type TooltipSide = "top" | "right" | "bottom" | "left";
export type TooltipAlign = "start" | "center" | "end";

interface TooltipProps {
	/** The element that triggers the tooltip on hover / focus. */
	children?: ComponentChildren;
	/** Tooltip content. Plain strings get wrapped; pass JSX for richer content. */
	label: ComponentChildren;
	side?: TooltipSide;
	align?: TooltipAlign;
	/** Offset from the trigger edge in px. */
	sideOffset?: number;
	/** Render the trigger inline (span) rather than wrapping in a button. */
	asChild?: boolean;
	/** Disable the tooltip entirely — useful when the hint is already visible. */
	disabled?: boolean;
}

interface TooltipProviderProps {
	children?: ComponentChildren;
	/** ms before the first tooltip in the subtree opens. */
	delayDuration?: number;
	/** ms within which an already-opened tooltip's neighbor opens without delay. */
	skipDelayDuration?: number;
}

/**
 * Wrap a render subtree so every <Tooltip> inside shares a single delay
 * context. Without this wrapper, moving from one trigger to an adjacent
 * trigger pays the full open delay both times; with it, the second trigger
 * opens immediately within `skipDelayDuration`.
 *
 * Mount one Provider per imperative render root (feed list, stat grid,
 * sync peers, etc.) since the viewer renders into multiple separate trees.
 */
export function TooltipProvider({
	children,
	delayDuration = 400,
	skipDelayDuration = 300,
}: TooltipProviderProps) {
	return (
		<TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={skipDelayDuration}>
			{children}
		</TooltipPrimitive.Provider>
	);
}

/**
 * Accessible hover / focus tooltip. Replaces native `title="..."` attributes
 * where the hint is load-bearing (stat tooltips, absolute timestamps, full
 * file paths). Keyboard users can trigger it by focusing the child; screen
 * readers announce it via aria-describedby.
 *
 * Requires an enclosing <TooltipProvider> in the same render tree so
 * adjacent tooltips can share `skipDelayDuration` for quick handoff.
 */
export function Tooltip({
	children,
	label,
	side = "top",
	align = "center",
	sideOffset = 6,
	asChild = true,
	disabled = false,
}: TooltipProps) {
	if (disabled) return <>{children}</>;
	return (
		<TooltipPrimitive.Root>
			<TooltipPrimitive.Trigger asChild={asChild}>{children}</TooltipPrimitive.Trigger>
			<TooltipPrimitive.Portal>
				<TooltipPrimitive.Content
					align={align}
					className="tooltip-content"
					side={side}
					sideOffset={sideOffset}
				>
					{label}
					<TooltipPrimitive.Arrow className="tooltip-arrow" />
				</TooltipPrimitive.Content>
			</TooltipPrimitive.Portal>
		</TooltipPrimitive.Root>
	);
}
