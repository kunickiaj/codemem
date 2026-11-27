import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { LegacySharedReviewReassignmentPreview } from "../lib/api/sync";
import {
	type SyncLegacySharedReviewGroup,
	type SyncLegacySharedReviewItem,
	SyncSharingReview,
} from "../tabs/sync/components/sync-sharing-review";
import { RadixDialog, type RadixDialogProps, RadixDialogTitle } from "./primitives/radix-dialog";

export type LegacyUpgradeReviewSummary = {
	groupCount: number;
	memoryCount: number;
};

export type LegacyUpgradeDialogActions = {
	onDismiss: () => void;
	onReviewProjects: () => void;
	/** The groups still waiting for review, or null when nothing is left. */
	readReview: () => SyncLegacySharedReviewItem | null;
	/** Previews or applies one group's move. Returns the preview to confirm, or null once it is applied. */
	onReassign: (
		group: SyncLegacySharedReviewGroup,
		scopeId: string,
		confirmedOldCopies: boolean,
		confirmationToken?: string,
	) => Promise<LegacySharedReviewReassignmentPreview | null>;
};

let showDialog: ((summary: LegacyUpgradeReviewSummary) => void) | null = null;
let hideDialog: (() => void) | null = null;

function focusLegacyUpgradePrimary(
	event: Parameters<NonNullable<RadixDialogProps["onOpenAutoFocus"]>>[0],
	returnFocus: { current: HTMLElement | null },
): void {
	returnFocus.current =
		document.activeElement instanceof HTMLElement ? document.activeElement : null;
	const primary = document.getElementById("legacyUpgradeReviewGroups");
	if (!primary) return;
	event.preventDefault();
	primary.focus();
}

function restoreLegacyUpgradeFocus(
	event: Parameters<NonNullable<RadixDialogProps["onCloseAutoFocus"]>>[0],
	returnFocus: { current: HTMLElement | null },
): void {
	event.preventDefault();
	if (returnFocus.current?.isConnected) returnFocus.current.focus();
	returnFocus.current = null;
}

type Stage = "summary" | "review";

function LegacyUpgradeSummaryBody({ summary }: { summary: LegacyUpgradeReviewSummary }) {
	const projectLabel = summary.groupCount === 1 ? "project needs" : "projects need";
	return (
		<>
			<div className="small" id="legacyUpgradeDescription">
				Some memories were shared before codemem had clear Sharing domains. We kept them out of
				normal sync until you choose which project/domain they belong to.
			</div>
			<div className="legacy-upgrade-summary" id="legacyUpgradeSummary">
				{`${summary.groupCount.toLocaleString()} older ${projectLabel} a Sharing domain. They contain ${summary.memoryCount.toLocaleString()} older shared memories total; you will review the projects, not individual memories.`}
			</div>
			<div className="small">
				You’ll review projects, not individual memories. Nothing moves automatically, and this will
				not erase copies another device may already have received.
			</div>
			<label className="field-checkbox" htmlFor="legacyUpgradeDontShow">
				<input className="cm-checkbox" id="legacyUpgradeDontShow" type="checkbox" />
				<span>Don’t show this again</span>
			</label>
		</>
	);
}

/** The group review, shown in the dialog so nobody has to open Advanced to finish it. */
function LegacyUpgradeReviewBody({
	actions,
	onClose,
}: {
	actions: LegacyUpgradeDialogActions;
	onClose: () => void;
}) {
	const [review, setReview] = useState(actions.readReview);
	const region = useRef<HTMLElement>(null);
	useEffect(() => region.current?.focus(), []);
	const reassign: LegacyUpgradeDialogActions["onReassign"] = async (...args) => {
		try {
			return await actions.onReassign(...args);
		} finally {
			// A move that was applied changes which groups are left, even when a later step fails.
			setReview(actions.readReview());
		}
	};
	return (
		<section
			aria-labelledby="legacyUpgradeTitle"
			id="legacyUpgradeReview"
			ref={region}
			tabIndex={-1}
		>
			{review ? (
				<SyncSharingReview
					items={[]}
					legacyReview={review}
					onLegacyReassign={reassign}
					onLegacyReview={() => {
						onClose();
						actions.onReviewProjects();
					}}
					onReview={onClose}
				/>
			) : (
				<div className="small" id="legacyUpgradeDescription">
					No older shared memories are waiting for review.
				</div>
			)}
		</section>
	);
}

