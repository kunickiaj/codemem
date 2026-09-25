/**
 * @codemem/pi-extension — pi coding-agent extension factory.
 *
 * Lifecycle (pi enforced):
 *   - Factory body wires handlers only. No sockets/timers/watchers/child processes.
 *   - Viewer auto-start begins on session_start (or first need).
 *   - Idempotent cleanup on session_shutdown.
 *   - Re-key session state from ctx.sessionManager.getSessionId() every session_start.
 *   - Durable ingest cursors via pi.appendEntry.
 *
 * Surfaces:
 *   - Ingest → POST /api/pi-hooks → CLI pi-hook-ingest
 *   - Injection → before_agent_start systemPrompt append only (never message)
 *   - Tools → pi.registerTool × 15 when pi.tools_mode === "native"
 *   - session_before_compact → flush signal only (never return compaction)
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
	SessionBeforeCompactEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	ToolCallEvent,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
	CLI_PACK_TIMEOUT_MS,
	type ExecCodememFn,
	type IngestOutcome,
	type PackFetch,
	PiCodememClient,
} from "./client.js";
import { loadPiExtensionConfig, type PiExtensionConfig } from "./config.js";
import {
	buildBeforeCompactPayload,
	buildMessageEndPayload,
	buildSessionShutdownPayload,
	buildSessionStartPayload,
	buildToolCallPayload,
	buildToolResultPayload,
	extractMessageRole,
	extractMessageText,
	formatPiInjectionBlock,
	type PiHookPayload,
	serializeToolOutput,
	stableMessageEntryId,
} from "./payloads.js";
import { registerMemoryTools } from "./tools.js";
import { createViewerRuntime, stopViewerTracking, type ViewerRuntime } from "./viewer.js";

/** Test-only CLI override. Null in production. */
let testExecImpl: ExecCodememFn | null = null;

/** @internal test helper — inject codemem CLI behavior without spawning. */
export function __setTestExecImpl(fn: ExecCodememFn | null): void {
	testExecImpl = fn;
}

const CURSOR_CUSTOM_TYPE = "codemem.cursor";
const CURSOR_VERSION = 1;

/** Flush-only signals — never durable-deduped; unique per firing. */
const PI_FLUSH_ONLY_EVENTS = new Set(["session_before_compact"]);

type CursorState = {
	sessionId: string;
	seenEventKeys: string[];
};

type SessionState = {
	sessionId: string | null;
	cwd: string;
	project: string | null;
	active: boolean;
	seenEventKeys: Set<string>;
	/** Monotonic counter for unique flush-only compact entry ids. */
	compactSeq: number;
	/**
	 * Monotonic counter for message_end entry ids when the ending message has no
	 * usable timestamp. Distinguishes intentional identical prompts in-session.
	 * Never a content-only hash — always paired with a discriminator.
	 */
	messageSeq: number;
	/** toolCallId → { toolName, input } for pairing results */
	toolCalls: Map<string, { toolName: string; input: Record<string, unknown> }>;
};

function createSessionState(): SessionState {
	return {
		sessionId: null,
		cwd: process.cwd(),
		project: null,
		active: false,
		seenEventKeys: new Set(),
		compactSeq: 0,
		messageSeq: 0,
		toolCalls: new Map(),
	};
}

function isFlushOnlyPayload(payload: PiHookPayload): boolean {
	const piEvent = typeof payload.piEvent === "string" ? payload.piEvent.trim() : "";
	return PI_FLUSH_ONLY_EVENTS.has(piEvent);
}

function eventKey(payload: PiHookPayload): string {
	const sessionId = String(payload.sessionId ?? "");
	const piEvent = String(payload.piEvent ?? "");
	const entryId = String(payload.entryId ?? "");
	const toolCallId = String(payload.toolCallId ?? "");
	const role = String(payload.role ?? "");
	return `${sessionId}|${piEvent}|${entryId}|${toolCallId}|${role}`;
}

