import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

function MenuSurface({
	children,
	label,
}: {
	children: (close: () => void) => ComponentChildren;
	label: string;
}) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const closeForOutsideInteraction = (event: Event) => {
			if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
		};
		const closeForEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", closeForOutsideInteraction);
		document.addEventListener("keydown", closeForEscape);
		return () => {
			document.removeEventListener("pointerdown", closeForOutsideInteraction);
			document.removeEventListener("keydown", closeForEscape);
		};
	}, [open]);
	return (
		<div className="project-row-menu" ref={rootRef}>
			<button
				aria-expanded={open}
				aria-haspopup="menu"
				aria-label={label}
				className="feed-menu-trigger"
				data-state={open ? "open" : "closed"}
				onClick={() => setOpen((value) => !value)}
				type="button"
			>
				⋯
			</button>
			{open ? (
				<div className="feed-menu-panel project-row-menu-panel" role="menu">
					{children(() => setOpen(false))}
				</div>
			) : null}
		</div>
	);
}

function MenuItem({
	children,
	danger = false,
	disabled = false,
	onSelect,
}: {
	children: ComponentChildren;
	danger?: boolean;
	disabled?: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			className={`feed-menu-item${danger ? " danger" : ""}`}
			disabled={disabled}
			onClick={onSelect}
			role="menuitem"
			type="button"
		>
			{children}
		</button>
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
	const run = (close: () => void, action: () => void) => {
		close();
		action();
	};
	return (
		<MenuSurface label={`More actions for ${props.label}`}>
			{(close) => (
				<>
					<MenuItem
						disabled={!props.canAssign}
						onSelect={() => run(close, props.onOpenSpaceAssignment)}
					>
						Space assignment…
					</MenuItem>
					<MenuItem
						disabled={!props.canChangeProject}
						onSelect={() => run(close, props.onChangeProject)}
					>
						Change project…
					</MenuItem>
					<MenuItem disabled={!props.canAssign} onSelect={() => run(close, props.onKeepLocal)}>
						Keep local-only
					</MenuItem>
					{props.canRemoveMapping ? (
						<MenuItem onSelect={() => run(close, props.onRemoveMapping)}>Remove mapping</MenuItem>
					) : null}
					<MenuItem danger disabled={!props.canForget} onSelect={() => run(close, props.onForget)}>
						Forget local memories…
					</MenuItem>
				</>
			)}
		</MenuSurface>
	);
}

export function ProjectClusterMenu({
	label,
	onOpenSpaceAssignment,
}: {
	label: string;
	onOpenSpaceAssignment: () => void;
}) {
	return (
		<MenuSurface label={`More actions for ${label}`}>
			{(close) => (
				<MenuItem
					onSelect={() => {
						close();
						onOpenSpaceAssignment();
					}}
				>
					Space assignment for all…
				</MenuItem>
			)}
		</MenuSurface>
	);
}
