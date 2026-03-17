/**
 * Claude hook payload mapping.
 *
 * Ports codemem/claude_hooks.py — normalizes raw Claude Code hook payloads
 * (PreToolUse, PostToolUse, Stop, etc.) into raw event envelopes suitable
 * for the raw event sweeper pipeline.
 *
 * Entry points:
 *   mapClaudeHookPayload(payload)           → adapter event or null
 *   buildRawEventEnvelopeFromHook(payload)  → raw event envelope or null
 *   buildIngestPayloadFromHook(payload)     → ingest payload or null
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Expand `~/...` paths like Python's `Path(...).expanduser()`. */
function expandUser(value: string): string {
	return value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAPPABLE_CLAUDE_HOOK_EVENTS = new Set([
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"Stop",
	"SessionEnd",
]);

// ---------------------------------------------------------------------------
// Timestamp helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
	return new Date()
		.toISOString()
		.replace("+00:00", "")
		.replace(/\.(\d{3})\d*Z$/, ".$1Z");
}

/**
 * Normalize an ISO timestamp string, returning null if invalid.
 *
 * Matches Python's `datetime.isoformat().replace("+00:00", "Z")`:
 *   - No fractional seconds if the input has none → "2026-03-04T01:00:00Z"
 *   - Preserves fractional seconds when present  → "2026-03-04T01:00:00.123000Z"
 *
 * JS `Date.toISOString()` always outputs ".000Z" which would produce different
 * sha256 event IDs than Python during the migration crossover period.
 */
function normalizeIsoTs(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const text = value.trim();
	if (!text) return null;
	try {
		// Python: datetime.fromisoformat(text.replace("Z", "+00:00"))
		// then: if parsed.tzinfo is None: parsed = parsed.replace(tzinfo=UTC)
		//
		// JS `new Date("2026-03-04T01:00:00")` treats naive timestamps as LOCAL time,
		// but Python treats them as UTC. Detect naive timestamps and append Z.
		const hasTimezone =
			/[Zz]$/.test(text) || /[+-]\d{2}:\d{2}$/.test(text) || /[+-]\d{4}$/.test(text);
		const parseText = hasTimezone ? text : `${text}Z`;

		const d = new Date(parseText);
		if (Number.isNaN(d.getTime())) return null;

		// Detect whether the input has fractional seconds
		// Strip timezone suffix first, then check for a dot before "Z"/"+"/"-"
		const hasFractional = /\.\d+([Zz+-]|$)/.test(text);
		if (!hasFractional) {
			// No fractional seconds — produce "YYYY-MM-DDTHH:MM:SSZ" (matches Python)
			return d.toISOString().replace(/\.\d{3}Z$/, "Z");
		}
		// Has fractional seconds — produce microsecond precision like Python (6 digits)
		const iso = d.toISOString(); // "YYYY-MM-DDTHH:MM:SS.mmmZ"
		// Pad from 3 digits to 6 to match Python's microsecond output
		return iso.replace(/\.(\d{3})Z$/, ".$1000Z");
	} catch {
		return null;
	}
}

/** Parse an ISO timestamp to wall-clock milliseconds. */
function isoToWallMs(value: string): number {
	return new Date(value).getTime();
}

// ---------------------------------------------------------------------------
// Stable event id
// ---------------------------------------------------------------------------

function stableEventId(...parts: string[]): string {
	const joined = parts.join("|");
	const digest = createHash("sha256").update(joined, "utf-8").digest("hex").slice(0, 24);
	return `cld_evt_${digest}`;
}

// ---------------------------------------------------------------------------
// Project inference (mirrors Python's _infer_project_from_cwd /
// _resolve_hook_project / _resolve_hook_project_from_payload_paths)
// ---------------------------------------------------------------------------

/** Normalize a raw label value to a plain project name (basename if path). */
export function normalizeProjectLabel(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const cleaned = value.trim();
	if (!cleaned) return null;
	if (cleaned.includes("/") || cleaned.includes("\\")) {
		// Windows-style path (drive letter or backslash)
		const isWindows =
			cleaned.includes("\\") ||
			(cleaned.length >= 2 && cleaned[1] === ":" && /[a-zA-Z]/.test(cleaned[0] ?? ""));
		if (isWindows) {
			const parts = cleaned.replaceAll("\\", "/").split("/");
			return parts[parts.length - 1] || null;
		}
		const parts = cleaned.split("/");
		return parts[parts.length - 1] || null;
	}
	return cleaned;
}