function loadCursorsFromSession(ctx: ExtensionContext, sessionId: string): Set<string> {
	const seen = new Set<string>();
	try {
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom") continue;
			const custom = entry as { customType?: string; data?: unknown };
			if (custom.customType !== CURSOR_CUSTOM_TYPE) continue;
			addCursorKeys(custom.data, sessionId, seen);
		}
	} catch {
		// getEntries may throw on ephemeral sessions
	}
	return seen;
}

function persistCursor(pi: ExtensionAPI, sessionId: string, seenEventKeys: Set<string>): void {
	// Cap growth — keep the most recent keys only.
	const keys = [...seenEventKeys];
	const trimmed = keys.length > 500 ? keys.slice(keys.length - 500) : keys;
	try {
		pi.appendEntry(CURSOR_CUSTOM_TYPE, {
			v: CURSOR_VERSION,
			sessionId,
			seenEventKeys: trimmed,
			ts: new Date().toISOString(),
		});
	} catch {
		// best-effort persistence
	}
}

async function safeIngest(
	client: PiCodememClient,
	payload: PiHookPayload,
	state: SessionState,
	pi: ExtensionAPI,
	signal?: AbortSignal,
): Promise<void> {
	if (!state.active || !state.sessionId) return;
	const flushOnly = isFlushOnlyPayload(payload);
	const key = eventKey(payload);
	// Flush signals fire every compaction — never suppress via seen cursor.
	if (!flushOnly && state.seenEventKeys.has(key)) return;
	try {
		const outcome: IngestOutcome = await client.ingest(payload, signal);
		// Mark seen + durable cursor ONLY after successful delivery. A failed
		// attempt must remain unmarked so the next delivery (or session_start
		// resume without a stale cursor entry) can retry.
		if (!outcome.ok) return;
		if (flushOnly) return;
		state.seenEventKeys.add(key);
		persistCursor(pi, state.sessionId, state.seenEventKeys);
	} catch {
		// fail-open: never break the pi session; leave unseen on throw
	}
}

/** Resolve pi agent dir (~/.pi/agent), honoring PI_CODING_AGENT_DIR. */
function resolvePiAgentDirForMcp(): string {
	const fromEnv = process.env.PI_CODING_AGENT_DIR?.trim();
	if (fromEnv) {
		if (fromEnv.startsWith("~/")) return join(homedir(), fromEnv.slice(2));
		return isAbsolute(fromEnv) ? fromEnv : join(homedir(), fromEnv);
	}
	return join(homedir(), ".pi", "agent");
}

function mcpJsonHasCodememEntry(path: string): boolean {
	if (!existsSync(path)) return false;
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
		const servers = (parsed as Record<string, unknown>).mcpServers;
		if (servers == null || typeof servers !== "object" || Array.isArray(servers)) return false;
		return Object.hasOwn(servers as object, "codemem");
	} catch {
		return false;
	}
}

/**
 * D6: when native tools are registered but a codemem mcp.json entry also exists,
 * warn once so the user can pick a single surface via pi.tools_mode.
 */
function warnDuplicateToolSurface(ctx: ExtensionContext, cwd: string): void {
	try {
		const candidates = [join(resolvePiAgentDirForMcp(), "mcp.json"), join(cwd, ".pi", "mcp.json")];
		const hit = candidates.some((p) => mcpJsonHasCodememEntry(p));
		if (!hit) return;
		const msg =
			'codemem: both native tools and an mcp.json codemem entry are present. Pick one surface: set pi.tools_mode to "mcp-adapter" (or CODEMEM_PI_TOOLS_MODE=mcp-adapter) to use MCP only, or remove the codemem entry from mcp.json to keep native tools.';
		try {
			const ui = (ctx as { ui?: { notify?: (m: string) => void } }).ui;
			if (ui && typeof ui.notify === "function") {
				ui.notify(msg);
				return;
			}
		} catch {
			// fall through to console
		}
		console.warn(msg);
	} catch {
		// best-effort; never break session_start
	}
}

