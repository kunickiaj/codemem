import { useEffect, useId, useRef, useState } from "preact/hooks";

interface MenuAction {
	danger?: boolean;
	disabled?: boolean;
	label: string;
	onSelect: () => void;
}

function nextMenuIndex(key: string, current: number, enabled: number[]): number | null {
	if (enabled.length === 0) return null;
	if (key === "Home") return enabled[0] ?? null;
	if (key === "End") return enabled.at(-1) ?? null;
	const position = Math.max(0, enabled.indexOf(current));
	if (key === "ArrowDown") return enabled[(position + 1) % enabled.length] ?? null;
	if (key === "ArrowUp") return enabled[(position - 1 + enabled.length) % enabled.length] ?? null;
	return null;
}

interface MenuItemsProps {
	actions: MenuAction[];
	close: () => void;
	dismiss: () => void;
	enabled: number[];
	itemRefs: { current: Array<HTMLButtonElement | null> };
	label: string;
	menuId: string;
}

function MenuItems({ actions, close, dismiss, enabled, itemRefs, label, menuId }: MenuItemsProps) {
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Tab") {
			dismiss();
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			close();
			return;
		}
		const current = itemRefs.current.indexOf(document.activeElement as HTMLButtonElement);
		const index = nextMenuIndex(event.key, current, enabled);
		if (index == null) return;
		event.preventDefault();
		itemRefs.current[index]?.focus();
	};
	return (
		<div
			aria-label={label}
			className="feed-menu-panel project-row-menu-panel"
			id={menuId}
			onKeyDown={onKeyDown}
			role="menu"
		>
			{actions.map((action, index) => (
				<button
					className={`feed-menu-item${action.danger ? " danger" : ""}`}
					disabled={action.disabled}
					key={action.label}
					onClick={() => {
						close();
						action.onSelect();
					}}
					ref={(element) => {
						itemRefs.current[index] = element;
					}}
					role="menuitem"
					tabIndex={-1}
					type="button"
				>
					{action.label}
				</button>
			))}
		</div>
	);
}

function MenuSurface({ actions, label }: { actions: MenuAction[]; label: string }) {
	const [open, setOpen] = useState(false);
	const initialFocus = useRef<"first" | "last">("first");
	const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
	const menuId = useId();
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const enabled = actions.flatMap((action, index) => (action.disabled ? [] : [index]));
	const close = () => {
		setOpen(false);
		queueMicrotask(() => triggerRef.current?.focus());
	};
	const dismiss = () => setOpen(false);
	useEffect(() => {
		if (!open) return;
		const index = initialFocus.current === "last" ? enabled.at(-1) : enabled[0];
		queueMicrotask(() => (index == null ? triggerRef.current : itemRefs.current[index])?.focus());
		const outside = (event: PointerEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("pointerdown", outside);
		return () => document.removeEventListener("pointerdown", outside);
	}, [enabled, open]);
	const openFromKeyboard = (event: KeyboardEvent) => {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		event.preventDefault();
		initialFocus.current = event.key === "ArrowUp" ? "last" : "first";
		setOpen(true);
	};
	return (
		<div className="project-row-menu" ref={rootRef}>
			<button
				aria-controls={menuId}
				aria-expanded={open}
				aria-haspopup="menu"
				aria-label={label}
				className="feed-menu-trigger"
				data-state={open ? "open" : "closed"}
				onClick={() => {
					initialFocus.current = "first";
					setOpen((value) => !value);
				}}
				onKeyDown={openFromKeyboard}
				ref={triggerRef}
				type="button"
			>
				⋯
			</button>
			{open ? (
				<MenuItems
					actions={actions}
					close={close}
					dismiss={dismiss}
					enabled={enabled}
					itemRefs={itemRefs}
					label={label}
					menuId={menuId}
				/>
			) : null}
		</div>
	);
}

interface ProjectRowMenuProps {
	label: string;
	canAssign: boolean;
	canChangeProject: boolean;
	canForget: boolean;
	canRemoveMapping: boolean;
	onChangeProject: () => void;
	onForget: () => void;
	onKeepLocal: () => void;
	onOpenSpaceAssignment: () => void;
	onRemoveMapping: () => void;
}

export function ProjectRowMenu(props: ProjectRowMenuProps) {
	const actions: MenuAction[] = [
		{
			disabled: !props.canAssign,
			label: "Space assignment…",
			onSelect: props.onOpenSpaceAssignment,
		},
		{
			disabled: !props.canChangeProject,
			label: "Change project…",
			onSelect: props.onChangeProject,
		},
		{ disabled: !props.canAssign, label: "Keep local-only", onSelect: props.onKeepLocal },
		...(props.canRemoveMapping
			? [{ label: "Remove mapping", onSelect: props.onRemoveMapping }]
			: []),
		{
			danger: true,
			disabled: !props.canForget,
			label: "Forget local memories…",
			onSelect: props.onForget,
		},
	];
	return <MenuSurface actions={actions} label={`More actions for ${props.label}`} />;
}

export function ProjectClusterMenu({
	label,
	onOpenSpaceAssignment,
}: {
	label: string;
	onOpenSpaceAssignment: () => void;
}) {
	return (
		<MenuSurface
			actions={[{ label: "Space assignment for all…", onSelect: onOpenSpaceAssignment }]}
			label={`More actions for ${label}`}
		/>
	);
}
