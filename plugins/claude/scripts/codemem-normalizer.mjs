import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
//#region packages/core/src/hook-transcript.ts
var MAX_HOOK_TRANSCRIPT_BYTES = 16777216;
var HOOK_TRANSCRIPT_CHUNK_BYTES = 65536;
var TRUSTED_HOOK_TRANSCRIPT_POLICY = { trust: "trusted" };
function expandUser$1(path) {
	return path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
}
function isContained(root, target) {
	const pathFromRoot = relative(root, target);
	return pathFromRoot === "" || pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
}
function resolveTranscriptPath(transcriptPath, options) {
	if (typeof transcriptPath !== "string") return { outcome: "not_provided" };
	const requestedPath = expandUser$1(transcriptPath.trim());
	if (!requestedPath) return { outcome: "not_provided" };
	if (!isAbsolute(requestedPath)) {
		if (options.policy.trust !== "trusted") return { outcome: "path_rejected" };
		if (typeof options.cwd !== "string") return { outcome: "path_rejected" };
		try {
			const cwd = expandUser$1(options.cwd.trim());
			if (!isAbsolute(cwd)) return { outcome: "path_rejected" };
			const realCwd = realpathSync(cwd);
			if (!statSync(realCwd).isDirectory()) return { outcome: "path_rejected" };
			const realTarget = realpathSync(resolve(realCwd, requestedPath));
			return isContained(realCwd, realTarget) ? { path: realTarget } : { outcome: "path_rejected" };
		} catch {
			return { outcome: "unreadable" };
		}
	}
	try {
		const realTarget = realpathSync(requestedPath);
		if (options.policy.trust === "trusted") return { path: realTarget };
		for (const root of options.policy.approvedRoots) try {
			const realRoot = realpathSync(expandUser$1(root));
			if (statSync(realRoot).isDirectory() && isContained(realRoot, realTarget)) return { path: realTarget };
		} catch {}
	} catch {
		return { outcome: "unreadable" };
	}
	return { outcome: "path_rejected" };
}
function reportBytesRead(options, count) {
	if (count <= 0) return;
	try {
		options.onBytesRead?.(count);
	} catch {}
}
function readInto(descriptor, buffer, length, position, options) {
	let offset = 0;
	while (offset < length) {
		const count = readSync(descriptor, buffer, offset, length - offset, position + offset);
		if (count === 0) break;
		offset += count;
		reportBytesRead(options, count);
	}
	return offset;
}
function decodeRecord(descriptor, buffer, start, end, options) {
	const decoder = new TextDecoder("utf-8", { fatal: false });
	let position = start;
	let text = "";
	while (position < end) {
		const count = readInto(descriptor, buffer, Math.min(buffer.length, end - position), position, options);
		if (count === 0) break;
		position += count;
		text += decoder.decode(buffer.subarray(0, count), { stream: position < end });
	}
	return text;
}
function textFromContent(value) {
	if (typeof value === "string") return value.trim();
	if (Array.isArray(value)) return value.map(textFromContent).filter(Boolean).join("\n").trim();
	if (value != null && typeof value === "object") {
		const record = value;
		if (typeof record.text === "string") return record.text.trim();
		return textFromContent(record.content);
	}
	return "";
}
function normalizeUsage$1(value) {
	if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
	const usage = value;
	const toInt = (key) => {
		try {
			const parsed = Number(usage[key] ?? 0);
			return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
		} catch {
			return 0;
		}
	};
	const normalized = {
		input_tokens: toInt("input_tokens"),
		output_tokens: toInt("output_tokens"),
		cache_creation_input_tokens: toInt("cache_creation_input_tokens"),
		cache_read_input_tokens: toInt("cache_read_input_tokens")
	};
	return Object.values(normalized).reduce((sum, count) => sum + count, 0) > 0 ? normalized : null;
}
function assistantFromRecord(line) {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const parsed = JSON.parse(trimmed);
		if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const record = parsed;
		const candidates = [record];
		if (record.message != null && typeof record.message === "object" && !Array.isArray(record.message)) candidates.push(record.message);
		let role = "";
		let contentValue = null;
		let usageValue = null;
		for (const candidate of candidates) {
			if (!role) {
				if (typeof candidate.role === "string") role = candidate.role.trim().toLowerCase();
				else if (candidate.type === "assistant") role = "assistant";
			}
			if (contentValue == null) {
				for (const field of ["content", "text"]) if (field in candidate) {
					contentValue = candidate[field];
					break;
				}
			}
			if (usageValue == null) {
				for (const field of [
					"usage",
					"token_usage",
					"tokenUsage"
				]) if (field in candidate) {
					usageValue = candidate[field];
					break;
				}
			}
		}
		if (role !== "assistant") return null;
		const text = textFromContent(contentValue);
		return text ? [text, normalizeUsage$1(usageValue)] : null;
	} catch {
		return null;
	}
}
function scanTranscript(descriptor, size, options) {
	const windowStart = Math.max(0, size - MAX_HOOK_TRANSCRIPT_BYTES);
	const buffer = Buffer.allocUnsafe(HOOK_TRANSCRIPT_CHUNK_BYTES);
	const decodeBuffer = Buffer.allocUnsafe(HOOK_TRANSCRIPT_CHUNK_BYTES);
	let boundaryAligned = windowStart === 0;
	if (!boundaryAligned) boundaryAligned = readInto(descriptor, buffer, 1, windowStart - 1, options) === 1 && buffer[0] === 10;
	let lineEnd = size;
	let scanEnd = size;
	let hasCompleteRecord = false;
	while (scanEnd > windowStart) {
		const chunkStart = Math.max(windowStart, scanEnd - buffer.length);
		const count = readInto(descriptor, buffer, scanEnd - chunkStart, chunkStart, options);
		if (count === 0) break;
		for (let index = count - 1; index >= 0; index -= 1) {
			if (buffer[index] !== 10) continue;
			const lineStart = chunkStart + index + 1;
			if (lineEnd > lineStart) {
				hasCompleteRecord = true;
				const extraction = assistantFromRecord(lineEnd <= chunkStart + count ? buffer.subarray(index + 1, lineEnd - chunkStart).toString("utf8") : decodeRecord(descriptor, decodeBuffer, lineStart, lineEnd, options));
				if (extraction) return {
					extraction,
					outcome: "ok"
				};
			}
			lineEnd = chunkStart + index;
		}
		scanEnd = chunkStart;
	}
	if (boundaryAligned && lineEnd > windowStart) {
		hasCompleteRecord = true;
		const extraction = assistantFromRecord(decodeRecord(descriptor, decodeBuffer, windowStart, lineEnd, options));
		if (extraction) return {
			extraction,
			outcome: "ok"
		};
	}
	return {
		extraction: [null, null],
		outcome: hasCompleteRecord ? "no_assistant_record" : "no_complete_record"
	};
}
function readTranscript(path, options) {
	let descriptor = null;
	try {
		descriptor = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
		const stat = fstatSync(descriptor);
		if (!stat.isFile()) return {
			extraction: [null, null],
			outcome: "unreadable"
		};
		const openedPath = realpathSync(path);
		const openedPathStat = statSync(openedPath);
		if (openedPath !== path || openedPathStat.dev !== stat.dev || openedPathStat.ino !== stat.ino) return {
			extraction: [null, null],
			outcome: "path_rejected"
		};
		return scanTranscript(descriptor, stat.size, options);
	} catch {
		return {
			extraction: [null, null],
			outcome: "unreadable"
		};
	} finally {
		if (descriptor !== null) try {
			closeSync(descriptor);
		} catch {}
	}
}
function extractHookTranscriptWithOutcome(transcriptPath, options) {
	const resolved = resolveTranscriptPath(transcriptPath, options);
	if ("outcome" in resolved) return {
		extraction: [null, null],
		outcome: resolved.outcome
	};
	return readTranscript(resolved.path, options);
}
//#endregion
//#region packages/core/src/claude-hooks.ts
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
/** Expand `~/...` paths like Python's `Path(...).expanduser()`. */
function expandUser(value) {
	return value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value;
}
var MAPPABLE_CLAUDE_HOOK_EVENTS = /* @__PURE__ */ new Set([
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"Stop",
	"SessionEnd"
]);
/** Frozen discriminator for Claude's derived event identity contract. */
var CLAUDE_EVENT_ID_ALGO = "claude/1";
function nowIso() {
	return (/* @__PURE__ */ new Date()).toISOString().replace("+00:00", "").replace(/\.(\d{3})\d*Z$/, ".$1Z");
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
function normalizeIsoTs(value) {
	if (typeof value !== "string") return null;
	const text = value.trim();
	if (!text) return null;
	try {
		const parseText = /[Zz]$/.test(text) || /[+-]\d{2}:\d{2}$/.test(text) || /[+-]\d{4}$/.test(text) ? text : `${text}Z`;
		const d = new Date(parseText);
		if (Number.isNaN(d.getTime())) return null;
		if (!/\.\d+([Zz+-]|$)/.test(text)) return d.toISOString().replace(/\.\d{3}Z$/, "Z");
		return d.toISOString().replace(/\.(\d{3})Z$/, ".$1000Z");
	} catch {
		return null;
	}
}
/** Parse an ISO timestamp to wall-clock milliseconds. */
function isoToWallMs(value) {
	return new Date(value).getTime();
}
function stableEventId(...parts) {
	const joined = parts.join("|");
	return `cld_evt_${createHash("sha256").update(joined, "utf-8").digest("hex").slice(0, 24)}`;
}
/** Normalize a raw label value to a plain project name (basename if path). */
function normalizeProjectLabel(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	let end = trimmed.length;
	while (end > 0) {
		const code = trimmed.charCodeAt(end - 1);
		if (code === 47 || code === 92) end -= 1;
		else break;
	}
	const cleaned = trimmed.slice(0, end);
	if (!cleaned) return null;
	if (cleaned.includes("/") || cleaned.includes("\\")) {
		if (cleaned.includes("\\") || cleaned.length >= 2 && cleaned[1] === ":" && /[a-zA-Z]/.test(cleaned[0] ?? "")) {
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
function inferProjectFromCwd(cwd) {
	if (typeof cwd !== "string" || !cwd.trim()) return null;
	const text = expandUser(cwd.trim());
	if (!isAbsolute(text)) return null;
	try {
		if (!statSync(text, { throwIfNoEntry: false })?.isDirectory()) return null;
	} catch {
		return null;
	}
	let current = text;
	while (true) {
		const gitPath = resolve(current, ".git");
		if (existsSync(gitPath)) return basename(current) || null;
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
function inferProjectFromPathHint(pathHint, cwdHint) {
	if (typeof pathHint !== "string" || !pathHint.trim()) return null;
	const text = expandUser(pathHint.trim());
	let candidate;
	if (isAbsolute(text)) candidate = text;
	else {
		if (typeof cwdHint !== "string" || !cwdHint.trim()) return null;
		const base = expandUser(cwdHint.trim());
		if (!isAbsolute(base)) return null;
		try {
			if (!statSync(base, { throwIfNoEntry: false })?.isDirectory()) return null;
		} catch {
			return null;
		}
		candidate = resolve(base, text);
	}
	let start;
	try {
		start = statSync(candidate, { throwIfNoEntry: false })?.isDirectory() ? candidate : dirname(candidate);
	} catch {
		start = dirname(candidate);
	}
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
function resolveHookProject(cwd, payloadProject) {
	const envProject = normalizeProjectLabel(process.env.CODEMEM_PROJECT);
	if (envProject) return envProject;
	const payloadLabel = normalizeProjectLabel(payloadProject);
	const cwdLabel = inferProjectFromCwd(cwd);
	if (cwdLabel) {
		if (payloadLabel && payloadLabel === cwdLabel) return payloadLabel;
		return cwdLabel;
	}
	return payloadLabel ?? null;
}
/**
* Try to infer project from tool_input paths or transcript_path in a hook payload.
*/
function resolveHookProjectFromPayloadPaths(hookPayload) {
	const cwdHint = typeof hookPayload.cwd === "string" ? hookPayload.cwd : null;
	const toolInput = hookPayload.tool_input;
	if (toolInput != null && typeof toolInput === "object" && !Array.isArray(toolInput)) {
		const ti = toolInput;
		for (const key of [
			"filePath",
			"file_path",
			"path"
		]) {
			const project = inferProjectFromPathHint(ti[key], cwdHint);
			if (project) return project;
		}
	}
	const project = inferProjectFromPathHint(hookPayload.transcript_path, cwdHint);
	if (project) return project;
	return null;
}
function normalizeUsage(value) {
	if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
	const v = value;
	const toInt = (key) => {
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
		cache_read_input_tokens: toInt("cache_read_input_tokens")
	};
	return Object.values(normalized).reduce((a, b) => a + b, 0) > 0 ? normalized : null;
}
/**
* Read the transcript JSONL and return the last assistant message text + usage.
* Returns [null, null] on any read or parse failure.
*
* Exported so other adapter mappers (e.g. Codex) can reuse the same
* transcript fallback for Stop events that omit `last_assistant_message`.
*/
function extractFromTranscript(transcriptPath, cwdHint, policy = {
	trust: "restricted",
	approvedRoots: []
}, onTranscriptOutcome) {
	const result = extractHookTranscriptWithOutcome(transcriptPath, {
		policy,
		cwd: cwdHint
	});
	try {
		onTranscriptOutcome?.(result.outcome);
	} catch {}
	return result.extraction;
}
var TRUSTED_HOOK_MAPPER_OPTIONS = { transcriptPolicy: TRUSTED_HOOK_TRANSCRIPT_POLICY };
function coerceSessionId(payload) {
	const raw = payload.session_id;
	if (typeof raw !== "string") return null;
	return raw.trim() || null;
}
/**
* Map a raw Claude Code hook payload to a normalized adapter event.
* Returns null if the event type is unsupported or required fields are missing.
*/
function mapClaudeHookPayload(payload, options) {
	const hookEvent = String(payload.hook_event_name ?? "").trim();
	if (!MAPPABLE_CLAUDE_HOOK_EVENTS.has(hookEvent)) return null;
	const sessionId = coerceSessionId(payload);
	if (!sessionId) return null;
	const normalizedRawTs = normalizeIsoTs(payload.ts ?? payload.timestamp);
	const ts = normalizedRawTs ?? nowIso();
	const toolUseId = String(payload.tool_use_id ?? "").trim();
	const consumed = /* @__PURE__ */ new Set([
		"hook_event_name",
		"session_id",
		"cwd",
		"ts",
		"timestamp",
		"transcript_path",
		"permission_mode",
		"tool_use_id"
	]);
	let eventType;
	let eventPayload;
	let eventIdPayload;
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
		const toolInput = payload.tool_input != null && typeof payload.tool_input === "object" && !Array.isArray(payload.tool_input) ? payload.tool_input : {};
		eventType = "tool_call";
		eventPayload = {
			tool_name: toolName,
			tool_input: toolInput
		};
		eventIdPayload = { ...eventPayload };
		consumed.add("tool_name");
		consumed.add("tool_input");
	} else if (hookEvent === "PostToolUse") {
		const toolName = String(payload.tool_name ?? "").trim();
		if (!toolName) return null;
		const toolInput = payload.tool_input != null && typeof payload.tool_input === "object" && !Array.isArray(payload.tool_input) ? payload.tool_input : {};
		const toolResponse = payload.tool_response ?? null;
		eventType = "tool_result";
		eventPayload = {
			tool_name: toolName,
			status: "ok",
			tool_input: toolInput,
			tool_output: toolResponse,
			tool_error: null
		};
		eventIdPayload = { ...eventPayload };
		consumed.add("tool_name");
		consumed.add("tool_input");
		consumed.add("tool_response");
	} else if (hookEvent === "PostToolUseFailure") {
		const toolName = String(payload.tool_name ?? "").trim();
		if (!toolName) return null;
		const toolInput = payload.tool_input != null && typeof payload.tool_input === "object" && !Array.isArray(payload.tool_input) ? payload.tool_input : {};
		const error = payload.error ?? null;
		eventType = "tool_result";
		eventPayload = {
			tool_name: toolName,
			status: "error",
			tool_input: toolInput,
			tool_output: null,
			error
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
			const [transcriptText, transcriptUsage] = extractFromTranscript(payload.transcript_path, cwd, options.transcriptPolicy, options.onTranscriptOutcome);
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
			if (typeof transcriptPath === "string" && transcriptPath.trim()) eventIdPayload.transcript_path = transcriptPath.trim();
		}
		consumed.add("stop_hook_active");
		consumed.add("last_assistant_message");
		consumed.add("usage");
	} else {
		eventType = "session_end";
		eventPayload = { reason: payload.reason ?? null };
		eventIdPayload = { ...eventPayload };
		consumed.add("reason");
	}
	const meta = {
		event_id_algo: CLAUDE_EVENT_ID_ALGO,
		hook_event_name: hookEvent,
		ordering_confidence: "low"
	};
	if (toolUseId) meta.tool_use_id = toolUseId;
	if (normalizedRawTs === null) meta.ts_normalized = "generated";
	const unknown = {};
	for (const [k, v] of Object.entries(payload)) if (!consumed.has(k)) unknown[k] = v;
	if (Object.keys(unknown).length > 0) meta.hook_fields = unknown;
	const eventId = stableEventId(sessionId, hookEvent, normalizedRawTs ?? ts, toolUseId, createHash("sha256").update(JSON.stringify(sortKeys(eventIdPayload), (_key, value) => {
		if (value === void 0) return "None";
		if (typeof value === "bigint") return String(value);
		return value;
	}), "utf-8").digest("hex"));
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
		meta
	};
}
/** Recursively sort object keys (matches Python's json.dumps(sort_keys=True)). */
function sortKeys(value) {
	if (value == null || typeof value !== "object" || Array.isArray(value)) return value;
	const sorted = {};
	for (const k of Object.keys(value).sort()) sorted[k] = sortKeys(value[k]);
	return sorted;
}
/**
* Build a raw event envelope from a Claude Code hook payload.
* Returns null if the payload is unsupported or missing required fields.
*/
function buildRawEventEnvelopeFromHook(hookPayload, options) {
	const adapterEvent = mapClaudeHookPayload(hookPayload, options);
	if (adapterEvent === null) return null;
	const sessionId = adapterEvent.session_id.trim();
	if (!sessionId) return null;
	const ts = adapterEvent.ts.trim();
	if (!ts) return null;
	const source = adapterEvent.source || "claude";
	const hookEventName = String(hookPayload.hook_event_name ?? "");
	const cwd = typeof hookPayload.cwd === "string" ? hookPayload.cwd : null;
	let project = resolveHookProject(cwd, hookPayload.project);
	if (project === null) project = resolveHookProjectFromPayloadPaths(hookPayload);
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
			_adapter: adapterEvent
		},
		ts_wall_ms: isoToWallMs(ts),
		cwd,
		project,
		started_at: hookEventName === "SessionStart" ? ts : null
	};
}
/**
* Build an ingest pipeline payload from a Claude Code hook payload.
* Used by the direct-ingest path (non-raw-event path).
* Returns null if the payload is unsupported.
*/
function buildIngestPayloadFromHook(hookPayload, options) {
	const adapterEvent = mapClaudeHookPayload(hookPayload, options);
	if (adapterEvent === null) return null;
	const sessionId = adapterEvent.session_id;
	return {
		cwd: hookPayload.cwd ?? null,
		events: [{
			type: "claude.hook",
			timestamp: adapterEvent.ts,
			_adapter: adapterEvent
		}],
		session_context: {
			source: "claude",
			stream_id: sessionId,
			session_stream_id: sessionId,
			session_id: sessionId,
			opencode_session_id: sessionId
		}
	};
}
//#endregion
export { CLAUDE_EVENT_ID_ALGO, MAPPABLE_CLAUDE_HOOK_EVENTS, TRUSTED_HOOK_MAPPER_OPTIONS, buildIngestPayloadFromHook, buildRawEventEnvelopeFromHook, extractFromTranscript, mapClaudeHookPayload, normalizeProjectLabel, resolveHookProject };
