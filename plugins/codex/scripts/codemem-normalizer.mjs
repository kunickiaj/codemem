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
function normalizeUsage(value) {
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
		return text ? [text, normalizeUsage(usageValue)] : null;
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
/** Expand `~/...` paths like Python's `Path(...).expanduser()`. */
function expandUser(value) {
	return value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value;
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
//#endregion
//#region packages/core/src/codex-hooks.ts
/**
* Codex hook payload mapping.
*
* Normalizes Codex plugin hook payloads into AdapterEvent v1 envelopes for
* the shared raw-event sweeper pipeline.
*/
var MAPPABLE_CODEX_HOOK_EVENTS = /* @__PURE__ */ new Set([
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"Stop"
]);
/** Frozen discriminator for Codex's derived event identity contract. */
var CODEX_EVENT_ID_ALGO = "codex/1";
function nowIso() {
	return (/* @__PURE__ */ new Date()).toISOString().replace(/\.(\d{3})\d*Z$/, ".$1Z");
}
function normalizeIsoTs(value) {
	if (typeof value !== "string") return null;
	const text = value.trim();
	if (!text) return null;
	const hasTimezone = /[Zz]$/.test(text) || /[+-]\d{2}:\d{2}$/.test(text) || /[+-]\d{4}$/.test(text);
	const parsed = new Date(hasTimezone ? text : `${text}Z`);
	if (Number.isNaN(parsed.getTime())) return null;
	return /\.\d+([Zz+-]|$)/.test(text) ? parsed.toISOString().replace(/\.(\d{3})Z$/, ".$1000Z") : parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
}
function isoToWallMs(value) {
	return new Date(value).getTime();
}
function stableEventId(...parts) {
	return `cdx_evt_${createHash("sha256").update(parts.join("|"), "utf-8").digest("hex").slice(0, 24)}`;
}
function coerceString(value) {
	return typeof value === "string" ? value.trim() : "";
}
function coerceSessionId(payload) {
	return coerceString(payload.session_id) || null;
}
function objectOrEmpty(value) {
	return value != null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function sortKeys(value) {
	if (value == null || typeof value !== "object" || Array.isArray(value)) return value;
	const sorted = {};
	for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(value[key]);
	return sorted;
}
function mapCodexHookPayload(payload, options) {
	const hookEvent = coerceString(payload.hook_event_name);
	if (!MAPPABLE_CODEX_HOOK_EVENTS.has(hookEvent)) return null;
	const sessionId = coerceSessionId(payload);
	if (!sessionId) return null;
	const normalizedRawTs = normalizeIsoTs(payload.ts ?? payload.timestamp);
	const ts = normalizedRawTs ?? nowIso();
	const generatedEventNonce = coerceString(payload.codemem_generated_event_nonce);
	const toolUseId = coerceString(payload.tool_use_id);
	const turnId = coerceString(payload.turn_id);
	const consumed = /* @__PURE__ */ new Set([
		"hook_event_name",
		"session_id",
		"cwd",
		"ts",
		"timestamp",
		"transcript_path",
		"permission_mode",
		"codemem_generated_event_nonce",
		"tool_use_id",
		"turn_id",
		"model",
		"subagent"
	]);
	let eventType;
	let eventPayload;
	let eventIdPayload;
	let contentAnchoredEventId = false;
	if (hookEvent === "SessionStart") {
		const target = objectOrEmpty(payload.target);
		const source = payload.source ?? target.source ?? null;
		eventType = "session_start";
		eventPayload = {
			source,
			target: Object.keys(target).length ? target : null
		};
		eventIdPayload = { ...eventPayload };
		consumed.add("source");
		consumed.add("target");
	} else if (hookEvent === "UserPromptSubmit") {
		const text = coerceString(payload.prompt);
		if (!text) return null;
		eventType = "prompt";
		eventPayload = { text };
		eventIdPayload = { ...eventPayload };
		consumed.add("prompt");
	} else if (hookEvent === "PreToolUse") {
		const toolName = coerceString(payload.tool_name);
		if (!toolName) return null;
		const toolInput = objectOrEmpty(payload.tool_input);
		eventType = "tool_call";
		eventPayload = {
			tool_name: toolName,
			tool_input: toolInput
		};
		eventIdPayload = { ...eventPayload };
		consumed.add("tool_name");
		consumed.add("tool_input");
		consumed.add("matcher_aliases");
	} else if (hookEvent === "PostToolUse") {
		const toolName = coerceString(payload.tool_name);
		if (!toolName) return null;
		const toolInput = objectOrEmpty(payload.tool_input);
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
		consumed.add("matcher_aliases");
	} else {
		const rawAssistantText = coerceString(payload.last_assistant_message);
		let assistantText = rawAssistantText;
		if (!assistantText) {
			const cwd = typeof payload.cwd === "string" ? payload.cwd : null;
			const [transcriptText] = extractFromTranscript(payload.transcript_path, cwd, options.transcriptPolicy, options.onTranscriptOutcome);
			if (transcriptText) assistantText = transcriptText.trim();
		}
		if (!assistantText) return null;
		eventType = "assistant";
		eventPayload = { text: assistantText };
		contentAnchoredEventId = true;
		if (rawAssistantText) eventIdPayload = { text: rawAssistantText };
		else {
			const transcriptPath = coerceString(payload.transcript_path);
			eventIdPayload = transcriptPath ? { transcript_path: transcriptPath } : { text: assistantText };
		}
		consumed.add("stop_hook_active");
		consumed.add("last_assistant_message");
		consumed.add("target");
	}
	const meta = {
		event_id_algo: CODEX_EVENT_ID_ALGO,
		hook_event_name: hookEvent,
		ordering_confidence: "low"
	};
	if (toolUseId) meta.tool_use_id = toolUseId;
	if (turnId) meta.turn_id = turnId;
	if (normalizedRawTs === null) meta.ts_normalized = "generated";
	const unknown = {};
	for (const [key, value] of Object.entries(payload)) if (!consumed.has(key)) unknown[key] = value;
	if (Object.keys(unknown).length > 0) meta.hook_fields = unknown;
	const payloadHash = createHash("sha256").update(JSON.stringify(sortKeys(eventIdPayload)), "utf-8").digest("hex");
	const eventId = stableEventId(sessionId, hookEvent, normalizedRawTs ?? (contentAnchoredEventId ? "" : ts), turnId, toolUseId, contentAnchoredEventId ? "" : generatedEventNonce, payloadHash);
	const cwd = typeof payload.cwd === "string" ? payload.cwd : null;
	return {
		schema_version: "1.0",
		source: "codex",
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
function buildRawEventEnvelopeFromCodexHook(hookPayload, options) {
	const adapterEvent = mapCodexHookPayload(hookPayload, options);
	if (adapterEvent === null) return null;
	const sessionId = adapterEvent.session_id.trim();
	if (!sessionId) return null;
	const ts = adapterEvent.ts.trim();
	if (!ts) return null;
	const cwd = typeof hookPayload.cwd === "string" ? hookPayload.cwd : null;
	const project = resolveHookProject(cwd, hookPayload.project) ?? normalizeProjectLabel(hookPayload.project);
	const hookEventName = coerceString(hookPayload.hook_event_name);
	return {
		session_stream_id: sessionId,
		session_id: sessionId,
		opencode_session_id: sessionId,
		source: "codex",
		event_id: adapterEvent.event_id,
		event_type: "codex.hook",
		payload: {
			type: "codex.hook",
			timestamp: ts,
			_adapter: adapterEvent
		},
		ts_wall_ms: isoToWallMs(ts),
		cwd,
		project,
		started_at: hookEventName === "SessionStart" ? ts : null
	};
}
function buildIngestPayloadFromCodexHook(hookPayload, options) {
	const adapterEvent = mapCodexHookPayload(hookPayload, options);
	if (adapterEvent === null) return null;
	const sessionId = adapterEvent.session_id;
	return {
		cwd: hookPayload.cwd ?? null,
		events: [{
			type: "codex.hook",
			timestamp: adapterEvent.ts,
			_adapter: adapterEvent
		}],
		session_context: {
			source: "codex",
			stream_id: sessionId,
			session_stream_id: sessionId,
			session_id: sessionId,
			opencode_session_id: sessionId
		}
	};
}
//#endregion
export { CODEX_EVENT_ID_ALGO, MAPPABLE_CODEX_HOOK_EVENTS, TRUSTED_HOOK_MAPPER_OPTIONS, buildIngestPayloadFromCodexHook, buildRawEventEnvelopeFromCodexHook, mapCodexHookPayload };
