import { TextInput } from "../../../components/primitives/text-input";
import type { SettingsPanelProps } from "../data/types";
import { Field } from "./Field";
import { ObserverModelAvailability } from "./ObserverModelAvailability";
import { SettingsHint } from "./SettingsHint";
import { SettingsSectionIntro } from "./SettingsSectionIntro";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

function TierModelField({
	tier,
	values,
	onTextInput,
	tierProviders,
}: Pick<SettingsPanelProps, "values" | "onTextInput" | "tierProviders"> & {
	tier: "simple" | "rich";
}) {
	const id = tier === "simple" ? "observerSimpleModel" : "observerRichModel";
	const copy = {
		simple: {
			help: "About simple tier model",
			detail: "Used when a batch falls below rich-routing thresholds.",
			tooltip:
				"Used for lighter replay batches. Leave blank to keep codemem's routing defaults. Explicit simple-tier values override the built-in defaults.",
		},
		rich: {
			help: "About rich tier model",
			detail: "Used when routing detects a richer replay batch.",
			tooltip:
				"Used for larger or more complex replay batches. Leave blank to keep codemem's rich-tier defaults. Explicit rich-tier values override the built-in defaults.",
		},
	}[tier];
	return (
		<Field>
			<div className="field-label">
				<label htmlFor={id}>Model</label>
				<button
					aria-label={copy.help}
					className="help-icon"
					data-tooltip={copy.tooltip}
					type="button"
				>
					?
				</button>
			</div>
			<TextInput
				id={id}
				list={`${id}-catalog`}
				onInput={onTextInput(id)}
				placeholder="leave empty for default"
				value={values[id]}
			/>
			<div className="small">{copy.detail}</div>
			<ObserverModelAvailability id={id} values={values} provider={tierProviders?.[tier]} />
		</Field>
	);
}

export function ProcessingPanel({
	values,
	tierProviders,
	showTieredRouting,
	hiddenUnlessAdvanced,
	onTextInput,
	onSwitchInput,
	getTieredRoutingHelperText,
}: SettingsPanelProps) {
	const modelFieldProps = { values, onTextInput, tierProviders };
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
				<div hidden={!showTieredRouting}>
					<h4>Simple tier</h4>
					<TierModelField {...modelFieldProps} tier="simple" />
					<Field className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
						<label htmlFor="observerSimpleTemperature">Temperature</label>
						<TextInput
							id="observerSimpleTemperature"
							min="0"
							onInput={onTextInput("observerSimpleTemperature")}
							step="0.1"
							type="number"
							value={values.observerSimpleTemperature}
						/>
					</Field>
				</div>
				<div className="settings-advanced" hidden={!showTieredRouting || hiddenUnlessAdvanced()}>
					<h4>Shared reasoning defaults</h4>
					<div className="small">
						Applied to OpenAI Responses requests in both tiers unless a rich-tier override is set.
					</div>
					<Field className="field settings-advanced">
						<label htmlFor="observerReasoningEffort">Reasoning effort</label>
						<TextInput
							id="observerReasoningEffort"
							onInput={onTextInput("observerReasoningEffort")}
							placeholder="leave empty for provider default"
							value={values.observerReasoningEffort}
						/>
					</Field>
					<Field className="field settings-advanced">
						<label htmlFor="observerReasoningSummary">Reasoning summary</label>
						<TextInput
							id="observerReasoningSummary"
							onInput={onTextInput("observerReasoningSummary")}
							placeholder="leave empty for provider default"
							value={values.observerReasoningSummary}
						/>
					</Field>
				</div>
				<div hidden={!showTieredRouting}>
					<h4>Rich tier</h4>
					<TierModelField {...modelFieldProps} tier="rich" />
					<Field className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
						<label htmlFor="observerRichTemperature">Temperature</label>
						<TextInput
							id="observerRichTemperature"
							min="0"
							onInput={onTextInput("observerRichTemperature")}
							step="0.1"
							type="number"
							value={values.observerRichTemperature}
						/>
					</Field>
					<Field className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
						<label htmlFor="observerRichReasoningEffort">Reasoning effort override</label>
						<TextInput
							id="observerRichReasoningEffort"
							onInput={onTextInput("observerRichReasoningEffort")}
							placeholder="inherits shared reasoning effort"
							value={values.observerRichReasoningEffort}
						/>
					</Field>
					<Field className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
						<label htmlFor="observerRichReasoningSummary">Reasoning summary override</label>
						<TextInput
							id="observerRichReasoningSummary"
							onInput={onTextInput("observerRichReasoningSummary")}
							placeholder="inherits shared reasoning summary"
							value={values.observerRichReasoningSummary}
						/>
					</Field>
					<Field className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
						<label htmlFor="observerRichMaxOutputTokens">Max output tokens</label>
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
