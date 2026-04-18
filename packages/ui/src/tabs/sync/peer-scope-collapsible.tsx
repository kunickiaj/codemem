import * as Collapsible from "@radix-ui/react-collapsible";
import type { ComponentChildren } from "preact";
import { createPortal } from "preact/compat";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { renderIntoSyncMount } from "./components/render-root";

export type PeerScopeCollapsibleProps = {
	contentHost: HTMLElement | null;
	initialOpen: boolean;
	onOpenChange: (open: boolean) => void;
	children: ComponentChildren;
};

export function PeerScopeCollapsible({
	contentHost,
	initialOpen,
	onOpenChange,
	children,
}: PeerScopeCollapsibleProps) {
	const [open, setOpen] = useState(initialOpen);
	const contentRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		setOpen(initialOpen);
	}, [initialOpen]);

	useLayoutEffect(() => {
		onOpenChange(open);
	}, [onOpenChange, open]);

	useEffect(() => {
		if (!open) return;
		queueMicrotask(() => {
			const firstFocusable = contentRef.current?.querySelector<HTMLElement>(
				'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
			);
			firstFocusable?.focus();
		});
	}, [open]);

	const content = (
		<Collapsible.Content
			forceMount
			ref={contentRef}
			className={`peer-scope-editor-wrap${open ? "" : " collapsed"}`}
			hidden={!open}
			inert={!open}
		>
			<ScopeEditorContent>{children}</ScopeEditorContent>
		</Collapsible.Content>
	);

	return (
		<Collapsible.Root open={open} onOpenChange={setOpen}>
			<Collapsible.Trigger asChild>
				<button type="button" className="settings-button">
					{open ? "Hide sharing scope" : "Show sharing scope"}
				</button>
			</Collapsible.Trigger>
			{contentHost ? createPortal(content, contentHost) : null}
		</Collapsible.Root>
	);
}

function ScopeEditorContent({ children }: { children: ComponentChildren }) {
	return <div>{children}</div>;
}

export function renderPeerScopeCollapsible(mount: HTMLElement, props: PeerScopeCollapsibleProps) {
	renderIntoSyncMount(mount, <PeerScopeCollapsible {...props} />);
}
