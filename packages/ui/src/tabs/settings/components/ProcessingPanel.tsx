import { TextInput } from "../../../components/primitives/text-input";
import type { SettingsPanelProps } from "../data/types";
import { Field } from "./Field";
import { SettingsHint } from "./SettingsHint";
import { SettingsSectionIntro } from "./SettingsSectionIntro";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

export function ProcessingPanel({
	values,
	showTieredRouting,
	hiddenUnlessAdvanced,
	onTextInput,
	onSwitchInput,
	getTieredRoutingHelperText,
}: SettingsPanelProps) {
	return (
		<>
			<SettingsSectionIntro
				detail="Control how often codemem processes queued work and, if needed, how it routes lighter vs richer model requests."
				title="Processing and routing"
			/>
			<div className="settings-group">
				<h3 className="settings-group-title">Processing</h3>
				<Field>
					<div className="field-label">
						<label htmlFor="rawEventsSweeperIntervalS">
							Background processing interval (seconds)
						</label>
						<button
							aria-label="About background processing interval"
							className="help-icon"
							data-tooltip="How often codemem checks for queued events to process in the background."
							type="button"
						>
							?
						</button>
					</div>
					<TextInput
						id="rawEventsSweeperIntervalS"
						min="1"
						onInput={onTextInput("rawEventsSweeperIntervalS")}
						type="number"
						value={values.rawEventsSweeperIntervalS}
					/>
					<div className="small">
						How often codemem checks for queued raw events in the background.
					</div>
				</Field>
			</div>
			<div className="settings-group">
				<h3 className="settings-group-title">Tiered observer routing</h3>
				<SettingsSwitchRow
					checked={values.observerTierRoutingEnabled}
					className="field"
					id="observerTierRoutingEnabled"
					label="Enable tiered routing"
					onCheckedChange={onSwitchInput("observerTierRoutingEnabled")}
				/>
				<div className="small">{getTieredRoutingHelperText()}</div>
				<SettingsHint hidden={!showTieredRouting || hiddenUnlessAdvanced()}>
					These advanced routing values are only useful when you are tuning model cost, latency, or
					output quality for a known workload. If a selected path cannot honor the requested tier
					settings, codemem falls back visibly instead of silently pretending it worked.
				</SettingsHint>
				<Field hidden={!showTieredRouting}>
					<div className="field-label">
						<label htmlFor="observerSimpleModel">Simple tier model</label>
						<button
							aria-label="About simple tier model"
							className="help-icon"
							data-tooltip="Used for lighter replay batches. Leave blank to keep codemem's routing defaults. Explicit simple-tier values override the built-in defaults."
							type="button"
						>
							?
						</button>
					</div>
					<TextInput
						id="observerSimpleModel"
						onInput={onTextInput("observerSimpleModel")}
						placeholder="leave empty for default"
						value={values.observerSimpleModel}
					/>
					<div className="small">Used when a batch falls below rich-routing thresholds.</div>
				</Field>
				<Field hidden={!showTieredRouting}>
					<div className="field-label">
						<label htmlFor="observerRichModel">Rich tier model</label>
						<button
							aria-label="About rich tier model"
							className="help-icon"
							data-tooltip="Used for larger or more complex replay batches. Leave blank to keep codemem's rich-tier defaults. Explicit rich-tier values override the built-in defaults."
							type="button"
						>
							?
						</button>
					</div>
					<TextInput
						id="observerRichModel"
						onInput={onTextInput("observerRichModel")}
						placeholder="leave empty for default"
						value={values.observerRichModel}
					/>
					<div className="small">Used when routing detects a richer replay batch.</div>
				</Field>
				<SettingsSwitchRow
					checked={values.observerRichOpenAIUseResponses}
					className="field"
					hidden={!showTieredRouting}
					id="observerRichOpenAIUseResponses"
					label="Use OpenAI Responses API for rich tier"
					onCheckedChange={onSwitchInput("observerRichOpenAIUseResponses")}
				/>
				<div className="small" hidden={!showTieredRouting}>
					On: rich-tier OpenAI requests use the Responses API (reasoning + longer output). Turn off
					if your OpenAI account or proxy only supports chat/completions.
				</div>
				<Field
					className="field settings-advanced"
					hidden={!showTieredRouting || hiddenUnlessAdvanced()}
				>
					<label htmlFor="observerSimpleTemperature">Simple tier temperature</label>
					<TextInput
						id="observerSimpleTemperature"
						min="0"
						onInput={onTextInput("observerSimpleTemperature")}
						step="0.1"
						type="number"
						value={values.observerSimpleTemperature}
					/>
				</Field>
				<Field
					className="field settings-advanced"
					hidden={!showTieredRouting || hiddenUnlessAdvanced()}
				>
					<label htmlFor="observerRichTemperature">Rich tier temperature</label>
					<TextInput
						id="observerRichTemperature"
						min="0"
						onInput={onTextInput("observerRichTemperature")}
						step="0.1"
						type="number"
						value={values.observerRichTemperature}
					/>
				</Field>
				<Field
					className="field settings-advanced"
					hidden={!showTieredRouting || hiddenUnlessAdvanced()}
				>
					<label htmlFor="observerRichReasoningEffort">Rich tier reasoning effort</label>
					<TextInput
						id="observerRichReasoningEffort"
						onInput={onTextInput("observerRichReasoningEffort")}
						placeholder="leave empty for default"
						value={values.observerRichReasoningEffort}
					/>
				</Field>
				<Field
					className="field settings-advanced"
					hidden={!showTieredRouting || hiddenUnlessAdvanced()}
				>
					<label htmlFor="observerRichReasoningSummary">Rich tier reasoning summary</label>
					<TextInput
						id="observerRichReasoningSummary"
						onInput={onTextInput("observerRichReasoningSummary")}
						placeholder="leave empty for default"
						value={values.observerRichReasoningSummary}
					/>
				</Field>
				<Field
					className="field settings-advanced"
					hidden={!showTieredRouting || hiddenUnlessAdvanced()}
				>
					<label htmlFor="observerRichMaxOutputTokens">Rich tier max output tokens</label>
					<TextInput
						id="observerRichMaxOutputTokens"
						min="1"
						onInput={onTextInput("observerRichMaxOutputTokens")}
						step="1"
						type="number"
						value={values.observerRichMaxOutputTokens}
					/>
				</Field>
			</div>
			<div className="settings-group settings-advanced" hidden={hiddenUnlessAdvanced()}>
				<h3 className="settings-group-title">Pack limits</h3>
				<SettingsHint hidden={hiddenUnlessAdvanced()}>
					Most users can keep these defaults. Change them only when you need smaller or larger
					default context packs.
				</SettingsHint>
				<Field className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
					<label htmlFor="packObservationLimit">Observation limit</label>
					<TextInput
						id="packObservationLimit"
						min="1"
						onInput={onTextInput("packObservationLimit")}
						type="number"
						value={values.packObservationLimit}
					/>
					<div className="small">Default number of observations to include in a pack.</div>
				</Field>
				<Field className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
					<label htmlFor="packSessionLimit">Session summary limit</label>
					<TextInput
						id="packSessionLimit"
						min="1"
						onInput={onTextInput("packSessionLimit")}
						type="number"
						value={values.packSessionLimit}
					/>
					<div className="small">Default number of session summaries to include in a pack.</div>
				</Field>
			</div>
		</>
	);
}
