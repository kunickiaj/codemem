/**
 * Session-state tracking for Claude Code hook commands.
 *
 * Persists per-session signal (first prompt, latest prompt, recently
 * modified files) to disk so that retrieval inside `claude-hook-inject`
 * can build a query richer than the bare current prompt and so that
 * file-locality boosts can target files the user just edited.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { extractApplyPatchPaths, MUTATING_TOOL_NAMES } from "@codemem/core";

export type SessionState = {
	first_prompt: string;
	last_prompt: string;
	files_modified: string[];
	updated_at: string;
};

const MAX_FILES_MODIFIED = 64;
const MAX_WORKING_SET_PATHS = 8;
const MAX_QUERY_CHARS = 500;
const MAX_QUERY_FILE_BASENAMES = 5;
const SESSION_FILE_LABEL_CHARS = 24;

function stableSessionSuffix(sessionId: string): string {
	let hash = 0xcbf29ce484222325n;
	for (const byte of Buffer.from(sessionId, "utf8")) {
		hash ^= BigInt(byte);
		hash = BigInt.asUintN(64, hash * 0x100000001b3n);
	}
	return hash.toString(16).padStart(16, "0");
}

export function defaultSessionState(): SessionState {
	return {
		first_prompt: "",
		last_prompt: "",
		files_modified: [],
		updated_at: "",
	};
}

function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	return value;
}

export function contextDir(): string {
	const override = process.env.CODEMEM_CLAUDE_HOOK_CONTEXT_DIR;
	return expandHome(override?.trim() ? override : "~/.codemem/claude-hook-context");
}

function sessionFileStem(sessionId: string): string {
	const trimmed = sessionId.trim();
	if (!trimmed) return "session-state";
	const label = trimmed
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, SESSION_FILE_LABEL_CHARS);
	return `${label || "session"}-${stableSessionSuffix(trimmed)}`;
}

export function statePathForSession(sessionId: string): string {
	return join(contextDir(), `${sessionFileStem(sessionId)}.json`);
}

/**
 * Normalize a prompt-shaped payload field: drop non-strings, trim
 * leading/trailing whitespace, and collapse newlines to spaces so that
 * prompts compared across the inject + ingest paths and across turns
 * within a session use the same canonical form.
 */
export function normalizePromptText(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.trim().replace(/\n/g, " ");
}

function normalizeStringList(value: unknown, cap: number): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim();
		if (trimmed) out.push(trimmed);
	}
	return out.slice(0, cap);
}

export function loadSessionState(sessionId: string): SessionState {
	const path = statePathForSession(sessionId);
	if (!existsSync(path)) return defaultSessionState();
	try {
		const raw = readFileSync(path, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return defaultSessionState();
		}
		const obj = parsed as Record<string, unknown>;
		return {
			first_prompt: typeof obj.first_prompt === "string" ? obj.first_prompt.trim() : "",
			last_prompt: typeof obj.last_prompt === "string" ? obj.last_prompt.trim() : "",
			files_modified: normalizeStringList(obj.files_modified, MAX_FILES_MODIFIED),
			updated_at: typeof obj.updated_at === "string" ? obj.updated_at.trim() : "",
		};
	} catch {
		return defaultSessionState();
	}
}

function nowIso(): string {
	return new Date().toISOString();
}

export function saveSessionState(sessionId: string, state: SessionState): void {
	const dir = contextDir();
	mkdirSync(dir, { recursive: true });
	const path = statePathForSession(sessionId);
	const tmpPath = `${path}.tmp`;
	const payload = {
		first_prompt: String(state.first_prompt ?? ""),
		last_prompt: String(state.last_prompt ?? ""),
		files_modified: normalizeStringList(state.files_modified, MAX_FILES_MODIFIED),
		updated_at: String(state.updated_at ?? ""),
	};
	writeFileSync(tmpPath, JSON.stringify(payload), { encoding: "utf8" });
	renameSync(tmpPath, path);
}

export function clearSessionState(sessionId: string): void {
	const path = statePathForSession(sessionId);
	try {
		rmSync(path, { force: true });
	} catch {
		// best-effort: failure to clear an unreachable file is non-fatal
	}
}

