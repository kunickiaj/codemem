import { INPUT_TO_CONFIG_KEY } from "../data/constants";
import { settingsState, settingsView } from "../data/state";

export type SettingsOutcomeDetails = {
	controlId: string;
	existingData: string;
	scope: string;
	stage: string;
	timing: string;
};

export type SettingsOutcomeContext = {
	observerRuntime?: string;
};

function observationOutcome(controlId: string): SettingsOutcomeDetails {
	return {
		controlId,
		existingData: "Stored memories stay unchanged; no backfill runs.",
		scope: "Queued and future model requests on this device",
		stage: "Observation processing",
		timing: "After viewer restart",
	};
}

function processingOutcome(controlId: string): SettingsOutcomeDetails {
	return {
		controlId,
		existingData: "Stored memories stay unchanged; no reprocessing runs.",
		scope: "Queued and future events on this device",
		stage: "Observation processing",
		timing: "After viewer restart",
	};
}

function packOutcome(controlId: string): SettingsOutcomeDetails {
	return {
		controlId,
		existingData: "Stored memories and existing packs stay unchanged; the value is saved only.",
		scope: "No current effect",
		stage: "Saved setting",
		timing: "Not used when Codemem creates context packs",
	};
}

function syncOutcome(controlId: string, scope: string): SettingsOutcomeDetails {
	return {
		controlId,
		existingData:
			"Existing memories are not reprocessed locally, but eligible memories may be sent to or received from trusted peers.",
		scope,
		stage: "Device sync",
		timing: "After viewer restart",
	};
}

function sidecarAuthOutcome(controlId: string): SettingsOutcomeDetails {
	return {
		controlId,
		existingData:
			"Stored memories stay unchanged. Local Claude and Codex sessions authenticate through their CLI logins instead.",
		scope: "No effect while Connection mode uses a local Claude or Codex session",
		stage: "Sidecar authentication",
		timing: "Not used by local Claude or Codex sessions",
	};
}

const SIDECAR_AUTH_CONTROL_IDS = new Set([
	"observerAuthSource",
	"observerAuthTimeoutMs",
	"observerAuthCacheTtlS",
]);

function isSidecarRuntime(runtime: string | undefined): boolean {
	return runtime === "claude_sidecar" || runtime === "codex_sidecar";
}

const OUTCOMES_BY_CONTROL_ID: Record<string, SettingsOutcomeDetails> = Object.fromEntries(
	[
		...[
			"observerProvider",
			"observerModel",
			"observerRuntime",
			"observerMaxChars",
			"observerAuthSource",
			"observerAuthTimeoutMs",
			"observerAuthCacheTtlS",
		].map(observationOutcome),
		...[
			"observerTierRoutingEnabled",
			"observerSimpleModel",
			"observerSimpleTemperature",
			"observerReasoningEffort",
			"observerReasoningSummary",
			"observerRichModel",
			"observerRichTemperature",
			"observerRichReasoningEffort",
			"observerRichReasoningSummary",
			"observerRichMaxOutputTokens",
		].map(processingOutcome),
		packOutcome("packObservationLimit"),
		packOutcome("packSessionLimit"),
		{
			controlId: "rawEventsSweeperIntervalS",
			existingData: "Processed events stay unchanged; no backfill runs.",
			scope: "Background queue on this viewer",
			stage: "Queue processing",
			timing: "Immediately after save",
		},
		syncOutcome("syncEnabled", "Future sync cycles on this device"),
		syncOutcome("syncInterval", "Future sync cycles on this device"),
		syncOutcome("syncHost", "Incoming peer connections to this device"),
		syncOutcome("syncPort", "Incoming peer connections to this device"),
		syncOutcome(
			"syncMdns",
			"Advertise this device on the local network; this does not scan for peers",
		),
		syncOutcome(
			"syncCoordinatorGroup",
			"Fallback coordinator discovery when no coordinator group list is configured",
		),
		syncOutcome("syncCoordinatorTimeout", "Future coordinator requests"),
		syncOutcome("syncCoordinatorPresenceTtl", "Future coordinator presence checks"),
	].map((outcome) => [outcome.controlId, outcome]),
);

export function settingsOutcomeFor(
	controlId: string,
	context: SettingsOutcomeContext = {},
): SettingsOutcomeDetails | undefined {
	let outcome = OUTCOMES_BY_CONTROL_ID[controlId];
	if (!outcome) return undefined;
	const observerRuntime = String(effectiveSetting("observerRuntime", context.observerRuntime));
	if (SIDECAR_AUTH_CONTROL_IDS.has(controlId) && isSidecarRuntime(observerRuntime)) {
		return sidecarAuthOutcome(controlId);
	}
	outcome = conditionalOutcome(controlId, observerRuntime) ?? outcome;
	if (outcome.scope === "No current effect") return outcome;
	const configKey = INPUT_TO_CONFIG_KEY[controlId as keyof typeof INPUT_TO_CONFIG_KEY];
	const override = configKey ? settingsState.envOverrides[configKey] : undefined;
	if (typeof override !== "string" || !override.trim()) return outcome;
	return {
		...outcome,
		timing: `After removing ${override.trim()} and restarting the viewer`,
	};
}