function LegacyUpgradeFooter({
	actions,
	onClose,
	onStartReview,
	reviewing,
}: {
	actions: LegacyUpgradeDialogActions;
	onClose: () => void;
	onStartReview: () => void;
	reviewing: boolean;
}) {
	return (
		<div className="modal-footer">
			<div className="legacy-upgrade-actions">
				{reviewing ? (
					<button className="settings-save" id="legacyUpgradeClose" onClick={onClose} type="button">
						Close
					</button>
				) : (
					<>
						<button
							className="settings-button"
							id="legacyUpgradeReviewProjects"
							onClick={() => {
								onClose();
								actions.onReviewProjects();
							}}
							type="button"
						>
							Manage all projects
						</button>
						<button
							className="settings-button"
							id="legacyUpgradeNotNow"
							onClick={onClose}
							type="button"
						>
							Not now
						</button>
						<button
							className="settings-save"
							id="legacyUpgradeReviewGroups"
							onClick={onStartReview}
							type="button"
						>
							Start review
						</button>
					</>
				)}
			</div>
		</div>
	);
}

function LegacyUpgradeDialog({ actions }: { actions: LegacyUpgradeDialogActions }) {
	const [summary, setSummary] = useState<LegacyUpgradeReviewSummary | null>(null);
	const [stage, setStage] = useState<Stage>("summary");
	const returnFocus = useRef<HTMLElement | null>(null);
	showDialog = (next) => {
		setStage("summary");
		setSummary(next);
	};
	hideDialog = () => setSummary(null);

	const close = () => {
		actions.onDismiss();
		setSummary(null);
	};
	const reviewing = stage === "review";

	return (
		<RadixDialog
			ariaDescribedby={reviewing ? undefined : "legacyUpgradeDescription legacyUpgradeSummary"}
			ariaLabelledby="legacyUpgradeTitle"
			contentClassName={
				reviewing
					? "modal legacy-upgrade-modal legacy-upgrade-modal--review"
					: "modal legacy-upgrade-modal"
			}
			contentId="legacyUpgradeModal"
			onCloseAutoFocus={(event) => restoreLegacyUpgradeFocus(event, returnFocus)}
			onInteractOutside={(event) => event.preventDefault()}
			onOpenAutoFocus={(event) => focusLegacyUpgradePrimary(event, returnFocus)}
			onOpenChange={(open) => {
				if (!open) close();
			}}
			open={summary != null}
			overlayClassName="modal-backdrop"
			overlayId="legacyUpgradeModalBackdrop"
		>
			<div className="modal-card">
				<div className="modal-header">
					<RadixDialogTitle id="legacyUpgradeTitle">
						{reviewing
							? "Review older shared memories"
							: "Choose where older shared memories belong"}
					</RadixDialogTitle>
				</div>
				<div className="modal-body">
					{summary && !reviewing ? <LegacyUpgradeSummaryBody summary={summary} /> : null}
					{summary && reviewing ? (
						<LegacyUpgradeReviewBody actions={actions} onClose={close} />
					) : null}
				</div>
				<LegacyUpgradeFooter
					actions={actions}
					onClose={close}
					onStartReview={() => {
						// The checkbox leaves the page with the summary, so save its choice first.
						actions.onDismiss();
						setStage("review");
					}}
					reviewing={reviewing}
				/>
			</div>
		</RadixDialog>
	);
}

export function mountLegacyUpgradeDialog(
	mount: HTMLElement,
	actions: LegacyUpgradeDialogActions,
): void {
	render(<LegacyUpgradeDialog actions={actions} />, mount);
}

export function showLegacyUpgradeDialog(summary: LegacyUpgradeReviewSummary): void {
	showDialog?.(summary);
}

export function hideLegacyUpgradeDialog(): void {
	hideDialog?.();
}