/**
 * Walk up from `cwd` looking for a .git marker, then return the basename of
 * that directory (or the cwd basename if no git root found).
 * Returns null if cwd is not an absolute, existing directory.
 */
function inferProjectFromCwd(cwd: string | null): string | null {
	if (typeof cwd !== "string" || !cwd.trim()) return null;
	const text = expandUser(cwd.trim());
	if (!isAbsolute(text)) return null;
	try {
		const stat = statSync(text, { throwIfNoEntry: false });
		if (!stat?.isDirectory()) return null;
	} catch {
		return null;
	}

	let current = text;
	while (true) {
		const gitPath = resolve(current, ".git");
		if (existsSync(gitPath)) {
			return basename(current) || null;
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return basename(text) || null;
}

/**
 * Infer project from a file path hint (e.g. a tool input `filePath`).
 * Walks up from the file's directory.
 */
function inferProjectFromPathHint(pathHint: unknown, cwdHint?: string | null): string | null {
	if (typeof pathHint !== "string" || !pathHint.trim()) return null;
	const text = expandUser(pathHint.trim());

	let candidate: string;
	if (isAbsolute(text)) {
		candidate = text;
	} else {
		if (typeof cwdHint !== "string" || !cwdHint.trim()) return null;
		const base = expandUser(cwdHint.trim());
		if (!isAbsolute(base)) return null;
		try {
			const stat = statSync(base, { throwIfNoEntry: false });
			if (!stat?.isDirectory()) return null;
		} catch {
			return null;
		}
		candidate = resolve(base, text);
	}

	// Determine starting dir: if candidate is a dir use it, else use parent
	let start: string;
	try {
		const stat = statSync(candidate, { throwIfNoEntry: false });
		start = stat?.isDirectory() ? candidate : dirname(candidate);
	} catch {
		start = dirname(candidate);
	}

	// Walk up to find an existing directory
	let current = start;
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}

	return inferProjectFromCwd(current);
}

/**
 * Resolve the project for a hook payload.
 * Priority: CODEMEM_PROJECT env → cwd git root → payload project label.
 */
export function resolveHookProject(cwd: string | null, payloadProject: unknown): string | null {
	const envProject = normalizeProjectLabel(process.env.CODEMEM_PROJECT);
	if (envProject) return envProject;

	const payloadLabel = normalizeProjectLabel(payloadProject);
	const cwdLabel = inferProjectFromCwd(cwd);

	if (cwdLabel) {
		// If payload label matches cwd label exactly, prefer payload (avoids ambiguity)
		if (payloadLabel && payloadLabel === cwdLabel) return payloadLabel;
		return cwdLabel;
	}
	return payloadLabel ?? null;
}

/**
 * Try to infer project from tool_input paths or transcript_path in a hook payload.
 */
function resolveHookProjectFromPayloadPaths(hookPayload: Record<string, unknown>): string | null {
	const cwdHint = typeof hookPayload.cwd === "string" ? hookPayload.cwd : null;
	const toolInput = hookPayload.tool_input;
	if (toolInput != null && typeof toolInput === "object" && !Array.isArray(toolInput)) {
		const ti = toolInput as Record<string, unknown>;
		for (const key of ["filePath", "file_path", "path"]) {
			const project = inferProjectFromPathHint(ti[key], cwdHint);
			if (project) return project;
		}
	}
	const project = inferProjectFromPathHint(hookPayload.transcript_path, cwdHint);
	if (project) return project;
	return null;
}

// ---------------------------------------------------------------------------
// Usage normalization
// ---------------------------------------------------------------------------

function normalizeUsage(value: unknown): Record<string, number> | null {
	if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
	const v = value as Record<string, unknown>;

	// Matches Python: int(value.get(key) or 0) — no clamping to >= 0
	const toInt = (key: string): number => {
		try {
			const n = Number(v[key] ?? 0);
			return Number.isFinite(n) ? Math.trunc(n) : 0;
		} catch {
			return 0;
		}
	};

	const normalized = {
		input_tokens: toInt("input_tokens"),
		output_tokens: toInt("output_tokens"),
		cache_creation_input_tokens: toInt("cache_creation_input_tokens"),
		cache_read_input_tokens: toInt("cache_read_input_tokens"),
	};
	const total = Object.values(normalized).reduce((a, b) => a + b, 0);
	return total > 0 ? normalized : null;
}

// ---------------------------------------------------------------------------
// Text extraction from content blocks
// ---------------------------------------------------------------------------

function textFromContent(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (Array.isArray(value)) {
		const parts = value.map(textFromContent).filter(Boolean);
		return parts.join("\n").trim();
	}
	if (value != null && typeof value === "object") {
		const v = value as Record<string, unknown>;
		if (typeof v.text === "string") return v.text.trim();
		return textFromContent(v.content);
	}
	return "";
}

// ---------------------------------------------------------------------------
// Transcript extraction (for Stop events without last_assistant_message)
// ---------------------------------------------------------------------------

/**
 * Read the transcript JSONL and return the last assistant message text + usage.
 * Returns [null, null] on any read or parse failure.
 */
function extractFromTranscript(
	transcriptPath: unknown,
	cwdHint?: string | null,
): [string | null, Record<string, number> | null] {
	if (typeof transcriptPath !== "string") return [null, null];
	const raw = expandUser(transcriptPath.trim());
	if (!raw) return [null, null];

	let resolvedPath: string;
	if (isAbsolute(raw)) {
		resolvedPath = raw;
	} else {
		if (typeof cwdHint !== "string" || !cwdHint.trim()) return [null, null];
		const base = expandUser(cwdHint.trim());
		if (!isAbsolute(base)) return [null, null];
		try {
			const stat = statSync(base, { throwIfNoEntry: false });
			if (!stat?.isDirectory()) return [null, null];
		} catch {
			return [null, null];
		}
		resolvedPath = resolve(base, raw);
	}

	try {
		const stat = statSync(resolvedPath, { throwIfNoEntry: false });
		if (!stat?.isFile()) return [null, null];
	} catch {
		return [null, null];
	}

	let assistantText: string | null = null;
	let assistantUsage: Record<string, number> | null = null;

	try {
		const content = readFileSync(resolvedPath, "utf-8");
		for (const rawLine of content.split("\n")) {
			const line = rawLine.trim();
			if (!line) continue;
			let record: unknown;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			if (record == null || typeof record !== "object" || Array.isArray(record)) continue;
			const r = record as Record<string, unknown>;

			// A line may be the record itself or have a nested `message` field
			const candidates: Record<string, unknown>[] = [r];
			if (r.message != null && typeof r.message === "object" && !Array.isArray(r.message)) {
				candidates.push(r.message as Record<string, unknown>);
			}

			let role = "";
			let contentValue: unknown = null;
			let usageValue: unknown = null;

			for (const c of candidates) {
				if (!role) {
					if (typeof c.role === "string") role = c.role.trim().toLowerCase();
					else if (c.type === "assistant") role = "assistant";
				}
				if (contentValue == null) {
					for (const field of ["content", "text"]) {
						if (field in c) {
							contentValue = c[field];
							break;
						}
					}
				}
				if (usageValue == null) {
					for (const field of ["usage", "token_usage", "tokenUsage"]) {
						if (field in c) {
							usageValue = c[field];
							break;
						}
					}
				}
			}

			if (role !== "assistant") continue;
			const text = textFromContent(contentValue);
			if (!text) continue;
			assistantText = text;
			assistantUsage = normalizeUsage(usageValue);
		}
	} catch {
		return [null, null];
	}

	return [assistantText, assistantUsage];
}

// ---------------------------------------------------------------------------
// Session id
// ---------------------------------------------------------------------------

function coerceSessionId(payload: Record<string, unknown>): string | null {
	const raw = payload.session_id;
	if (typeof raw !== "string") return null;
	const value = raw.trim();
	return value || null;
}

// ---------------------------------------------------------------------------
// mapClaudeHookPayload
// ---------------------------------------------------------------------------

export interface ClaudeHookAdapterEvent {
	schema_version: "1.0";
	source: "claude";
	session_id: string;
	event_id: string;
	event_type: string;
	ts: string;
	ordering_confidence: "low";
	cwd: string | null;
	payload: Record<string, unknown>;
	meta: Record<string, unknown>;
}

/**
 * Map a raw Claude Code hook payload to a normalized adapter event.
 * Returns null if the event type is unsupported or required fields are missing.
 */
export function mapClaudeHookPayload(
	payload: Record<string, unknown>,
): ClaudeHookAdapterEvent | null {
	const hookEvent = String(payload.hook_event_name ?? "").trim();
	if (!MAPPABLE_CLAUDE_HOOK_EVENTS.has(hookEvent)) return null;

	const sessionId = coerceSessionId(payload);
	if (!sessionId) return null;

	const rawTs = payload.ts ?? payload.timestamp;
	const normalizedRawTs = normalizeIsoTs(rawTs);
	const ts = normalizedRawTs ?? nowIso();
	const toolUseId = String(payload.tool_use_id ?? "").trim();

	const consumed = new Set([
		"hook_event_name",
		"session_id",
		"cwd",
		"ts",
		"timestamp",
		"transcript_path",
		"permission_mode",
		"tool_use_id",
	]);

	let eventType: string;
	let eventPayload: Record<string, unknown>;
	let eventIdPayload: Record<string, unknown>;

	if (hookEvent === "SessionStart") {
		eventType = "session_start";
		eventPayload = { source: payload.source };
		eventIdPayload = { ...eventPayload };
		consumed.add("source");
	} else if (hookEvent === "UserPromptSubmit") {
		const text = String(payload.prompt ?? "").trim();
		if (!text) return null;
		eventType = "prompt";
		eventPayload = { text };
		eventIdPayload = { ...eventPayload };
		consumed.add("prompt");
	} else if (hookEvent === "PreToolUse") {
		const toolName = String(payload.tool_name ?? "").trim();
		if (!toolName) return null;
		const toolInput =
			payload.tool_input != null &&
			typeof payload.tool_input === "object" &&
			!Array.isArray(payload.tool_input)
				? (payload.tool_input as Record<string, unknown>)
				: {};
		eventType = "tool_call";
		eventPayload = { tool_name: toolName, tool_input: toolInput };
		eventIdPayload = { ...eventPayload };
		consumed.add("tool_name");
		consumed.add("tool_input");
	} else if (hookEvent === "PostToolUse") {
		const toolName = String(payload.tool_name ?? "").trim();
		if (!toolName) return null;
		const toolInput =
			payload.tool_input != null &&
			typeof payload.tool_input === "object" &&
			!Array.isArray(payload.tool_input)
				? (payload.tool_input as Record<string, unknown>)
				: {};
		const toolResponse = payload.tool_response ?? null;
		eventType = "tool_result";
		eventPayload = {
			tool_name: toolName,
			status: "ok",
			tool_input: toolInput,
			tool_output: toolResponse,
			tool_error: null,
		};
		eventIdPayload = { ...eventPayload };
		consumed.add("tool_name");
		consumed.add("tool_input");
		consumed.add("tool_response");
	} else if (hookEvent === "PostToolUseFailure") {
		const toolName = String(payload.tool_name ?? "").trim();
		if (!toolName) return null;
		const toolInput =
			payload.tool_input != null &&
			typeof payload.tool_input === "object" &&
			!Array.isArray(payload.tool_input)
				? (payload.tool_input as Record<string, unknown>)
				: {};
		const error = payload.error ?? null;
		eventType = "tool_result";
		eventPayload = {
			tool_name: toolName,
			status: "error",
			tool_input: toolInput,
			tool_output: null,
			error,
		};
		eventIdPayload = { ...eventPayload };
		consumed.add("tool_name");
		consumed.add("tool_input");
		consumed.add("error");
		consumed.add("is_interrupt");
	} else if (hookEvent === "Stop") {
		const rawAssistantText = String(payload.last_assistant_message ?? "").trim();
		const rawUsage = normalizeUsage(payload.usage);

		let assistantText = rawAssistantText;
		let usage = rawUsage;

		if (!assistantText || usage === null) {
			const cwd = typeof payload.cwd === "string" ? payload.cwd : null;
			const [transcriptText, transcriptUsage] = extractFromTranscript(payload.transcript_path, cwd);
			if (!assistantText && transcriptText) assistantText = transcriptText;
			if (usage === null && transcriptUsage !== null) usage = transcriptUsage;
		}

		if (!assistantText) return null;

		eventType = "assistant";
		eventPayload = { text: assistantText };
		if (usage !== null) eventPayload.usage = usage;

		eventIdPayload = { text: rawAssistantText };
		if (rawUsage !== null) eventIdPayload.usage = rawUsage;
		if (!rawAssistantText && rawUsage === null) {
			const transcriptPath = payload.transcript_path;
			if (typeof transcriptPath === "string" && transcriptPath.trim()) {
				eventIdPayload.transcript_path = transcriptPath.trim();
			}
		}
		consumed.add("stop_hook_active");
		consumed.add("last_assistant_message");
		consumed.add("usage");
	} else {
		// SessionEnd
		eventType = "session_end";
		eventPayload = { reason: payload.reason ?? null };
		eventIdPayload = { ...eventPayload };
		consumed.add("reason");
	}

	// Build meta — forward unknown fields as hook_fields
	const meta: Record<string, unknown> = {
		hook_event_name: hookEvent,
		ordering_confidence: "low",
	};
	if (toolUseId) meta.tool_use_id = toolUseId;
	if (normalizedRawTs === null) meta.ts_normalized = "generated";

	const unknown: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(payload)) {
		if (!consumed.has(k)) unknown[k] = v;
	}
	if (Object.keys(unknown).length > 0) meta.hook_fields = unknown;

	// Compute stable event id
	const eventIdTsSeed = normalizedRawTs ?? ts;
	// Matches Python's json.dumps(sort_keys=True, default=str):
	// - sortKeys() recursively sorts object keys
	// - the replacer coerces non-JSON-native values to strings (like Python's default=str)
	const payloadHash = createHash("sha256")
		.update(
			JSON.stringify(sortKeys(eventIdPayload), (_key, value) => {
				if (value === undefined) return "None"; // Python stringifies None
				if (typeof value === "bigint") return String(value);
				return value;
			}),
			"utf-8",
		)
		.digest("hex");

	const eventId = stableEventId(sessionId, hookEvent, eventIdTsSeed, toolUseId, payloadHash);

	const cwd = typeof payload.cwd === "string" ? payload.cwd : null;

	return {
		schema_version: "1.0",
		source: "claude",
		session_id: sessionId,
		event_id: eventId,
		event_type: eventType,
		ts,
		ordering_confidence: "low",
		cwd,
		payload: eventPayload,
		meta,
	};
}