function effectiveSetting(controlId: string, draft?: unknown): unknown {
	const key = INPUT_TO_CONFIG_KEY[controlId as keyof typeof INPUT_TO_CONFIG_KEY];
	if (key && settingsState.envOverrides[key]) return settingsState.effectiveConfig[key];
	return (
		draft ??
		settingsView.value.renderState.values[
			controlId as keyof typeof settingsView.value.renderState.values
		]
	);
}

function inactiveOutcome(controlId: string, reason: string): SettingsOutcomeDetails {
	return {
		controlId,
		existingData: "Stored memories stay unchanged; this value is saved only.",
		scope: "No current effect",
		stage: "Saved setting",
		timing: reason,
	};
}

function conditionalOutcome(
	controlId: string,
	runtime: string,
): SettingsOutcomeDetails | undefined {
	const sidecar = isSidecarRuntime(runtime);
	const provider = String(effectiveSetting("observerProvider"));
	const routing = effectiveSetting("observerTierRoutingEnabled") === true;
	if (controlId === "observerProvider" && sidecar)
		return inactiveOutcome(controlId, "Local Claude and Codex sessions select their own provider");
	if (controlId === "observerModel" && routing && ["openai", "anthropic"].includes(provider)) {
		return inactiveOutcome(
			controlId,
			"Tier models or built-in tier defaults take precedence over the base model",
		);
	}
	const authSource = String(effectiveSetting("observerAuthSource"));
	if (controlId === "observerAuthTimeoutMs" && !["auto", "command"].includes(authSource))
		return inactiveOutcome(controlId, "Only command authentication uses this timeout");
	if (controlId === "observerAuthCacheTtlS" && !["file", "command"].includes(authSource))
		return inactiveOutcome(
			controlId,
			"Only explicit file or command authentication uses this cache",
		);
	if (/Temperature$/.test(controlId)) return temperatureOutcome(controlId, runtime, provider);
	if (/Reasoning(Effort|Summary)$/.test(controlId) || controlId === "observerRichMaxOutputTokens")
		return tuningOutcome(controlId, sidecar);
	if (controlId === "syncEnabled" && effectiveSetting(controlId) === false)
		return {
			...syncOutcome(controlId, "Stop future peer transfers on this device"),
			existingData:
				"Stored memories remain. Disabling sync does not retract copies already replicated to peers.",
		};
	if (controlId === "syncHost" || controlId === "syncPort")
		return {
			...syncOutcome(controlId, "Incoming connections and newly generated pairing addresses"),
			timing:
				"Pairing payloads change immediately after save; restart the viewer before sharing or using them so the listener uses the new address",
		};
	return undefined;
}

function temperatureOutcome(
	controlId: string,
	runtime: string,
	provider: string,
): SettingsOutcomeDetails {
	if (isSidecarRuntime(runtime) || provider === "anthropic")
		return inactiveOutcome(
			controlId,
			"Anthropic and local Claude/Codex sessions do not send sampling temperature",
		);
	return {
		...processingOutcome(controlId),
		scope:
			"Only tier requests whose transport sends sampling temperature; OpenAI reasoning requests omit it",
		timing:
			"After viewer restart, only when the selected transport and reasoning mode support temperature",
	};
}

function tuningOutcome(controlId: string, sidecar: boolean): SettingsOutcomeDetails {
	if (sidecar)
		return inactiveOutcome(
			controlId,
			"Local Claude and Codex sessions do not use these API tuning fields",
		);
	const scope =
		controlId === "observerRichMaxOutputTokens"
			? "Rich-tier API requests whose transport consumes the output-token limit; unsupported transports ignore it"
			: "OpenAI Responses requests only; other transports ignore reasoning fields";
	return {
		...processingOutcome(controlId),
		scope,
		timing: "After viewer restart, only when the effective request transport consumes this setting",
	};
}

export function SettingsOutcome({
	controlId,
	existingData,
	scope,
	stage,
	timing,
}: SettingsOutcomeDetails) {
	return (
		<p className="settings-outcome" data-settings-outcome-for={controlId}>
			<span>
				<strong>Affects:</strong> {stage}
			</span>
			<span>
				<strong>Scope:</strong> {scope}
			</span>
			<span>
				<strong>Takes effect:</strong> {timing}
			</span>
			<span>
				<strong>Existing data:</strong> {existingData}
			</span>
		</p>
	);
}
