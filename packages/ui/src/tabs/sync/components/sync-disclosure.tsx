import * as Collapsible from "@radix-ui/react-collapsible";
import type { ComponentChildren } from "preact";
import { createPortal } from "preact/compat";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { openSharingFrom } from "../../../lib/sharing-handoff";
import { renderIntoSyncMount } from "./render-root";

type SyncDisclosureProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	triggerId: string;
	triggerClassName: string;
	closedLabel: string;
	openLabel: string;
	contentId: string;
	contentClassName?: string;
	contentHost?: HTMLElement | null;
	children: ComponentChildren;
};

function SyncDisclosure({
	open,
	onOpenChange,
	triggerId,
	triggerClassName,
	closedLabel,
	openLabel,
	contentId,
	contentClassName,
	contentHost = null,
	children,
}: SyncDisclosureProps) {
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const contentRef = useRef<HTMLDivElement | null>(null);
	const openedRef = useRef(false);

	useLayoutEffect(() => {
		if (triggerRef.current) {
			triggerRef.current.id = triggerId;
			triggerRef.current.setAttribute("aria-controls", contentId);
		}
		if (contentRef.current) {
			contentRef.current.id = contentId;
		}
	}, [contentId, triggerId, open]);

	useEffect(() => {
		if (!open) {
			openedRef.current = false;
			return;
		}
		if (openedRef.current) return;
		openedRef.current = true;
		queueMicrotask(() => {
			const firstFocusable = contentRef.current?.querySelector<HTMLElement>(
				'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
			);
			firstFocusable?.focus();
		});
	}, [open]);

	const content = (
		<Collapsible.Content forceMount asChild>
			<div ref={contentRef} id={contentId} className={contentClassName} hidden={!open}>
				{children}
			</div>
		</Collapsible.Content>
	);

	return (
		<Collapsible.Root open={open} onOpenChange={onOpenChange}>
			<Collapsible.Trigger asChild>
				<button
					ref={triggerRef}
					type="button"
					className={triggerClassName}
					id={triggerId}
					aria-controls={contentId}
				>
					{open ? openLabel : closedLabel}
				</button>
			</Collapsible.Trigger>
			{contentHost ? createPortal(content, contentHost) : content}
		</Collapsible.Root>
	);
}

type TeamSetupDisclosureProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

function TeamSetupDisclosure({ open, onOpenChange }: TeamSetupDisclosureProps) {
	return (
		<SyncDisclosure
			open={open}
			onOpenChange={onOpenChange}
			triggerId="syncToggleAdmin"
			triggerClassName="sync-toggle-admin"
			closedLabel="Set up a new team instead…"
			openLabel="Hide team setup"
			contentId="syncInvitePanel"
		>
			<h3 className="settings-group-title" style={{ marginTop: "12px" }}>
				Create a team
			</h3>
			<div className="section-meta">
				Teams and invitations are created in Sharing. A Team invitation shares only the Projects you
				add to that Team.
			</div>
			<div className="actor-create-row">
				<button
					className="settings-button"
					id="syncCreateTeamInSharing"
					onClick={() => openSharingFrom("create_team")}
					type="button"
				>
					Create a Team in Sharing
				</button>
				<button
					className="settings-button"
					id="syncInviteInSharing"
					onClick={() => openSharingFrom("invite")}
					type="button"
				>
					Invite someone in Sharing
				</button>
			</div>
		</SyncDisclosure>
	);
}

type PairingDisclosureProps = {
	contentHost: HTMLElement | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

function PairingDisclosure({ contentHost, open, onOpenChange }: PairingDisclosureProps) {
	return (
		<SyncDisclosure
			open={open}
			onOpenChange={onOpenChange}
			triggerId="syncPairingToggle"
			triggerClassName="settings-button"
			closedLabel="Show pairing command"
			openLabel="Hide pairing command"
			contentId="syncPairing"
			contentClassName="pairing-card"
			contentHost={contentHost}
		>
			<div className="peer-title">
				<strong>Pairing command</strong>
				<div className="peer-actions">
					<button className="settings-button" id="pairingCopy" type="button">
						Copy command
					</button>
				</div>
			</div>
			<div className="pairing-body">
				<pre id="pairingPayload" style={{ userSelect: "all" }} />
			</div>
			<div className="peer-meta" id="pairingHint" />
		</SyncDisclosure>
	);
}

export function renderTeamSetupDisclosure(mount: HTMLElement, props: TeamSetupDisclosureProps) {
	renderIntoSyncMount(mount, <TeamSetupDisclosure {...props} />);
}

export function renderPairingDisclosure(mount: HTMLElement, props: PairingDisclosureProps) {
	renderIntoSyncMount(mount, <PairingDisclosure {...props} />);
}
