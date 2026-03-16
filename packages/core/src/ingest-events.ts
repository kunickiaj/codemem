/**
 * Event extraction and budgeting for the ingest pipeline.
 *
 * Ports codemem/ingest/events.py + codemem/ingest_tool_events.py —
 * converts raw plugin events into ToolEvent structs, filters low-signal
 * tools, deduplicates, and budgets the list to fit observer token limits.
 */

import { sanitizePayload, sanitizeToolOutput } from "./ingest-sanitize.js";
import type { ToolEvent } from "./ingest-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Tools whose output is too noisy / low-signal to send to the observer.
 * Matches Python's LOW_SIGNAL_TOOLS set.
 */
export const LOW_SIGNAL_TOOLS = new Set([
	"tui",
	"shell",
	"cmd",
	"task",
	"slashcommand",
	"skill",
	"todowrite",
	"askuserquestion",
]);

// ---------------------------------------------------------------------------
// Tool name helpers
// ---------------------------------------------------------------------------

/** Return true for codemem's own MCP tools (avoids feedback loops). */
export function isInternalMemoryTool(tool: string): boolean {
	return tool.startsWith("codemem_memory_");
}

/** Extract a clean, lowercase tool name from a raw event. */
export function normalizeToolName(event: Record<string, unknown>): string {
	let tool = String(event.tool ?? event.type ?? "tool").toLowerCase();
	if (tool.includes(".")) tool = tool.split(".").pop() ?? tool;
	if (tool.includes(":")) tool = tool.split(":").pop() ?? tool;
	return tool;
}

// ---------------------------------------------------------------------------
// Output compaction
// ---------------------------------------------------------------------------

function compactReadOutput(text: string, maxLines = 80, maxChars = 2000): string {
	if (!text) return "";
	const allLines = text.split("\n");
	let lines = allLines;
	if (lines.length > maxLines) {
		lines = [...lines.slice(0, maxLines), `... (+${allLines.length - maxLines} more lines)`];
	}
	let compacted = lines.join("\n");
	if (maxChars > 0 && compacted.length > maxChars) {
		compacted = `${compacted.slice(0, maxChars)}\n... (truncated)`;
	}
	return compacted;
}

function compactListOutput(text: string): string {
	return compactReadOutput(text, 120, 2400);
}

// ---------------------------------------------------------------------------
// Event → ToolEvent conversion
// ---------------------------------------------------------------------------

/** Convert a single raw event to a ToolEvent, or null if it should be skipped. */
export function eventToToolEvent(
	event: Record<string, unknown>,
	maxChars: number,
	lowSignalTools: Set<string> = LOW_SIGNAL_TOOLS,
): ToolEvent | null {
	if (event.type !== "tool.execute.after") return null;

	const tool = normalizeToolName(event);
	if (isInternalMemoryTool(tool)) return null;
	if (lowSignalTools.has(tool)) return null;

	const rawArgs = event.args;
	const args =
		rawArgs != null && typeof rawArgs === "object" && !Array.isArray(rawArgs)
			? (rawArgs as Record<string, unknown>)
			: {};

	let result = sanitizeToolOutput(tool, event.result, maxChars);
	if (tool === "read" && typeof result === "string") result = compactReadOutput(result);
	if (tool === "bash" && typeof result === "string") result = compactReadOutput(result);
	if ((tool === "glob" || tool === "grep") && typeof result === "string") {
		result = compactListOutput(result);
	}

	const error = sanitizePayload(event.error, maxChars);

	return {
		toolName: tool,
		toolInput: sanitizePayload(args, maxChars),
		toolOutput: result,
		toolError: error,
		timestamp: typeof event.timestamp === "string" ? event.timestamp : null,
		cwd:
			(typeof event.cwd === "string" ? event.cwd : null) ??
			(typeof args.cwd === "string" ? args.cwd : null),
	};
}

/** Filter and convert all events to ToolEvents. */
export function extractToolEvents(
	events: Record<string, unknown>[],
	maxChars: number,
): ToolEvent[] {
	const result: ToolEvent[] = [];
	for (const event of events) {
		const te = eventToToolEvent(event, maxChars);
		if (te) result.push(te);
	}
	return result;
}

// ---------------------------------------------------------------------------
// Adapter event extraction (schema v1.0)
// ---------------------------------------------------------------------------

/** Extract validated _adapter event, or null if not a valid v1.0 adapter. */
export function extractAdapterEvent(
	event: Record<string, unknown>,
): Record<string, unknown> | null {
	const adapter = event._adapter;
	if (adapter == null || typeof adapter !== "object" || Array.isArray(adapter)) return null;
	const a = adapter as Record<string, unknown>;

	if (a.schema_version !== "1.0") return null;
	if (typeof a.source !== "string" || !a.source.trim()) return null;
	if (typeof a.session_id !== "string" || !a.session_id.trim()) return null;
	if (typeof a.event_id !== "string" || !a.event_id.trim()) return null;

	const eventType = a.event_type;
	if (typeof eventType !== "string") return null;
	const validTypes = new Set([
		"prompt",
		"assistant",
		"tool_call",
		"tool_result",
		"session_start",
		"session_end",
		"error",
	]);
	if (!validTypes.has(eventType)) return null;

	if (a.payload == null || typeof a.payload !== "object") return null;
	if (typeof a.ts !== "string" || !a.ts.trim()) return null;

	// Validate timestamp parses
	try {
		const d = new Date(a.ts as string);
		if (Number.isNaN(d.getTime())) return null;
	} catch {
		return null;
	}

	return a;
}

