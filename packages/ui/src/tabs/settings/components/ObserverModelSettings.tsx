import { TextInput } from "../../../components/primitives/text-input";
import { modelPlaceholder } from "../data/model-placeholders";
import type { SettingsPanelProps } from "../data/types";
import { Field } from "./Field";
import { ObserverModelAvailability } from "./ObserverModelAvailability";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

type ModelSettingsProps = Pick<
	SettingsPanelProps,
	| "values"
	| "tierProviders"
	| "modelDefaults"
	| "hiddenUnlessAdvanced"
	| "onTextInput"
	| "onSwitchInput"
	| "getObserverModelLabel"
	| "getObserverModelTooltip"
>;

function BaseModelField({
	values,
	onTextInput,
	getObserverModelLabel,
	getObserverModelTooltip,
	modelDefaults,
}: ModelSettingsProps) {
	const tiered = values.observerTierRoutingEnabled;
	return (
		<Field>
			<div className="field-label">
				<label htmlFor="observerModel">{tiered ? "Fallback model" : getObserverModelLabel()}</label>
				<button
					aria-label="About model defaults"
					className="help-icon"
					data-tooltip={getObserverModelTooltip()}
					type="button"
				>
					?
				</button>
			</div>
			<TextInput
				id="observerModel"
				list="observerModel-catalog"
				onInput={onTextInput("observerModel")}
				placeholder={modelPlaceholder(values, modelDefaults)}
				value={values.observerModel}
			/>
			{tiered ? (
				<div className="small">Used only when a tier has no selected or built-in model.</div>
			) : null}
			{["api_http", "opencode_v2"].includes(values.observerRuntime) ? (
				<ObserverModelAvailability id="observerModel" values={values} />
			) : null}
		</Field>
	);
}

function TierModelField({
	tier,
	values,
	onTextInput,
	tierProviders,
	modelDefaults,
}: Pick<ModelSettingsProps, "values" | "onTextInput" | "tierProviders" | "modelDefaults"> & {
	tier: "simple" | "rich";
}) {
	const id = tier === "simple" ? "observerSimpleModel" : "observerRichModel";
	const label = tier === "simple" ? "Simple model" : "Rich model";
	const detail =
		tier === "simple"
			? "Used for shorter, simpler requests."
			: "Used for larger or more involved requests.";
	return (
		<Field>
			<label htmlFor={id}>{label}</label>
			<TextInput
				id={id}
				list={`${id}-catalog`}
				onInput={onTextInput(id)}
				placeholder={modelPlaceholder(values, modelDefaults, tier, tierProviders?.[tier])}
				value={values[id]}
			/>
			<div className="small">{detail}</div>
			{["api_http", "opencode_v2"].includes(values.observerRuntime) ? (
				<ObserverModelAvailability id={id} values={values} provider={tierProviders?.[tier]} />
			) : null}
		</Field>
	);
}

export function ObserverModelSettings(props: ModelSettingsProps) {
	const { values, onSwitchInput, hiddenUnlessAdvanced } = props;
	const tiered = values.observerTierRoutingEnabled;
	const hasFallback = values.observerModel.trim().length > 0;
	return (
		<div className="settings-group observer-model-settings">
			<h3 className="settings-group-title">Models</h3>
			<SettingsSwitchRow
				checked={tiered}
				className="field"
				id="observerTierRoutingEnabled"
				label="Use simple and rich models"
				onCheckedChange={onSwitchInput("observerTierRoutingEnabled")}
			/>
			{tiered ? (
				<>
					<TierModelField tier="simple" {...props} />
					<TierModelField tier="rich" {...props} />
					{hasFallback || !hiddenUnlessAdvanced() ? (
						<details className="observer-fallback-details">
							<summary>
								{hasFallback ? "Fallback model · Custom value set" : "Fallback model (optional)"}
							</summary>
							<BaseModelField {...props} />
						</details>
					) : null}
				</>
			) : (
				<BaseModelField {...props} />
			)}
		</div>
	);
}
