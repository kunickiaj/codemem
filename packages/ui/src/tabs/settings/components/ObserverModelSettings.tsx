import { TextInput } from "../../../components/primitives/text-input";
import type { SettingsPanelProps } from "../data/types";
import { Field } from "./Field";
import { ObserverModelAvailability } from "./ObserverModelAvailability";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

type ModelSettingsProps = Pick<
	SettingsPanelProps,
	| "values"
	| "tierProviders"
	| "hiddenUnlessAdvanced"
	| "onTextInput"
	| "onSwitchInput"
	| "getObserverModelLabel"
	| "getObserverModelTooltip"
	| "getObserverModelDescription"
	| "getObserverModelHint"
>;

function BaseModelField({
	values,
	onTextInput,
	getObserverModelLabel,
	getObserverModelTooltip,
	getObserverModelDescription,
	getObserverModelHint,
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
				placeholder="leave empty for default"
				value={values.observerModel}
			/>
			{tiered ? (
				<div className="small">Used only when a tier has no selected or built-in model.</div>
			) : (
				<>
					<div className="small">{getObserverModelDescription()}</div>
					<div className="small" id="observerModelHint">
						{getObserverModelHint()}
					</div>
				</>
			)}
			{values.observerRuntime === "api_http" ? (
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
}: Pick<ModelSettingsProps, "values" | "onTextInput" | "tierProviders"> & {
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
				placeholder="leave empty for recommended default"
				value={values[id]}
			/>
			<div className="small">{detail}</div>
			{values.observerRuntime === "api_http" ? (
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
					<div className="small">Leave a model blank to use its recommended default.</div>
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
