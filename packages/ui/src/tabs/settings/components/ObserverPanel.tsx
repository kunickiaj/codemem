import type { ComponentChildren } from "preact";
import { RadixSelect } from "../../../components/primitives/radix-select";
import { TextArea } from "../../../components/primitives/text-area";
import { TextInput } from "../../../components/primitives/text-input";
import type { SettingsPanelProps } from "../data/types";
import { formatAgentClientList } from "../data/value-helpers";
import { Field } from "./Field";
import { ObserverModelSettings } from "./ObserverModelSettings";
import { SettingsHint } from "./SettingsHint";

function ConnectionModeField({
	runtime,
	onSelectValueChange,
}: {
	runtime: string;
	onSelectValueChange: SettingsPanelProps["onSelectValueChange"];
}) {
	let description = "Keeps your existing connection rules until you choose a connection below.";
	if (runtime === "claude_sidecar") {
		description = "Uses your local Claude CLI login. Claude chooses the provider.";
	} else if (runtime === "codex_sidecar") {
		description = "Uses your local Codex CLI login. Codex chooses the provider.";
	} else if (runtime === "opencode_v2") {
		description = "Uses the selected provider account in OpenCode. OpenCode must be running.";
	} else if (runtime === "api_key") {
		description = "Uses an API key for the selected provider. Does not use subscription sign-ins.";
	}
	const options = [
		{ label: "Automatic (detect connection)", value: "automatic" },
		{ label: "OpenCode account", value: "opencode_v2" },
		{ label: "API key", value: "api_key" },
		{ label: "Local Claude session", value: "claude_sidecar" },
		{ label: "Local Codex session", value: "codex_sidecar" },
	];
	if (runtime === "api_http")
		options.unshift({ label: "Existing API connection (legacy)", value: "api_http" });
	return (
		<Field>
			<div className="field-label">
				<label htmlFor="observerRuntime">Connection mode</label>
				<button
					aria-label="About connection mode"
					className="help-icon"
					data-tooltip="Choose which account handles model requests. An explicit connection never falls back to another account."
					type="button"
				>
					?
				</button>
			</div>
			<RadixSelect
				ariaLabel="Connection mode"
				contentClassName="settings-select-content"
				id="observerRuntime"
				itemClassName="settings-select-item"
				onValueChange={(value) =>
					onSelectValueChange("observerRuntime")(value === "automatic" ? "" : value)
				}
				options={options}
				triggerClassName="settings-select-trigger"
				value={runtime}
				viewportClassName="settings-select-viewport"
			/>
			<div className="small">{description}</div>
		</Field>
	);
}

function ProviderField({
	value,
	providerOptions,
	onSelectValueChange,
}: {
	value: string;
	providerOptions: SettingsPanelProps["providerOptions"];
	onSelectValueChange: SettingsPanelProps["onSelectValueChange"];
}) {
	const providerNames: Record<string, string> = {
		anthropic: "Anthropic",
		opencode: "OpenCode",
		openai: "OpenAI",
	};
	return (
		<Field>
			<div className="field-label">
				<label htmlFor="observerProvider">Model provider</label>
				<button
					aria-label="About model provider"
					className="help-icon"
					data-tooltip="Choose where model requests are sent. Pi setup can also derive a provider and model from an API-key provider."
					type="button"
				>
					?
				</button>
			</div>
			<RadixSelect
				ariaLabel="Model provider"
				contentClassName="settings-select-content"
				id="observerProvider"
				itemClassName="settings-select-item"
				onValueChange={onSelectValueChange("observerProvider")}
				options={[
					{ label: "Auto (infer provider)", value: "" },
					...providerOptions.map((option) => ({
						...option,
						label: providerNames[option.value] ?? option.label,
					})),
				]}
				placeholder="Auto (infer provider)"
				triggerClassName="settings-select-trigger"
				value={value}
				viewportClassName="settings-select-viewport"
			/>
			<div className="small">Use auto unless you need to pin a provider.</div>
		</Field>
	);
}