export function extractModifiedPathsFromHook(payload: Record<string, unknown>): string[] {
	const toolName = String(payload.tool_name ?? "")
		.trim()
		.toLowerCase();
	if (!MUTATING_TOOL_NAMES.has(toolName)) return [];

	const toolInput = payload.tool_input;
	if (toolInput == null || typeof toolInput !== "object" || Array.isArray(toolInput)) {
		return [];
	}
	const obj = toolInput as Record<string, unknown>;

	const collected: string[] = [];
	for (const key of ["filePath", "file_path", "path"]) {
		const value = obj[key];
		if (typeof value === "string") {
			const trimmed = value.trim();
			if (trimmed) collected.push(trimmed);
		}
	}
	if (toolName === "apply_patch") {
		// `patchText` is the canonical key, but some agents send an empty
		// `patchText` alongside the real patch in `patch`. Use a falsy
		// fallback (not `??`) so an empty `patchText` doesn't shadow it.
		const primary =
			typeof obj.patchText === "string" && obj.patchText.trim() ? obj.patchText : null;
		const patchText = primary ?? (typeof obj.patch === "string" ? obj.patch : null);
		if (patchText?.trim()) {
			collected.push(...extractApplyPatchPaths(patchText));
		}
	}

	const seen = new Set<string>();
	const ordered: string[] = [];
	for (const path of collected) {
		if (seen.has(path)) continue;
		seen.add(path);
		ordered.push(path);
	}
	return ordered;
}

/**
 * Update the on-disk session state for a hook payload and return the
 * resulting state. Returns null when the payload has no usable session_id
 * or when SessionEnd just cleared the state. Failures are swallowed —
 * hook commands must never crash on state I/O errors.
 */
export function trackHookSessionState(payload: Record<string, unknown>): SessionState | null {
	const sessionRaw = payload.session_id;
	if (typeof sessionRaw !== "string") return null;
	const sessionId = sessionRaw.trim();
	if (!sessionId) return null;

	const hookEventName =
		typeof payload.hook_event_name === "string" ? payload.hook_event_name.trim() : "";

	if (hookEventName === "SessionEnd") {
		clearSessionState(sessionId);
		return null;
	}

	const state = loadSessionState(sessionId);
	let changed = false;

	if (hookEventName === "UserPromptSubmit") {
		const prompt = normalizePromptText(payload.prompt);
		if (prompt) {
			if (!state.first_prompt) {
				state.first_prompt = prompt;
				changed = true;
			}
			if (state.last_prompt !== prompt) {
				state.last_prompt = prompt;
				changed = true;
			}
		}
	} else if (hookEventName === "PostToolUse" || hookEventName === "PostToolUseFailure") {
		const existing = state.files_modified.filter((path) => path.trim().length > 0);
		const seen = new Set(existing);
		for (const path of extractModifiedPathsFromHook(payload)) {
			if (seen.has(path)) continue;
			existing.push(path);
			seen.add(path);
			changed = true;
		}
		state.files_modified = existing.slice(-MAX_FILES_MODIFIED);
	}

	if (changed) {
		state.updated_at = nowIso();
		try {
			saveSessionState(sessionId, state);
		} catch {
			// best-effort: dropping a state update is preferable to crashing the hook
		}
	}
	return state;
}

function pathBasename(value: string): string {
	const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
	if (!normalized) return "";
	const parts = normalized.split("/");
	return parts[parts.length - 1] ?? "";
}

/**
 * Compose a retrieval query that combines the original session intent,
 * the current prompt, the project, and recent modified file basenames.
 * Caps the result at 500 characters.
 */
export function buildInjectQuery(args: {
	prompt: string;
	project: string | null;
	state: SessionState | null;
}): string {
	const parts: string[] = [];
	const firstPrompt = args.state ? normalizePromptText(args.state.first_prompt) : "";
	const filesModified = args.state
		? args.state.files_modified.filter((item) => item.trim().length > 0)
		: [];

	if (firstPrompt) parts.push(firstPrompt);
	if (args.prompt && args.prompt !== firstPrompt && args.prompt.length > 5) {
		parts.push(args.prompt);
	}
	if (args.project) parts.push(args.project);
	if (filesModified.length > 0) {
		const names = filesModified
			.slice(-MAX_QUERY_FILE_BASENAMES)
			.map(pathBasename)
			.filter((name) => name.length > 0);
		if (names.length > 0) parts.push(names.join(" "));
	}

	if (parts.length === 0) return "recent work";
	const query = parts.join(" ");
	return query.length > MAX_QUERY_CHARS ? query.slice(0, MAX_QUERY_CHARS) : query;
}

/** Return the working set paths (last N modified files) for pack filters. */
export function workingSetPathsFromState(state: SessionState | null): string[] {
	if (!state) return [];
	const files = state.files_modified.filter((path) => path.trim().length > 0);
	return files.slice(-MAX_WORKING_SET_PATHS);
}
