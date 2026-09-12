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
	hasDelegatedTask?: boolean;
}

interface SessionSignals {
	durationMs: number;
	promptCount: number;
	toolCount: number;
	hasModifiedFiles: boolean;
	hasReadFiles: boolean;
	trivialPrompt: boolean;
	hasTaskSignal: boolean;
}

function isTrivialTurn(signals: SessionSignals): boolean {
	return (
		signals.trivialPrompt &&
		signals.durationMs > 0 &&
		signals.durationMs < 60_000 &&
		signals.promptCount <= 1 &&
		signals.toolCount === 0 &&
		!signals.hasModifiedFiles &&
		!signals.hasTaskSignal
	);
}

function classifyMicroSession(signals: SessionSignals): SessionClass {
	const hasStrongSignals =
		signals.hasTaskSignal ||
		signals.hasModifiedFiles ||
		signals.toolCount >= 3 ||
		signals.hasReadFiles ||
		(signals.toolCount > 0 && !signals.trivialPrompt);
	if (!hasStrongSignals) return "micro_low_value";

	const hasHighSignal =
		signals.hasTaskSignal ||
		signals.hasModifiedFiles ||
		(signals.toolCount > 0 && !signals.trivialPrompt) ||
		signals.hasReadFiles;
	return hasHighSignal ? "micro_high_signal" : "micro_low_value";
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
	const hasTaskSignal = input.observationsCount > 0 || input.hasDelegatedTask === true;
	const signals = {
		durationMs,
		promptCount,
		toolCount,
		hasModifiedFiles,
		hasReadFiles,
		trivialPrompt,
		hasTaskSignal,
	};

	if (isTrivialTurn(signals)) return "trivial_turn";

	if (durationMs > 0 && durationMs < 60_000) {
		return classifyMicroSession(signals);
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
