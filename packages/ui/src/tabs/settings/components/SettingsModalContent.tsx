import type { ComponentChildren } from "preact";
import { DialogCloseButton } from "../../../components/primitives/dialog-close-button";
import { RadixTabs, RadixTabsContent } from "../../../components/primitives/radix-tabs";
import { SETTINGS_TABS } from "../data/constants";
import type { SettingsPanelProps, SettingsRenderState } from "../data/types";
import { ObserverPanel } from "./ObserverPanel";
import { ProcessingPanel } from "./ProcessingPanel";
import { SettingsHint } from "./SettingsHint";
import { SettingsSwitchRow } from "./SettingsSwitchRow";
import { SyncPanel } from "./SyncPanel";

export interface SettingsModalContentProps {
	panelProps: SettingsPanelProps;
	activeTab: string;
	showAdvanced: boolean;
	renderState: SettingsRenderState;
	settingsDirty: boolean;
	onClose: () => void;
	onSave: () => void;
	onActiveTabChange: (tab: string) => void;
	onAdvancedToggle: (checked: boolean) => void;
	observerStatusBannerSlot: ComponentChildren;
}

export function SettingsModalContent({
	panelProps,
	activeTab,
	showAdvanced,
	renderState,
	settingsDirty,
	onClose,
	onSave,
	onActiveTabChange,
	onAdvancedToggle,
	observerStatusBannerSlot,
}: SettingsModalContentProps) {
	return (
		<div className="modal-card">
			<div className="modal-header">
				<h2 id="settingsTitle">Settings</h2>
				<DialogCloseButton
					ariaLabel="Close settings"
					className="modal-close-button"
					onClick={onClose}
				/>
			</div>
			<div className="modal-body">
				<div className="small" id="settingsDescription">
					Tune how codemem connects, processes work, and syncs with other devices.
				</div>
				<div className="settings-advanced-toolbar">
					<SettingsSwitchRow
						checked={showAdvanced}
						id="settingsAdvancedToggle"
						label="Show advanced controls"
						onCheckedChange={onAdvancedToggle}
					/>
					<button
						aria-label="About advanced controls"
						className="help-icon"
						data-tooltip="Advanced controls include JSON fields, tuning values, and network overrides."
						type="button"
					>
						<i aria-hidden="true" data-lucide="help-circle" />
					</button>
				</div>
				<SettingsHint hidden={!showAdvanced}>
					Advanced controls are visible. Leave JSON fields, tuning values, and network overrides
					alone unless you are debugging or matching a known deployment setup.
				</SettingsHint>

				<RadixTabs
					ariaLabel="Settings sections"
					listClassName="settings-tabs"
					onValueChange={onActiveTabChange}
					tabs={SETTINGS_TABS}
					triggerClassName="settings-tab"
					value={activeTab}
				>
					<RadixTabsContent className="settings-panel" forceMount value="observer">
						<ObserverPanel {...panelProps} observerStatusBannerSlot={observerStatusBannerSlot} />
					</RadixTabsContent>

					<RadixTabsContent className="settings-panel" forceMount value="queue">
						<ProcessingPanel {...panelProps} />
					</RadixTabsContent>

					<RadixTabsContent className="settings-panel" forceMount value="sync">
						<SyncPanel {...panelProps} />
					</RadixTabsContent>
				</RadixTabs>

				<div className="small mono" id="settingsPath">
					{renderState.pathText}
				</div>
				<div className="small" id="settingsEffective">
					{renderState.effectiveText}
				</div>
				<div
					className="settings-note"
					hidden={!renderState.overridesVisible}
					id="settingsOverrides"
				>
					Some values are controlled outside this screen and take priority.
				</div>
				<div className="settings-note" hidden={showAdvanced}>
					Advanced controls are hidden right now to keep this screen focused on everyday settings.
				</div>
			</div>
			<div className="modal-footer">
				<div className="small" id="settingsStatus">
					{renderState.statusText}
				</div>
				<button
					className="settings-save"
					disabled={!settingsDirty || renderState.isSaving}
					id="settingsSave"
					onClick={onSave}
					type="button"
				>
					{renderState.isSaving ? "Saving…" : "Save changes"}
				</button>
			</div>
		</div>
	);
}
