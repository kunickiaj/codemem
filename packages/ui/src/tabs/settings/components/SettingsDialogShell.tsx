import type { JSX } from "preact";
import { useCallback, useEffect } from "preact/hooks";
import { RadixDialog } from "../../../components/primitives/radix-dialog";
import { focusSettingsDialog } from "../data/dom";
import { settingsState, settingsView } from "../data/state";
import { setSettingsOpen } from "../data/state-ops";
import { useHelpTooltip } from "../hooks/use-help-tooltip";

export interface SettingsDialogShellProps {
	DialogContent: () => JSX.Element;
	onClose: (startPolling: () => void, refresh: () => void) => void;
}

export function SettingsDialogShell({ DialogContent, onClose }: SettingsDialogShellProps) {
	const { open } = settingsView.value;
	const { tooltipPortal, setTooltip } = useHelpTooltip();

	useEffect(() => {
		const hideTooltip = () => setTooltip({ anchor: null, content: "", visible: false });
		settingsState.hideTooltip = hideTooltip;

		return () => {
			if (settingsState.hideTooltip === hideTooltip) settingsState.hideTooltip = null;
		};
	}, []);

	// Radix Dialog mounts its children only while `open` is true, so any
	// <i data-lucide="..."> stubs inside the dialog need a createIcons pass
	// every time the modal opens. Running it on the shell mount (before the
	// children exist) is a no-op for those nodes.
	useEffect(() => {
		if (!open) return;
		const lucide = (globalThis as { lucide?: { createIcons?: () => void } }).lucide;
		lucide?.createIcons?.();
	}, [open]);

	const close = useCallback(() => {
		if (settingsState.startPolling && settingsState.refresh) {
			onClose(settingsState.startPolling, settingsState.refresh);
		}
	}, [onClose]);

	return (
		<>
			<RadixDialog
				ariaDescribedby="settingsDescription"
				ariaLabelledby="settingsTitle"
				contentClassName="modal"
				contentId="settingsModal"
				onCloseAutoFocus={(event) => {
					event.preventDefault();
				}}
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					focusSettingsDialog();
				}}
				onOpenChange={(nextOpen) => {
					if (nextOpen) {
						setSettingsOpen(true);
						return;
					}
					close();
				}}
				open={open}
				overlayClassName="modal-backdrop"
				overlayId="settingsBackdrop"
			>
				<DialogContent />
			</RadixDialog>
			{tooltipPortal}
		</>
	);
}
