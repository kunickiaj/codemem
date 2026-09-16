import { render } from "preact";
import { useRef, useState } from "preact/hooks";
import { RadixDialog, type RadixDialogProps, RadixDialogTitle } from "./primitives/radix-dialog";

export type LegacyUpgradeReviewSummary = {
	groupCount: number;
	memoryCount: number;
};

export type LegacyUpgradeDialogActions = {
	onDismiss: () => void;
	onReviewGroups: () => void;
	onReviewProjects: () => void;
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

function LegacyUpgradeDialog({ actions }: { actions: LegacyUpgradeDialogActions }) {
	const [summary, setSummary] = useState<LegacyUpgradeReviewSummary | null>(null);
	const returnFocus = useRef<HTMLElement | null>(null);
	showDialog = setSummary;
	hideDialog = () => setSummary(null);

	const close = () => {
		actions.onDismiss();
		setSummary(null);
	};
	const actAndClose = (action: () => void) => {
		actions.onDismiss();
		setSummary(null);
		action();
	};
	const projectLabel = summary?.groupCount === 1 ? "project needs" : "projects need";
	const summaryText = summary
		? `${summary.groupCount.toLocaleString()} older ${projectLabel} a Sharing domain. They contain ${summary.memoryCount.toLocaleString()} older shared memories total; you will review the projects, not individual memories.`
		: null;

	return (
		<RadixDialog
			ariaDescribedby="legacyUpgradeDescription legacyUpgradeSummary"
			ariaLabelledby="legacyUpgradeTitle"
			contentClassName="modal legacy-upgrade-modal"
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
						Choose where older shared memories belong
					</RadixDialogTitle>
				</div>
				<div className="modal-body">
					<div className="small" id="legacyUpgradeDescription">
						Some memories were shared before codemem had clear Sharing domains. We kept them out of
						normal sync until you choose which project/domain they belong to.
					</div>
					<div className="legacy-upgrade-summary" id="legacyUpgradeSummary">
						{summaryText}
					</div>
					<div className="small">
						You’ll review projects, not individual memories. Nothing moves automatically, and this
						will not erase copies another device may already have received.
					</div>
					<label className="field-checkbox" htmlFor="legacyUpgradeDontShow">
						<input className="cm-checkbox" id="legacyUpgradeDontShow" type="checkbox" />
						<span>Don’t show this again</span>
					</label>
				</div>
				<div className="modal-footer">
					<div className="legacy-upgrade-actions">
						<button
							className="settings-button"
							id="legacyUpgradeReviewProjects"
							onClick={() => actAndClose(actions.onReviewProjects)}
							type="button"
						>
							Manage all projects
						</button>
						<button
							className="settings-button"
							id="legacyUpgradeNotNow"
							onClick={close}
							type="button"
						>
							Not now
						</button>
						<button
							className="settings-save"
							id="legacyUpgradeReviewGroups"
							onClick={() => actAndClose(actions.onReviewGroups)}
							type="button"
						>
							Start review
						</button>
					</div>
				</div>
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
