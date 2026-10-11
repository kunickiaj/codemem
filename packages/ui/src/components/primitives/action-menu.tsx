import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { h } from "preact";
import { useRef, useState } from "preact/hooks";

export interface MenuAction {
	ariaControls?: string;
	ariaExpanded?: boolean;
	ariaLabel?: string;
	danger?: boolean;
	disabled?: boolean;
	focusAfterClose?: () => void;
	label: string;
	onSelect: () => void;
	ref?: (element: HTMLButtonElement | null) => void;
	title?: string;
}

interface ActionMenuProps {
	actions: MenuAction[];
	label: string;
	triggerId?: string;
	triggerRef?: (element: HTMLButtonElement | null) => void;
}

function ActionMenuItem({
	action,
	onSelect,
}: {
	action: MenuAction;
	onSelect: (action: MenuAction) => void;
}) {
	return h(
		DropdownMenu.Item,
		{ asChild: true, disabled: action.disabled, onSelect: () => onSelect(action) },
		h(
			"button",
			{
				"aria-controls": action.ariaControls,
				"aria-expanded": action.ariaExpanded,
				"aria-label": action.ariaLabel,
				className: `feed-menu-item${action.danger ? " danger" : ""}`,
				disabled: action.disabled,
				ref: action.ref,
				title: action.title,
				type: "button",
			},
			action.label,
		),
	);
}

function isTabTarget(element: HTMLElement): boolean {
	if (
		element.closest('[hidden], [inert], [role="menu"]') ||
		element.matches(':disabled, [tabindex="-1"], [data-radix-focus-guard]')
	)
		return false;
	let ancestor: HTMLElement | null = element;
	while (ancestor) {
		const style = getComputedStyle(ancestor);
		if (style.display === "none" || style.visibility === "hidden") return false;
		if (
			ancestor instanceof HTMLDetailsElement &&
			!ancestor.open &&
			!ancestor.querySelector("summary")?.contains(element)
		)
			return false;
		ancestor = ancestor.parentElement;
	}
	return true;
}

function useEntryItemFocus(openMenu: () => void) {
	const content = useRef<HTMLDivElement>(null);
	const requested = useRef<"first" | "last" | null>(null);
	const onTriggerKeyDown = (event: KeyboardEvent) => {
		if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
		event.preventDefault();
		requested.current = event.key === "ArrowUp" ? "last" : "first";
		openMenu();
	};
	const onContentFocus = () => {
		if (!requested.current) return;
		const entry = requested.current;
		requested.current = null;
		queueMicrotask(() => {
			const items = content.current?.querySelectorAll<HTMLElement>(
				'[role="menuitem"]:not([data-disabled])',
			);
			const item = entry === "last" ? items?.[items.length - 1] : items?.[0];
			(item ?? content.current)?.focus();
		});
	};
	return { content, onTriggerKeyDown, onContentFocus };
}

function useActionMenu() {
	const [open, setOpen] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);
	const tabDestination = useRef<HTMLElement | null>(null);
	const selectedFocus = useRef<(() => void) | undefined>();
	const onSelect = (action: MenuAction) => {
		action.onSelect();
		selectedFocus.current = action.focusAfterClose;
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key !== "Tab") return;
		event.preventDefault();
		// The portal is outside the row: resume tab order from its trigger, not the portal.
		const targets = [
			...document.querySelectorAll<HTMLElement>(
				'a[href], area[href], button, input, select, textarea, summary, iframe, [contenteditable=""], [contenteditable="true"], [tabindex]:not([tabindex^="-"])',
			),
		].filter(isTabTarget);
		const index = targets.indexOf(trigger.current as HTMLButtonElement);
		tabDestination.current = targets[index + (event.shiftKey ? -1 : 1)] ?? trigger.current;
		setOpen(false);
	};
	const onCloseAutoFocus = (event: Event) => {
		if (selectedFocus.current) {
			const focusAfterClose = selectedFocus.current;
			selectedFocus.current = undefined;
			queueMicrotask(focusAfterClose);
		}
		if (tabDestination.current) {
			event.preventDefault();
			tabDestination.current.focus();
			tabDestination.current = null;
			return;
		}
		const active = document.activeElement;
		if (
			active instanceof HTMLElement &&
			active !== document.body &&
			active !== trigger.current &&
			!active.closest('[role="menu"]')
		) {
			// Keep focus when an action has already moved it into a form or dialog.
			event.preventDefault();
		}
	};
	return { open, setOpen, trigger, onSelect, onKeyDown, onCloseAutoFocus };
}

export function ActionMenu({ actions, label, triggerId, triggerRef }: ActionMenuProps) {
	const { open, setOpen, trigger, onSelect, onKeyDown, onCloseAutoFocus } = useActionMenu();
	const { content, onTriggerKeyDown, onContentFocus } = useEntryItemFocus(() => setOpen(true));
	return h(
		DropdownMenu.Root,
		{ open, onOpenChange: setOpen },
		h(
			DropdownMenu.Trigger,
			{ asChild: true },
			h(
				"button",
				{
					"aria-label": label,
					className: "feed-menu-trigger",
					id: triggerId,
					onKeyDown: onTriggerKeyDown,
					ref: (element: HTMLButtonElement | null) => {
						trigger.current = element;
						triggerRef?.(element);
					},
					type: "button",
				},
				"⋯",
			),
		),
		h(
			DropdownMenu.Portal,
			null,
			h(
				DropdownMenu.Content,
				{
					align: "end",
					"aria-label": label,
					"aria-labelledby": triggerId,
					className: "feed-menu-panel",
					loop: true,
					onKeyDown,
					onCloseAutoFocus,
					onFocus: onContentFocus,
					ref: content,
					side: "bottom",
					sideOffset: 4,
				},
				...actions.map((action) => h(ActionMenuItem, { action, key: action.label, onSelect })),
			),
		),
	);
}