function resolveProject(cwd: string, envProject?: string | null): string | null {
	const fromEnv = envProject?.trim() || process.env.CODEMEM_PROJECT?.trim();
	if (fromEnv) return fromEnv;
	return PiCodememClient.projectFromCwd(cwd);
}

function readPathFromToolInput(input: Record<string, unknown>): string | null {
	for (const key of ["path", "file_path", "filePath"]) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return null;
}
/**
 * Runtime tool_result content may arrive as an array (declared type) or as a
 * plain string. Normalize to text blocks before appending file context so a
 * string body is never dropped (maintainer blocker #2).
 */
function normalizeToolResultContent(content: unknown): Array<{ type: "text"; text: string }> {
	if (typeof content === "string" && content) return [{ type: "text", text: content }];
	if (Array.isArray(content)) return content as Array<{ type: "text"; text: string }>;
	return [];
}

function addCursorKeys(data: unknown, sessionId: string, seen: Set<string>): void {
	const cursor = data as CursorState | undefined;
	if (!cursor || cursor.sessionId !== sessionId) return;
	if (!Array.isArray(cursor.seenEventKeys)) return;
	for (const key of cursor.seenEventKeys) {
		if (typeof key === "string" && key) seen.add(key);
	}
}

async function fileContextAppend(
	client: PiCodememClient,
	config: PiExtensionConfig,
	event: ToolResultEvent,
	toolName: string,
	toolInput: Record<string, unknown>,
	signal?: AbortSignal,
) {
	if (!config.fileContext || toolName !== "read" || event.isError) return;
	const filePath = readPathFromToolInput(toolInput);
	if (!filePath) return;
	try {
		const fileCtx = await fetchFileContextBlock(client, filePath, signal);
		if (!fileCtx.text.trim()) return;
		const block = fileCtx.preformatted ? fileCtx.text : formatPiInjectionBlock(fileCtx.text, 4_000);
		const existing = normalizeToolResultContent(event.content);
		return { content: [...existing, { type: "text" as const, text: `\n\n${block}` }] };
	} catch {
		return;
	}
}

async function systemPromptInjection(
	client: PiCodememClient,
	config: PiExtensionConfig,
	event: BeforeAgentStartEvent,
	signal?: AbortSignal,
): Promise<{ systemPrompt: string } | undefined> {
	if (!config.injectPrompts) return;
	try {
		const prompt = typeof event.prompt === "string" ? event.prompt : "";
		if (!prompt.trim()) return;
		const packFetch = await client.fetchPackText(prompt, signal);
		if (!packFetch.text.trim()) return;
		const block = packFetch.preformatted
			? packFetch.text
			: formatPiInjectionBlock(packFetch.text, config.injectMaxChars);
		if (!block.trim()) return;
		const base = typeof event.systemPrompt === "string" ? event.systemPrompt : "";
		return { systemPrompt: base ? `${base}\n\n${block}` : block };
	} catch {
		return;
	}
}

async function onSessionStart(
	state: SessionState,
	client: PiCodememClient,
	config: PiExtensionConfig,
	pi: ExtensionAPI,
	event: SessionStartEvent,
	ctx: ExtensionContext,
): Promise<void> {
	const sessionId = ctx.sessionManager.getSessionId();
	const cwd = ctx.cwd || process.cwd();
	const project = resolveProject(cwd);
	state.sessionId = sessionId;
	state.cwd = cwd;
	state.project = project;
	state.active = true;
	state.toolCalls.clear();
	state.seenEventKeys = loadCursorsFromSession(ctx, sessionId);
	client.rekey(sessionId, cwd, project);
	if (config.toolsMode === "native") {
		warnDuplicateToolSurface(ctx, cwd);
	}
	void client.ensureViewer(ctx.signal).catch(() => {});
	const payload = buildSessionStartPayload({
		sessionId,
		cwd,
		project,
		reason: event.reason,
	});
	await safeIngest(client, payload, state, pi, ctx.signal);
}

