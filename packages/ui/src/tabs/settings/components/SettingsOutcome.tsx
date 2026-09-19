import { INPUT_TO_CONFIG_KEY } from "../data/constants";
import { settingsState } from "../data/state";

export type SettingsOutcomeDetails = {
	controlId: string;
	existingData: string;
	scope: string;
	stage: string;
	timing: string;
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
		existingData: "Stored memories and existing packs stay unchanged.",
		scope: "New default context packs",
		stage: "Context assembly",
		timing: "For new packs after process restart",
	};
}

function syncOutcome(controlId: string, scope: string): SettingsOutcomeDetails {
	return {
		controlId,
		existingData: "Existing memories and sync history stay unchanged.",
		scope,
		stage: "Device sync",
		timing: "After viewer restart",
	};
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
		syncOutcome("syncMdns", "Local-network peer discovery on this device"),
		syncOutcome("syncCoordinatorGroup", "Future coordinator discovery for this device"),
		syncOutcome("syncCoordinatorTimeout", "Future coordinator requests"),
		syncOutcome("syncCoordinatorPresenceTtl", "Future coordinator presence checks"),
	].map((outcome) => [outcome.controlId, outcome]),
);

export function settingsOutcomeFor(controlId: string): SettingsOutcomeDetails | undefined {
	const outcome = OUTCOMES_BY_CONTROL_ID[controlId];
	if (!outcome) return undefined;
	const configKey = INPUT_TO_CONFIG_KEY[controlId as keyof typeof INPUT_TO_CONFIG_KEY];
	const override = configKey ? settingsState.envOverrides[configKey] : undefined;
	if (typeof override !== "string" || !override.trim()) return outcome;
	return {
		...outcome,
		timing: `After removing ${override.trim()} and restarting the viewer`,
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
