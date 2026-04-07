import { isTrivialRequest } from "./ingest-transcript.js";
import type { SessionContext } from "./ingest-types.js";

export type SessionClass =
	| "trivial_turn"
	| "micro_low_value"
	| "micro_high_signal"
	| "working"
	| "durable";

export interface SessionClassificationInput {
	sessionContext: SessionContext;
	latestPrompt: string | null;
	toolEventCount: number;
	hasAssistantMessage: boolean;
	observationsCount: number;
	hasSummaryCandidate: boolean;
}

export function classifySessionForInjection(input: SessionClassificationInput): SessionClass {
	const durationMs = input.sessionContext.durationMs ?? 0;
	const promptCount = input.sessionContext.promptCount ?? 0;
	const derivedToolCount = input.toolEventCount;
	const sessionToolCount = input.sessionContext.toolCount ?? derivedToolCount;
	const toolCount = Math.max(derivedToolCount, sessionToolCount);
	const hasModifiedFiles = (input.sessionContext.filesModified?.length ?? 0) > 0;
	const hasReadFiles = (input.sessionContext.filesRead?.length ?? 0) > 0;
	const trivialPrompt = isTrivialRequest(input.latestPrompt);
	const hasTypedObservations = input.observationsCount > 0;
	const hasStrongSignals =
		hasTypedObservations ||
		hasModifiedFiles ||
		toolCount >= 3 ||
		hasReadFiles ||
		(toolCount > 0 && !trivialPrompt);

	if (
		trivialPrompt &&
		durationMs > 0 &&
		durationMs < 60_000 &&
		promptCount <= 1 &&
		toolCount === 0 &&
		!hasModifiedFiles &&
		!hasTypedObservations
	) {
		return "trivial_turn";
	}

	if (durationMs > 0 && durationMs < 60_000) {
		if (hasStrongSignals) {
			return hasTypedObservations ||
				hasModifiedFiles ||
				(toolCount > 0 && !trivialPrompt) ||
				hasReadFiles
				? "micro_high_signal"
				: "micro_low_value";
		}
		return "micro_low_value";
	}

	if (
		durationMs >= 600_000 ||
		hasModifiedFiles ||
		toolCount >= 10 ||
		input.observationsCount >= 3
	) {
		return "durable";
	}

	return "working";
}

export interface SummarySuppressionInput extends SessionClassificationInput {
	skipSummaryReason: string | null;
}

export function shouldSuppressSummaryOnlyOutput(input: SummarySuppressionInput): boolean {
	if (!input.hasSummaryCandidate) return false;
	if (input.observationsCount > 0) return false;
	if (input.skipSummaryReason) return false;
	if (!input.hasAssistantMessage) return false;
	const sessionClass = classifySessionForInjection(input);
	if (sessionClass === "trivial_turn") return true;
	if (sessionClass === "micro_low_value") return true;
	return false;
}
