/* Help-tooltip hook — wires global pointer/focus/click listeners to
 * surface `.help-icon[data-tooltip]` messages, positions the tooltip
 * element on open/resize/scroll, and portals it out to document.body. */

import type { ComponentChildren } from "preact";
import { createPortal } from "preact/compat";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { helpButtonFromTarget, positionHelpTooltipElement } from "../data/dom";
import type { SettingsTooltipState } from "../data/types";

export interface UseHelpTooltipResult {
	tooltipPortal: ComponentChildren;
	setTooltip: (
		value: SettingsTooltipState | ((current: SettingsTooltipState) => SettingsTooltipState),
	) => void;
}

export function useHelpTooltip(): UseHelpTooltipResult {
	const [tooltip, setTooltip] = useState<SettingsTooltipState>({
		anchor: null,
		content: "",
		visible: false,
	});
	const tooltipRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const showTooltip = (anchor: HTMLElement) => {
			const content = anchor.dataset.tooltip?.trim();
			if (!content) return;
			setTooltip({ anchor, content, visible: true });
		};

		const hideTooltip = () => {
			setTooltip((current) => {
				if (!current.visible && !current.anchor && !current.content) return current;
				return { anchor: null, content: "", visible: false };
			});
		};

		const onPointerOver = (event: Event) => {
			const button = helpButtonFromTarget(event.target);
			if (!button) return;
			showTooltip(button);
		};

		const onPointerOut = (event: Event) => {
			const button = helpButtonFromTarget(event.target);
			if (!button) return;
			const related = (event as PointerEvent).relatedTarget;
			if (related instanceof Element && button.contains(related)) return;
			hideTooltip();
		};

		const onFocusIn = (event: Event) => {
			const button = helpButtonFromTarget(event.target);
			if (!button) return;
			showTooltip(button);
		};

		const onFocusOut = (event: Event) => {
			const button = helpButtonFromTarget(event.target);
			if (!button) return;
			hideTooltip();
		};

		const onClick = (event: Event) => {
			const button = helpButtonFromTarget(event.target);
			if (!button) return;
			event.preventDefault();
			setTooltip((current) => {
				if (current.anchor === button && current.visible) {
					return { anchor: null, content: "", visible: false };
				}
				const content = button.dataset.tooltip?.trim() || "";
				if (!content) return current;
				return { anchor: button, content, visible: true };
			});
		};

		document.addEventListener("pointerover", onPointerOver);
		document.addEventListener("pointerout", onPointerOut);
		document.addEventListener("focusin", onFocusIn);
		document.addEventListener("focusout", onFocusOut);
		document.addEventListener("click", onClick);

		return () => {
			document.removeEventListener("pointerover", onPointerOver);
			document.removeEventListener("pointerout", onPointerOut);
			document.removeEventListener("focusin", onFocusIn);
			document.removeEventListener("focusout", onFocusOut);
			document.removeEventListener("click", onClick);
		};
	}, []);

	useLayoutEffect(() => {
		if (!tooltip.visible || !tooltip.anchor || !tooltipRef.current) return;
		const frame = requestAnimationFrame(() => {
			if (tooltipRef.current && tooltip.anchor) {
				positionHelpTooltipElement(tooltipRef.current, tooltip.anchor);
			}
		});
		return () => {
			cancelAnimationFrame(frame);
		};
	}, [tooltip.anchor, tooltip.content, tooltip.visible]);

	useEffect(() => {
		if (!tooltip.visible || !tooltip.anchor) return;
		const reposition = () => {
			if (tooltipRef.current && tooltip.anchor) {
				positionHelpTooltipElement(tooltipRef.current, tooltip.anchor);
			}
		};
		globalThis.addEventListener("resize", reposition);
		document.addEventListener("scroll", reposition, true);
		return () => {
			globalThis.removeEventListener("resize", reposition);
			document.removeEventListener("scroll", reposition, true);
		};
	}, [tooltip.anchor, tooltip.visible]);

	const tooltipPortal = useMemo(() => {
		if (typeof document === "undefined") return null;
		return createPortal(
			<div
				className={`help-tooltip${tooltip.visible ? " visible" : ""}`}
				hidden={!tooltip.visible}
				ref={tooltipRef}
			>
				{tooltip.content}
			</div>,
			document.body,
		);
	}, [tooltip.content, tooltip.visible]);

	return { tooltipPortal, setTooltip };
}
