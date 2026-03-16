/**
 * Types for the ingest pipeline.
 *
 * Mirrors the Python dataclasses from codemem/observer_prompts.py and
 * codemem/xml_parser.py.
 */

// ---------------------------------------------------------------------------
// Tool events (input to observer)
// ---------------------------------------------------------------------------

export interface ToolEvent {
	toolName: string;
	toolInput: unknown;
	toolOutput: unknown;
	toolError: unknown;
	timestamp: string | null;
	cwd: string | null;
}

// ---------------------------------------------------------------------------
// Observer context (assembled before calling observer LLM)
// ---------------------------------------------------------------------------

export interface ObserverContext {
	project: string | null;
	userPrompt: string;
	promptNumber: number | null;
	toolEvents: ToolEvent[];
	lastAssistantMessage: string | null;
	includeSummary: boolean;
	diffSummary: string;
	recentFiles: string;
}

// ---------------------------------------------------------------------------
// Parsed observer output (XML response)
// ---------------------------------------------------------------------------

export interface ParsedObservation {
	kind: string;
	title: string;
	narrative: string;
	subtitle: string | null;
	facts: string[];
	concepts: string[];
	filesRead: string[];
	filesModified: string[];
}

export interface ParsedSummary {
	request: string;
	investigated: string;
	learned: string;
	completed: string;
	nextSteps: string;
	notes: string;
	filesRead: string[];
	filesModified: string[];
}

export interface ParsedOutput {
	observations: ParsedObservation[];
	summary: ParsedSummary | null;
	skipSummaryReason: string | null;
}

// ---------------------------------------------------------------------------
// Ingest payload (received from stdin)
// ---------------------------------------------------------------------------

export interface SessionContext {
	flushBatch?: Record<string, unknown>;
	firstPrompt?: string;
	promptCount?: number;
	toolCount?: number;
	durationMs?: number;
	filesModified?: string[];
	filesRead?: string[];
	source?: string;
	streamId?: string;
	opencodeSessionId?: string;
	flusher?: string;
}

export interface IngestPayload {
	cwd?: string;
	events?: Record<string, unknown>[];
	project?: string;
	startedAt?: string;
	sessionContext?: SessionContext;
}