/** Project an adapter tool_result into the flat event format expected by eventToToolEvent. */
export function projectAdapterToolEvent(
	adapter: Record<string, unknown>,
	event: Record<string, unknown>,
): Record<string, unknown> | null {
	const eventType = String(adapter.event_type ?? "");
	const payload = adapter.payload as Record<string, unknown> | undefined;
	if (!payload || typeof payload !== "object") return null;
	if (eventType !== "tool_result") return null;

	let toolInput = payload.tool_input;
	if (toolInput == null || typeof toolInput !== "object") toolInput = {};

	let toolError = payload.tool_error ?? null;
	if (toolError == null && payload.status === "error") toolError = payload.error ?? null;

	let toolOutput = payload.tool_output ?? null;
	if (toolOutput == null && "output" in payload) toolOutput = payload.output ?? null;

	return {
		type: "tool.execute.after",
		tool: payload.tool_name,
		args: toolInput,
		result: toolOutput,
		error: toolError,
		timestamp: adapter.ts,
		cwd: event.cwd,
	};
}

// ---------------------------------------------------------------------------
// Tool event budgeting
// ---------------------------------------------------------------------------

function toolEventSignature(event: ToolEvent): string {
	if (event.toolName === "bash" && event.toolInput != null && typeof event.toolInput === "object") {
		const input = event.toolInput as Record<string, unknown>;
		const cmd = String(input.command ?? "")
			.trim()
			.toLowerCase();
		if ((cmd === "git status" || cmd === "git diff") && !event.toolError) {
			return `bash:${cmd}`;
		}
	}
	const parts: string[] = [event.toolName];
	try {
		parts.push(JSON.stringify(event.toolInput));
	} catch {
		parts.push(String(event.toolInput));
	}
	if (event.toolError) parts.push(String(event.toolError).slice(0, 200));
	if (typeof event.toolOutput === "string" && event.toolOutput) {
		parts.push(event.toolOutput.slice(0, 200));
	}
	return parts.join("|");
}

function toolEventImportance(event: ToolEvent): number {
	let score = 0;
	if (event.toolError) score += 100;
	const tool = (event.toolName || "").toLowerCase();
	if (tool === "edit" || tool === "write") score += 50;
	else if (tool === "bash") score += 30;
	else if (tool === "read") score += 20;
	else score += 10;
	return score;
}

function estimateEventSize(event: ToolEvent): number {
	try {
		return JSON.stringify(event).length;
	} catch {
		return String(event).length;
	}
}

/**
 * Deduplicate, rank, and trim tool events to fit within budget.
 *
 * 1. Deduplicates (keeping last occurrence).
 * 2. If over maxEvents, keeps the most important ones.
 * 3. If over maxTotalChars, keeps the most important that fit.
 */
export function budgetToolEvents(
	toolEvents: ToolEvent[],
	maxTotalChars: number,
	maxEvents: number,
): ToolEvent[] {
	if (!toolEvents.length || maxTotalChars <= 0 || maxEvents <= 0) return [];

	// Deduplicate, preferring last occurrence
	const seen = new Set<string>();
	const deduped: ToolEvent[] = [];
	for (let i = toolEvents.length - 1; i >= 0; i--) {
		const evt = toolEvents[i];
		if (!evt) continue;
		const sig = toolEventSignature(evt);
		if (seen.has(sig)) continue;
		seen.add(sig);
		deduped.push(evt);
	}
	deduped.reverse();

	// Trim to maxEvents by importance
	let result = deduped;
	if (result.length > maxEvents) {
		const indexed = result.map((e, i) => ({ event: e, idx: i }));
		indexed.sort((a, b) => {
			const impDiff = toolEventImportance(b.event) - toolEventImportance(a.event);
			if (impDiff !== 0) return impDiff;
			return a.idx - b.idx; // prefer earlier for same importance
		});
		const keepIdxs = new Set(indexed.slice(0, maxEvents).map((x) => x.idx));
		result = result.filter((_, i) => keepIdxs.has(i));
	}

	// Check total size
	const totalSize = result.reduce((sum, e) => sum + estimateEventSize(e), 0);
	if (totalSize <= maxTotalChars) return result;

	// Budget by size — pick most important that fit
	const indexed = result.map((e, i) => ({ event: e, idx: i }));
	indexed.sort((a, b) => {
		const impDiff = toolEventImportance(b.event) - toolEventImportance(a.event);
		if (impDiff !== 0) return impDiff;
		return a.idx - b.idx;
	});

	const kept: { event: ToolEvent; idx: number }[] = [];
	let runningTotal = 0;
	for (const item of indexed) {
		const size = estimateEventSize(item.event);
		if (runningTotal + size > maxTotalChars && kept.length > 0) continue;
		kept.push(item);
		runningTotal += size;
		if (runningTotal >= maxTotalChars) break;
	}

	// Restore original order
	kept.sort((a, b) => a.idx - b.idx);
	return kept.map((x) => x.event);
}