/** Recursively sort object keys (matches Python's json.dumps(sort_keys=True)). */
function sortKeys(value: unknown): unknown {
	if (value == null || typeof value !== "object" || Array.isArray(value)) return value;
	const sorted: Record<string, unknown> = {};
	for (const k of Object.keys(value as Record<string, unknown>).sort()) {
		sorted[k] = sortKeys((value as Record<string, unknown>)[k]);
	}
	return sorted;
}

// ---------------------------------------------------------------------------
// buildRawEventEnvelopeFromHook
// ---------------------------------------------------------------------------

export interface ClaudeHookRawEventEnvelope {
	session_stream_id: string;
	session_id: string;
	opencode_session_id: string;
	source: string;
	event_id: string;
	event_type: "claude.hook";
	payload: Record<string, unknown>;
	ts_wall_ms: number;
	cwd: string | null;
	project: string | null;
	started_at: string | null;
}

/**
 * Build a raw event envelope from a Claude Code hook payload.
 * Returns null if the payload is unsupported or missing required fields.
 */
export function buildRawEventEnvelopeFromHook(
	hookPayload: Record<string, unknown>,
): ClaudeHookRawEventEnvelope | null {
	const adapterEvent = mapClaudeHookPayload(hookPayload);
	if (adapterEvent === null) return null;

	const sessionId = adapterEvent.session_id.trim();
	if (!sessionId) return null;

	const ts = adapterEvent.ts.trim();
	if (!ts) return null;

	const source = adapterEvent.source || "claude";
	const hookEventName = String(hookPayload.hook_event_name ?? "");
	const cwd = typeof hookPayload.cwd === "string" ? hookPayload.cwd : null;

	let project = resolveHookProject(cwd, hookPayload.project);
	if (project === null) {
		project = resolveHookProjectFromPayloadPaths(hookPayload);
	}

	return {
		session_stream_id: sessionId,
		session_id: sessionId,
		opencode_session_id: sessionId,
		source,
		event_id: adapterEvent.event_id,
		event_type: "claude.hook",
		payload: {
			type: "claude.hook",
			timestamp: ts,
			_adapter: adapterEvent,
		},
		ts_wall_ms: isoToWallMs(ts),
		cwd,
		project,
		started_at: hookEventName === "SessionStart" ? ts : null,
	};
}

// ---------------------------------------------------------------------------
// buildIngestPayloadFromHook
// ---------------------------------------------------------------------------

/**
 * Build an ingest pipeline payload from a Claude Code hook payload.
 * Used by the direct-ingest path (non-raw-event path).
 * Returns null if the payload is unsupported.
 */
export function buildIngestPayloadFromHook(
	hookPayload: Record<string, unknown>,
): Record<string, unknown> | null {
	const adapterEvent = mapClaudeHookPayload(hookPayload);
	if (adapterEvent === null) return null;

	const sessionId = adapterEvent.session_id;
	return {
		cwd: hookPayload.cwd ?? null,
		events: [
			{
				type: "claude.hook",
				timestamp: adapterEvent.ts,
				_adapter: adapterEvent,
			},
		],
		session_context: {
			source: "claude",
			stream_id: sessionId,
			session_stream_id: sessionId,
			session_id: sessionId,
			opencode_session_id: sessionId,
		},
	};
}
