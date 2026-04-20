import type { ComponentChildren } from "preact";
import { RadixSelect } from "../../../components/primitives/radix-select";
import { TextArea } from "../../../components/primitives/text-area";
import { TextInput } from "../../../components/primitives/text-input";
import type { SettingsPanelProps } from "../data/types";
import { Field } from "./Field";
import { SettingsHint } from "./SettingsHint";
import { SettingsSectionIntro } from "./SettingsSectionIntro";

export function ObserverPanel({
	values,
	observerMaxCharsDefault,
	providerOptions,
	showAuthFile,
	showAuthCommand,
	hiddenUnlessAdvanced,
	onTextInput,
	onSelectValueChange,
	getObserverModelLabel,
	getObserverModelTooltip,
	getObserverModelDescription,
	getObserverModelHint,
	protectedConfigHelp,
	observerStatusBannerSlot,
}: SettingsPanelProps & { observerStatusBannerSlot: ComponentChildren }) {
	return (
		<>
			<SettingsSectionIntro
				detail="Set how codemem reaches your model provider and where it should look for credentials."
				title="Connection and credentials"
			/>
			{observerStatusBannerSlot}
			<div className="settings-group">
				<h3 className="settings-group-title">Connection</h3>
				<Field>
					<div className="field-label">
						<label htmlFor="observerProvider">Model provider</label>
						<button
							aria-label="About model provider"
							className="help-icon"
							data-tooltip="Choose where model requests are sent. Use auto for recommended defaults."
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
						options={[{ label: "auto (default)", value: "" }, ...providerOptions]}
						placeholder="auto (default)"
						triggerClassName="settings-select-trigger"
						value={values.observerProvider}
						viewportClassName="settings-select-viewport"
					/>
					<div className="small">Use `auto` unless you need to pin a specific provider.</div>
				</Field>
				<Field>
					<div className="field-label">
						<label htmlFor="observerModel">{getObserverModelLabel()}</label>
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
						onInput={onTextInput("observerModel")}
						placeholder="leave empty for default"
						value={values.observerModel}
					/>
					<div className="small">{getObserverModelDescription()}</div>
					<div className="small" id="observerModelHint">
						{getObserverModelHint()}
					</div>
				</Field>
				<Field>
					<div className="field-label">
						<label htmlFor="observerRuntime">Connection mode</label>
						<button
							aria-label="About connection mode"
							className="help-icon"
							data-tooltip="Direct API uses provider credentials. Local Claude session uses local Claude runtime auth."
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
						onValueChange={onSelectValueChange("observerRuntime")}
						options={[
							{ label: "Direct API (default)", value: "api_http" },
							{ label: "Local Claude session", value: "claude_sidecar" },
						]}
						triggerClassName="settings-select-trigger"
						value={values.observerRuntime}
						viewportClassName="settings-select-viewport"
					/>
					<div className="small">
						Switch between provider API credentials and local Claude session auth.
					</div>
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

			<div className="settings-group">
				<h3 className="settings-group-title">Authentication</h3>
				<Field>
					<div className="field-label">
						<label htmlFor="observerAuthSource">Authentication method</label>
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
						Use `auto` unless you need to force a file or command-based token source.
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
