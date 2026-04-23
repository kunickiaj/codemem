/* RadixDialog shell for the sync dialog queue. Subscribes its
 * setState into the shared host-request setter so setRequest() in
 * internal.ts can rerender us. Only renders when there is an
 * in-flight request. Open auto-focus prefers a primary action
 * selector over the browser default so "Enter" resolves the common
 * case. */

import { useEffect, useMemo, useState } from "preact/hooks";
import { RadixDialog } from "../../../../components/primitives/radix-dialog";
import {
	getCurrentRequest,
	isHostRequestSetter,
	resolveCurrentDialog,
	setHostRequestSetter,
} from "../internal";
import type { SyncDialogRequest } from "../types";
import { SyncDialogBody } from "./sync-dialog-body";

export function SyncDialogHost() {
	const [request, setDialogState] = useState<SyncDialogRequest | null>(getCurrentRequest());

	useEffect(() => {
		setHostRequestSetter(setDialogState);
		return () => {
			if (isHostRequestSetter(setDialogState)) setHostRequestSetter(null);
		};
	}, []);

	const open = Boolean(request);
	const titleId = useMemo(() => `sync-dialog-title-${request?.kind || "none"}`, [request?.kind]);
	const descriptionId = useMemo(
		() => `sync-dialog-description-${request?.kind || "none"}`,
		[request?.kind],
	);

	if (!request) return null;

	const handleOpenChange = (nextOpen: boolean) => {
		if (nextOpen) return;
		resolveCurrentDialog(request?.kind === "confirm" ? false : null);
	};

	const handleInteractOutside = (event: Event & { detail?: { originalEvent?: Event } }) => {
		// The autocomplete suggestion list renders inside its own Radix Popover
		// portal, so Radix treats clicks on options as "outside the dialog" and
		// closes the modal. Block that when the click target is inside an
		// autocomplete popover so picking a suggestion actually fills the input.
		const originalTarget = (event.detail?.originalEvent as { target?: unknown } | undefined)
			?.target;
		if (originalTarget instanceof Element && originalTarget.closest(".autocomplete-popover")) {
			event.preventDefault();
		}
	};

	const handleOpenAutoFocus = (event: Event) => {
		const legacyPrimary = document.querySelector<HTMLElement>(
			'#syncDialog [data-sync-primary-action="true"]',
		);
		if (request?.kind === "input" && legacyPrimary) {
			event.preventDefault();
			legacyPrimary.focus();
			return;
		}
		const preferredAction =
			request?.kind === "confirm" ? (request.autoFocusAction ?? "confirm") : "confirm";
		const selector =
			preferredAction === "cancel"
				? '#syncDialog [data-sync-dialog-action="cancel"]'
				: '#syncDialog [data-sync-dialog-action="confirm"]';
		const primary = document.querySelector<HTMLElement>(selector);
		if (!primary) return;
		event.preventDefault();
		primary.focus();
	};

	const body = request ? (
		<SyncDialogBody descriptionId={descriptionId} request={request} titleId={titleId} />
	) : null;

	return (
		<RadixDialog
			ariaDescribedby={descriptionId}
			ariaLabelledby={titleId}
			contentClassName="modal"
			contentId="syncDialog"
			onInteractOutside={handleInteractOutside}
			onOpenAutoFocus={handleOpenAutoFocus}
			onOpenChange={handleOpenChange}
			open={open}
			overlayClassName="modal-backdrop"
			overlayId="syncDialogBackdrop"
		>
			{body}
		</RadixDialog>
	);
}
