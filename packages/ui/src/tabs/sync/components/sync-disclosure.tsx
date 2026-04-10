import * as Collapsible from "@radix-ui/react-collapsible";
import type { ComponentChildren } from "preact";
import { createPortal } from "preact/compat";
import { useLayoutEffect, useRef } from "preact/hooks";
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

	useLayoutEffect(() => {
		if (triggerRef.current) {
			triggerRef.current.id = triggerId;
			triggerRef.current.setAttribute("aria-controls", contentId);
		}
		if (contentRef.current) {
			contentRef.current.id = contentId;
		}
	}, [contentId, triggerId, open]);

	const content = (
		<Collapsible.Content asChild>
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
			<div className="section-meta">Generate an invite to share with teammates.</div>
			<div className="actor-create-row">
				<label htmlFor="syncInviteGroup" className="sr-only">
					Team name
				</label>
				<input
					className="peer-scope-input"
					id="syncInviteGroup"
					placeholder="Team name (e.g. my-team)"
				/>
				<label htmlFor="syncInvitePolicy" className="sr-only">
					Join policy
				</label>
				<div className="sync-radix-select-host sync-actor-select-host" id="syncInvitePolicyMount" />
				<div className="sync-ttl-group">
					<label htmlFor="syncInviteTtl">Expires in</label>
					<input
						className="peer-scope-input"
						defaultValue="24"
						id="syncInviteTtl"
						min="1"
						style={{ width: "64px" }}
						type="number"
					/>
					<span>hours</span>
				</div>
				<button className="settings-button" id="syncCreateInviteButton" type="button">
					Create invite
				</button>
			</div>
			<label htmlFor="syncInviteOutput" className="sr-only">
				Generated invite
			</label>
			<textarea
				className="feed-search"
				id="syncInviteOutput"
				placeholder="Invite will appear here"
				readOnly
				hidden
			/>
			<div className="peer-meta" id="syncInviteWarnings" hidden />
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
			closedLabel="Show pairing"
			openLabel="Hide pairing"
			contentId="syncPairing"
			contentClassName="pairing-card"
			contentHost={contentHost}
		>
			<div className="peer-title">
				<strong>Pairing command</strong>
				<div className="peer-actions">
					<button id="pairingCopy" type="button">
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
