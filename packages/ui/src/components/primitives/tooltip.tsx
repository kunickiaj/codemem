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
	/** ms before the tooltip opens (Radix default is 700). 400 is friendlier. */
	delayDuration?: number;
	/** Offset from the trigger edge in px. */
	sideOffset?: number;
	/** Render the trigger inline (span) rather than wrapping in a button. */
	asChild?: boolean;
	/** Disable the tooltip entirely — useful when the hint is already visible. */
	disabled?: boolean;
}

/**
 * Accessible hover / focus tooltip. Replaces native `title="..."` attributes
 * where the hint is load-bearing (stat tooltips, absolute timestamps, full
 * file paths). Keyboard users can trigger it by focusing the child; screen
 * readers announce it via aria-describedby.
 *
 * A single <TooltipProvider> should wrap the app root for delay coordination.
 */
export function Tooltip({
	children,
	label,
	side = "top",
	align = "center",
	delayDuration = 400,
	sideOffset = 6,
	asChild = true,
	disabled = false,
}: TooltipProps) {
	if (disabled) return <>{children}</>;
	return (
		<TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={300}>
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
		</TooltipPrimitive.Provider>
	);
}
