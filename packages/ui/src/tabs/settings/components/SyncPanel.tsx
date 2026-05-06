import { TextInput } from "../../../components/primitives/text-input";
import type { SettingsPanelProps } from "../data/types";
import { SettingsHint } from "./SettingsHint";
import { SettingsSectionIntro } from "./SettingsSectionIntro";
import { SettingsSwitchRow } from "./SettingsSwitchRow";
import { SharingDomainsPanel } from "./SharingDomainsPanel";

export function SyncPanel({
	values,
	hiddenUnlessAdvanced,
	onTextInput,
	onSwitchInput,
	protectedConfigHelp,
}: SettingsPanelProps) {
	return (
		<>
			<SettingsSectionIntro
				detail="Choose whether this device syncs at all, how often it checks peers, and which coordinator group it should join."
				title="Device sync"
			/>
			<div className="settings-group">
				<h3 className="settings-group-title">Device Sync</h3>
				<SettingsSwitchRow
					checked={values.syncEnabled}
					className="field"
					id="syncEnabled"
					label="Enable sync"
					onCheckedChange={onSwitchInput("syncEnabled")}
				/>
				<div className="field">
					<label htmlFor="syncInterval">Sync interval (seconds)</label>
					<TextInput
						id="syncInterval"
						min="10"
						onInput={onTextInput("syncInterval")}
						type="number"
						value={values.syncInterval}
					/>
					<div className="small">
						How often this device checks for sync work when sync is enabled.
					</div>
				</div>
				<div className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
					<label htmlFor="syncHost">Sync host</label>
					<TextInput
						id="syncHost"
						onInput={onTextInput("syncHost")}
						placeholder="127.0.0.1"
						value={values.syncHost}
					/>
				</div>
				<div className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
					<label htmlFor="syncPort">Sync port</label>
					<TextInput
						id="syncPort"
						min="1"
						onInput={onTextInput("syncPort")}
						type="number"
						value={values.syncPort}
					/>
				</div>
				<SettingsSwitchRow
					checked={values.syncMdns}
					className="field settings-advanced"
					hidden={hiddenUnlessAdvanced()}
					id="syncMdns"
					label="Enable mDNS discovery"
					onCheckedChange={onSwitchInput("syncMdns")}
				/>
				<div className="field">
					<label htmlFor="syncCoordinatorUrl">Coordinator URL</label>
					<TextInput
						disabled
						id="syncCoordinatorUrl"
						placeholder="https://coord.example.com"
						value={values.syncCoordinatorUrl}
					/>
					<div className="small">{protectedConfigHelp("sync_coordinator_url")}</div>
				</div>
				<div className="field">
					<label htmlFor="syncCoordinatorGroup">Coordinator group</label>
					<TextInput
						id="syncCoordinatorGroup"
						onInput={onTextInput("syncCoordinatorGroup")}
						placeholder="team-alpha"
						value={values.syncCoordinatorGroup}
					/>
					<div className="small">Discovery namespace for peers using the same coordinator.</div>
				</div>
				<div className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
					<SettingsHint hidden={hiddenUnlessAdvanced()}>
						These network overrides are for unusual local-network setups. Leave them alone unless
						you know this device needs non-default sync discovery or coordinator timing.
					</SettingsHint>
				</div>
				<div className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
					<label htmlFor="syncCoordinatorTimeout">Coordinator timeout (seconds)</label>
					<TextInput
						id="syncCoordinatorTimeout"
						min="1"
						onInput={onTextInput("syncCoordinatorTimeout")}
						type="number"
						value={values.syncCoordinatorTimeout}
					/>
				</div>
				<div className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
					<label htmlFor="syncCoordinatorPresenceTtl">Presence TTL (seconds)</label>
					<TextInput
						id="syncCoordinatorPresenceTtl"
						min="1"
						onInput={onTextInput("syncCoordinatorPresenceTtl")}
						type="number"
						value={values.syncCoordinatorPresenceTtl}
					/>
				</div>
			</div>
			<SharingDomainsPanel />
		</>
	);
}
