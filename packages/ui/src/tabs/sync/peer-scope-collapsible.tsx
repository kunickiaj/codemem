import * as Collapsible from "@radix-ui/react-collapsible";
import type { ComponentChildren } from "preact";
import { createPortal } from "preact/compat";
import { useEffect, useLayoutEffect, useState } from "preact/hooks";
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

	useEffect(() => {
		setOpen(initialOpen);
	}, [initialOpen]);

	useLayoutEffect(() => {
		onOpenChange(open);
	}, [onOpenChange, open]);

	const content = (
		<Collapsible.Content
			forceMount
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