async function onSessionShutdown(
	state: SessionState,
	client: PiCodememClient,
	runtime: ViewerRuntime,
	pi: ExtensionAPI,
	event: SessionShutdownEvent,
	ctx: ExtensionContext,
): Promise<void> {
	const sessionId = state.sessionId ?? ctx.sessionManager.getSessionId();
	if (sessionId) {
		const payload = buildSessionShutdownPayload({
			sessionId,
			cwd: state.cwd || ctx.cwd,
			project: state.project,
			reason: event.reason,
		});
		await safeIngest(client, payload, { ...state, active: true, sessionId }, pi, ctx.signal);
	}
	state.active = false;
	state.toolCalls.clear();
	stopViewerTracking(runtime);
}

function messageDiscriminator(
	state: SessionState,
	message: { timestamp?: unknown },
): string | number {
	if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
		return message.timestamp;
	}
	state.messageSeq += 1;
	return `n:${state.messageSeq}`;
}

async function onMessageEnd(
	state: SessionState,
	client: PiCodememClient,
	pi: ExtensionAPI,
	event: MessageEndEvent,
	ctx: ExtensionContext,
): Promise<void> {
	if (!state.active || !state.sessionId) return;
	const role = extractMessageRole(event.message);
	if (role !== "user" && role !== "assistant") return;
	const text = extractMessageText(event.message);
	if (!text) return;
	const discriminator = messageDiscriminator(state, event.message as { timestamp?: unknown });
	const entryId = stableMessageEntryId(state.sessionId, role, text, discriminator);
	const payload = buildMessageEndPayload({
		sessionId: state.sessionId,
		cwd: state.cwd || ctx.cwd,
		project: state.project,
		entryId,
		role,
		text,
	});
	if (!payload) return;
	await safeIngest(client, payload, state, pi, ctx.signal);
}

async function onToolCall(
	state: SessionState,
	client: PiCodememClient,
	pi: ExtensionAPI,
	event: ToolCallEvent,
	ctx: ExtensionContext,
): Promise<void> {
	if (!state.active || !state.sessionId) return;
	const toolName = event.toolName;
	const toolCallId = event.toolCallId;
	const toolInput =
		event.input != null && typeof event.input === "object"
			? (event.input as Record<string, unknown>)
			: {};
	state.toolCalls.set(toolCallId, { toolName, input: toolInput });
	const payload = buildToolCallPayload({
		sessionId: state.sessionId,
		cwd: state.cwd || ctx.cwd,
		project: state.project,
		toolCallId,
		toolName,
		toolInput,
	});
	await safeIngest(client, payload, state, pi, ctx.signal);
}

async function onToolResult(
	state: SessionState,
	client: PiCodememClient,
	config: PiExtensionConfig,
	pi: ExtensionAPI,
	event: ToolResultEvent,
	ctx: ExtensionContext,
) {
	if (!state.active || !state.sessionId) return;
	const tracked = state.toolCalls.get(event.toolCallId);
	const toolName = event.toolName;
	const toolInput =
		event.input != null && typeof event.input === "object"
			? (event.input as Record<string, unknown>)
			: (tracked?.input ?? {});
	state.toolCalls.delete(event.toolCallId);
	const payload = buildToolResultPayload({
		sessionId: state.sessionId,
		cwd: state.cwd || ctx.cwd,
		project: state.project,
		toolCallId: event.toolCallId,
		toolName,
		toolInput,
		toolOutput: serializeToolOutput(event.content),
		isError: Boolean(event.isError),
		error: event.isError ? serializeToolOutput(event.content) : null,
	});
	await safeIngest(client, payload, state, pi, ctx.signal);
	return fileContextAppend(client, config, event, toolName, toolInput, ctx.signal);
}

