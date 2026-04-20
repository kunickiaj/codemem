import type { JSX } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { RadixDialog } from "../../../components/primitives/radix-dialog";
import { state } from "../../../lib/state";
import { focusSettingsDialog } from "../data/dom";
import { settingsState } from "../data/state";
import type { SettingsTabId } from "../data/types";
import { persistAdvancedPreference } from "../data/value-helpers";
import { useHelpTooltip } from "../hooks/use-help-tooltip";

export interface SettingsDialogShellProps {
	DialogContent: () => JSX.Element;
	onClose: (startPolling: () => void, refresh: () => void) => void;
}

export function SettingsDialogShell({ DialogContent, onClose }: SettingsDialogShellProps) {
	const [open, setOpen] = useState(settingsState.open);
	const [activeTab, setActiveTabState] = useState<SettingsTabId>(
		["observer", "queue", "sync"].includes(settingsState.activeTab)
			? (settingsState.activeTab as SettingsTabId)
			: "observer",
	);
	const [dirty, setDirtyState] = useState(state.settingsDirty);
	const [renderState, setRenderStateState] = useState(settingsState.renderState);
	const [showAdvanced, setShowAdvancedState] = useState(settingsState.showAdvanced);
	const { tooltipPortal, setTooltip } = useHelpTooltip();

	settingsState.open = open;
	settingsState.activeTab = activeTab;
	state.settingsDirty = dirty;
	settingsState.renderState = renderState;
	settingsState.showAdvanced = showAdvanced;

	useEffect(() => {
		settingsState.controller = {
			hideTooltip: () => {
				setTooltip({ anchor: null, content: "", visible: false });
			},
			setActiveTab: (tab) => {
				const nextTab = ["observer", "queue", "sync"].includes(tab) ? tab : "observer";
				settingsState.activeTab = nextTab;
				setActiveTabState(nextTab);
			},
			setDirty: (nextDirty) => {
				state.settingsDirty = nextDirty;
				setDirtyState(nextDirty);
			},
			setOpen: (nextOpen) => {
				settingsState.open = nextOpen;
				setOpen(nextOpen);
			},
			setRenderState: (patch) => {
				const nextState = {
					...settingsState.renderState,
					...patch,
				};
				settingsState.renderState = nextState;
				setRenderStateState(nextState);
			},
			setShowAdvanced: (nextShowAdvanced) => {
				settingsState.showAdvanced = nextShowAdvanced;
				persistAdvancedPreference(nextShowAdvanced);
				setShowAdvancedState(nextShowAdvanced);
			},
		};

		return () => {
			if (settingsState.controller) {
				settingsState.controller = null;
			}
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
						setOpen(true);
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