function ConnectionFields({
	values,
	runtime,
	explicit,
	providerOptions,
	onSelectValueChange,
}: Pick<SettingsPanelProps, "values" | "providerOptions" | "onSelectValueChange"> & {
	runtime: string;
	explicit: boolean;
}) {
	const local = runtime === "claude_sidecar" || runtime === "codex_sidecar";
	return (
		<>
			<ConnectionModeField
				runtime={explicit ? runtime : "automatic"}
				onSelectValueChange={onSelectValueChange}
			/>
			{!explicit || !local ? (
				<ProviderField
					value={values.observerProvider}
					providerOptions={providerOptions}
					onSelectValueChange={onSelectValueChange}
				/>
			) : null}
		</>
	);
}

function isLocalSession(runtime: string): boolean {
	return runtime === "claude_sidecar" || runtime === "codex_sidecar";
}

function usesHostedAccount(runtime: string): boolean {
	return isLocalSession(runtime) || runtime === "opencode_v2";
}

export function ObserverPanel({
	values,
	effectiveObserverRuntime = values.observerRuntime,
	hasExplicitObserverRuntime = true,
	allowAutomaticAuthChanges = false,
	tierProviders,
	modelDefaults,
	observerMaxCharsDefault,
	providerOptions,
	showAuthFile,
	showAuthCommand,
	hiddenUnlessAdvanced,
	onTextInput,
	onSelectValueChange,
	onSwitchInput,
	getObserverModelLabel,
	getObserverModelTooltip,
	protectedConfigHelp,
	observerStatusBannerSlot,
}: SettingsPanelProps & { observerStatusBannerSlot: ComponentChildren }) {
	return (
		<>
			<p className="small observer-panel-intro">Shared across {formatAgentClientList()}.</p>
			<div className="settings-group">
				<h3 className="settings-group-title">Connection</h3>
				<ConnectionFields
					{...{ values, providerOptions, onSelectValueChange }}
					runtime={effectiveObserverRuntime}
					explicit={hasExplicitObserverRuntime}
				/>
				<Field className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
					<label htmlFor="codexCommand">Codex command (JSON argv)</label>
					<TextArea
						disabled
						id="codexCommand"
						placeholder='["codex"]'
						rows={2}
						value={values.codexCommand}
					/>
					<div className="small">{protectedConfigHelp("codex_command")}</div>
				</Field>
				<Field className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
					<label htmlFor="claudeCommand">Claude command (JSON argv)</label>
					<TextArea
						disabled
						id="claudeCommand"
						placeholder='["claude"]'
						rows={2}
						value={values.claudeCommand}
					/>
					<div className="small">{protectedConfigHelp("claude_command")}</div>
				</Field>
				<Field className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
					<label htmlFor="observerMaxChars">Request size limit (chars)</label>
					<TextInput
						id="observerMaxChars"
						min="1"
						onInput={onTextInput("observerMaxChars")}
						type="number"
						value={values.observerMaxChars}
					/>
					<div className="small" id="observerMaxCharsHint">
						{observerMaxCharsDefault ? `Default: ${observerMaxCharsDefault}` : ""}
					</div>
				</Field>
			</div>
			<ObserverModelSettings
				values={{ ...values, observerRuntime: effectiveObserverRuntime }}
				tierProviders={tierProviders}
				modelDefaults={modelDefaults}
				hiddenUnlessAdvanced={hiddenUnlessAdvanced}
				onTextInput={onTextInput}
				onSwitchInput={onSwitchInput}
				getObserverModelLabel={getObserverModelLabel}
				getObserverModelTooltip={getObserverModelTooltip}
			/>
			{observerStatusBannerSlot}

			<div
				className="settings-group"
				hidden={usesHostedAccount(effectiveObserverRuntime) && !allowAutomaticAuthChanges}
			>
				<h3 className="settings-group-title">API credentials</h3>
				<Field>
					<div className="field-label">
						<label htmlFor="observerAuthSource">Credential source</label>
						<button
							aria-label="About authentication method"
							className="help-icon"
							data-tooltip="Choose how credentials are resolved: environment, file, command, or none."
							type="button"
						>
							?
						</button>
					</div>
					<RadixSelect
						ariaLabel="Authentication method"
						contentClassName="settings-select-content"
						id="observerAuthSource"
						itemClassName="settings-select-item"
						onValueChange={onSelectValueChange("observerAuthSource")}
						options={[
							{ label: "auto (default)", value: "auto" },
							{ label: "env", value: "env" },
							{ label: "file", value: "file" },
							{ label: "command", value: "command" },
							{ label: "none", value: "none" },
						]}
						triggerClassName="settings-select-trigger"
						value={values.observerAuthSource}
						viewportClassName="settings-select-viewport"
					/>
					<div className="small">
						API keys are read from your config or environment. File and command sources use the
						saved protected settings below.
					</div>
				</Field>
				<Field hidden={!showAuthFile} id="observerAuthFileField">
					<label htmlFor="observerAuthFile">Token file path</label>
					<TextInput
						disabled
						id="observerAuthFile"
						placeholder="~/.codemem/work-token.txt"
						value={values.observerAuthFile}
					/>
					<div className="small">{protectedConfigHelp("observer_auth_file")}</div>
				</Field>
				<Field hidden={!showAuthCommand} id="observerAuthCommandField">
					<div className="field-label">
						<label htmlFor="observerAuthCommand">Token command</label>
						<button
							aria-label="About token command"
							className="help-icon"
							data-tooltip="Runs this command and uses stdout as the token. JSON argv only, no shell parsing."
							type="button"
						>
							?
						</button>
					</div>
					<TextArea
						disabled
						id="observerAuthCommand"
						placeholder='["iap-auth", "--audience", "gateway"]'
						rows={3}
						value={values.observerAuthCommand}
					/>
					<div className="small">{protectedConfigHelp("observer_auth_command")}</div>
				</Field>
				<div className="small" hidden={!showAuthCommand} id="observerAuthCommandNote">
					Command format: JSON string array, e.g. `["iap-auth", "--audience", "gateway"]`.
				</div>
				<SettingsHint hidden={hiddenUnlessAdvanced()}>
					These advanced credential overrides only matter when you need custom command timing,
					cached tokens, or extra request headers.
				</SettingsHint>
				<Field className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
					<label htmlFor="observerAuthTimeoutMs">Token command timeout (ms)</label>
					<TextInput
						id="observerAuthTimeoutMs"
						min="1"
						onInput={onTextInput("observerAuthTimeoutMs")}
						type="number"
						value={values.observerAuthTimeoutMs}
					/>
				</Field>
				<Field className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
					<label htmlFor="observerAuthCacheTtlS">Token cache time (s)</label>
					<TextInput
						id="observerAuthCacheTtlS"
						min="0"
						onInput={onTextInput("observerAuthCacheTtlS")}
						type="number"
						value={values.observerAuthCacheTtlS}
					/>
				</Field>
				<Field className="field settings-advanced" hidden={hiddenUnlessAdvanced()}>
					<div className="field-label">
						<label htmlFor="observerHeaders">Request headers (JSON)</label>
						<button
							aria-label="About request headers"
							className="help-icon"
							data-tooltip={
								// biome-ignore lint/suspicious/noTemplateCurlyInString: literal documentation text describing the template placeholder syntax users can use in header values
								"Optional extra headers. Supports templates like ${auth.token}, ${auth.type}, ${auth.source}."
							}
							type="button"
						>
							?
						</button>
					</div>
					<TextArea
						disabled
						id="observerHeaders"
						placeholder='{"Authorization":"Bearer ${auth.token}"}'
						rows={4}
						value={values.observerHeaders}
					/>
					<div className="small">{protectedConfigHelp("observer_headers")}</div>
				</Field>
			</div>
		</>
	);
}