async function onBeforeCompact(
	state: SessionState,
	client: PiCodememClient,
	pi: ExtensionAPI,
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
): Promise<void> {
	if (!state.sessionId) return;
	state.compactSeq += 1;
	const payload = buildBeforeCompactPayload({
		sessionId: state.sessionId,
		cwd: state.cwd || ctx.cwd,
		project: state.project,
		reason: event.reason,
		entryId: `session_before_compact:${state.compactSeq}`,
	});
	await safeIngest(client, payload, state, pi, event.signal ?? ctx.signal);
}

/**
 * Extension factory. Default export required by pi package loader.
 */
export default function codememPiExtension(pi: ExtensionAPI): void {
	const config: PiExtensionConfig = loadPiExtensionConfig();
	const runtime: ViewerRuntime = createViewerRuntime();
	const state = createSessionState();
	const client = new PiCodememClient(config, runtime, {
		cwd: state.cwd,
		project: state.project,
		sessionId: state.sessionId,
		execImpl: testExecImpl,
	});

	// Native tools only when not in mcp-adapter mode (D6).
	if (config.toolsMode === "native") {
		registerMemoryTools(pi, client);
	}

	pi.on("session_start", (event, ctx) => onSessionStart(state, client, config, pi, event, ctx));
	pi.on("session_shutdown", (event, ctx) =>
		onSessionShutdown(state, client, runtime, pi, event, ctx),
	);
	pi.on("message_end", (event, ctx) => onMessageEnd(state, client, pi, event, ctx));
	pi.on("tool_call", (event, ctx) => onToolCall(state, client, pi, event, ctx));
	pi.on("tool_result", (event, ctx) => onToolResult(state, client, config, pi, event, ctx));
	pi.on("session_before_compact", (event, ctx) => onBeforeCompact(state, client, pi, event, ctx));
	pi.on("before_agent_start", (event, ctx) =>
		systemPromptInjection(client, config, event, ctx.signal),
	);
}

/**
 * Best-effort file context via claude-hook-file-context CLI (same store query)
 * or a small pack keyed on the path.
 */
async function fetchFileContextBlock(
	client: PiCodememClient,
	filePath: string,
	signal?: AbortSignal,
): Promise<PackFetch> {
	try {
		const { stdout } = await client.execCodemem(["claude-hook-file-context"], {
			stdin: JSON.stringify({
				tool_input: { file_path: filePath },
				cwd: client.cwd,
			}),
			signal,
			timeoutMs: CLI_PACK_TIMEOUT_MS,
		});
		const trimmed = stdout.trim();
		if (trimmed) {
			try {
				const parsed = JSON.parse(trimmed) as {
					hookSpecificOutput?: { additionalContext?: string };
				};
				const ctx = parsed.hookSpecificOutput?.additionalContext?.trim();
				if (ctx) return { text: ctx, preformatted: false };
			} catch {
				// not JSON
			}
		}
	} catch {
		// fall through
	}

	try {
		return await client.fetchPackText(filePath, signal);
	} catch {
		return { text: "", preformatted: false };
	}
}

export { errorResult, jsonResult, PiCodememClient, textResult } from "./client.js";
// Named exports for tests / advanced hosts.
export { defaultPiExtensionConfig, loadPiExtensionConfig } from "./config.js";
export { MEMORY_LEARN_PAYLOAD } from "./learn.js";
export {
	buildBeforeCompactPayload,
	buildMessageEndPayload,
	buildSessionShutdownPayload,
	buildSessionStartPayload,
	buildToolCallPayload,
	buildToolResultPayload,
	CODEMEM_MEMORIES_HEADER,
	extractMessageRole,
	extractMessageText,
	formatPiInjectionBlock,
	stableMessageEntryId,
} from "./payloads.js";
export { expectedToolNames, registerMemoryTools } from "./tools.js";
