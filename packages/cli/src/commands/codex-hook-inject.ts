import { MemoryStore, resolveDbPath, resolveHookProject } from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import { addDbOption, type DbOpts, resolveDbOpt } from "../shared-options.js";
import { logHookEvent } from "./claude-hook-plugin-log.js";
import { normalizePromptText } from "./claude-hook-session-state.js";

type InjectResult = {
	continue: true;
	hookSpecificOutput?: {
		hookEventName: "UserPromptSubmit";
		additionalContext: string;
	};
};

export type CodexPackResult = {
	packText: string;
	items: number;
	packTokens: number;
};

type HttpPackResponse = {
	pack_text?: string;
	items?: unknown;
	metrics?: { pack_tokens?: unknown };
};

type InjectDeps = {
	buildLocalPack?: typeof buildLocalPack;
	httpPack?: typeof tryHttpPack;
	resolveDb?: typeof resolveDbPath;
};

const HOOK_EVENT_NAME = "UserPromptSubmit" as const;
const EMPTY_PACK: CodexPackResult = { packText: "", items: 0, packTokens: 0 };
const DEFAULT_VIEWER_HOST = "127.0.0.1";
const DEFAULT_VIEWER_PORT = 38888;
const DEFAULT_MAX_CHARS = 16000;
const DEFAULT_HTTP_MAX_TIME_S = 2;

function emitJson(value: InjectResult): void {
	console.log(JSON.stringify(value));
}

function emitError(value: { error: string; message: string }): void {
	process.stderr.write(`${JSON.stringify(value)}\n`);
}

function envNotDisabled(value: string | undefined): boolean {
	const normalized = String(value ?? "")
		.trim()
		.toLowerCase();
	return normalized !== "0" && normalized !== "false" && normalized !== "off";
}

function envTruthy(value: string | undefined): boolean {
	const normalized = String(value ?? "")
		.trim()
		.toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function continueResult(additionalContext?: string): InjectResult {
	if (!additionalContext) return { continue: true };
	return {
		continue: true,
		hookSpecificOutput: {
			hookEventName: HOOK_EVENT_NAME,
			additionalContext,
		},
	};
}

function truncateAdditionalContext(text: string, maxChars: number): string {
	const normalized = text.trim();
	if (!normalized) return "";
	if (!Number.isFinite(maxChars) || maxChars <= 0 || normalized.length <= maxChars) {
		return normalized;
	}
	return `${normalized.slice(0, maxChars).trimEnd()}\n\n[pack truncated]`;
}

function resolveInjectProject(payload: Record<string, unknown>): string | null {
	const cwd = typeof payload.cwd === "string" ? payload.cwd : null;
	return resolveHookProject(cwd, payload.project);
}

// Codex injection intentionally uses a simpler query than the Claude path:
// just the current prompt plus project. Claude's first/last-prompt and
// working-set-file enrichment depends on the Claude hook session-state tracker,
// which Codex does not maintain. Keep this lean unless a Codex session-state
// store is added; don't copy the Claude working-set machinery back in by reflex.
function buildCodexInjectQuery(prompt: string, project: string | null): string {
	const parts = [prompt, project ?? ""].filter((part) => part.trim().length > 0);
	return parts.join(" ").slice(0, 500) || "recent work";
}

async function buildLocalPack(
	context: string,
	project: string | null,
	dbPath: string,
): Promise<CodexPackResult> {
	const store = new MemoryStore(dbPath);
	try {
		const limit = parsePositiveInt(process.env.CODEMEM_INJECT_LIMIT, 8);
		const budget = parsePositiveInt(process.env.CODEMEM_INJECT_TOKEN_BUDGET, 800);
		const filters: { project?: string } = {};
		if (project) filters.project = project;
		const pack = await store.buildMemoryPackAsync(context, limit, budget, filters);
		return {
			packText: String(pack.pack_text ?? "").trim(),
			items: Array.isArray(pack.items) ? pack.items.length : 0,
			packTokens: Number.isFinite(Number(pack.metrics?.pack_tokens))
				? Number(pack.metrics?.pack_tokens)
				: 0,
		};
	} finally {
		store.close();
	}
}

async function tryHttpPack(
	context: string,
	project: string | null,
	maxTimeMs = DEFAULT_HTTP_MAX_TIME_S * 1000,
): Promise<CodexPackResult> {
	const host = process.env.CODEMEM_VIEWER_HOST || DEFAULT_VIEWER_HOST;
	const port = parsePositiveInt(process.env.CODEMEM_VIEWER_PORT, DEFAULT_VIEWER_PORT);
	const url = new URL(`http://${host}:${port}/api/pack`);
	url.searchParams.set("context", context);
	url.searchParams.set("limit", String(parsePositiveInt(process.env.CODEMEM_INJECT_LIMIT, 8)));
	url.searchParams.set(
		"token_budget",
		String(parsePositiveInt(process.env.CODEMEM_INJECT_TOKEN_BUDGET, 800)),
	);
	if (project) url.searchParams.set("project", project);

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), maxTimeMs);
	try {
		const res = await fetch(url, { signal: controller.signal });
		if (!res.ok) return EMPTY_PACK;
		const body = (await res.json()) as HttpPackResponse;
		return {
			packText: String(body.pack_text ?? "").trim(),
			items: Array.isArray(body.items) ? body.items.length : 0,
			packTokens: Number.isFinite(Number(body.metrics?.pack_tokens))
				? Number(body.metrics?.pack_tokens)
				: 0,
		};
	} catch {
		return EMPTY_PACK;
	} finally {
		clearTimeout(timeout);
	}
}

export async function buildCodexHookInjection(
	payload: Record<string, unknown>,
	opts: DbOpts,
	deps: InjectDeps = {},
): Promise<InjectResult> {
	if (envTruthy(process.env.CODEMEM_PLUGIN_IGNORE)) return continueResult();
	if (!envNotDisabled(process.env.CODEMEM_INJECT_CONTEXT || "1")) return continueResult();

	const promptText = normalizePromptText(payload.prompt);
	if (!promptText) return continueResult();

	const buildPack = deps.buildLocalPack ?? buildLocalPack;
	const httpPack = deps.httpPack ?? tryHttpPack;
	const resolveDb = deps.resolveDb ?? resolveDbPath;
	const project = resolveInjectProject(payload);
	const query = buildCodexInjectQuery(promptText, project);
	const maxChars = parsePositiveInt(process.env.CODEMEM_INJECT_MAX_CHARS, DEFAULT_MAX_CHARS);
	const httpMaxTimeMs =
		parsePositiveInt(process.env.CODEMEM_INJECT_HTTP_MAX_TIME_S, DEFAULT_HTTP_MAX_TIME_S) * 1000;

	let pack: CodexPackResult = EMPTY_PACK;
	let origin: "local" | "http" | "none" = "none";
	try {
		pack = await buildPack(query, project, resolveDb(resolveDbOpt(opts)));
		if (pack.packText) origin = "local";
	} catch (err) {
		logHookEvent(
			`codemem codex-hook-inject local pack failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	if (!pack.packText && envNotDisabled(process.env.CODEMEM_INJECT_HTTP_FALLBACK || "1")) {
		pack = await httpPack(query, project, httpMaxTimeMs);
		if (pack.packText) origin = "http";
	}

	const fields = [
		"inject.pack.ok",
		"source=codex",
		`origin=${origin}`,
		`items=${pack.items}`,
		`pack_tokens=${pack.packTokens}`,
		`query_len=${query.length}`,
		`empty=${pack.packText ? "false" : "true"}`,
	];
	if (project) fields.push(`project=${JSON.stringify(project)}`);
	logHookEvent(fields.join(" "));

	return continueResult(truncateAdditionalContext(pack.packText, maxChars));
}

const codexHookInjectCmd = new Command("codex-hook-inject")
	.configureHelp(helpStyle)
	.description("Return Codex hook additionalContext from local pack generation");

addDbOption(codexHookInjectCmd);

export const codexHookInjectCommand = codexHookInjectCmd.action(async (opts: DbOpts) => {
	let raw = "";
	for await (const chunk of process.stdin) raw += String(chunk);
	const trimmed = raw.trim();
	if (!trimmed) {
		emitJson(continueResult());
		return;
	}

	let payload: Record<string, unknown>;
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
			emitError({ error: "parse_error", message: "payload must be a JSON object" });
			process.exitCode = 1;
			return;
		}
		payload = parsed as Record<string, unknown>;
	} catch {
		emitError({ error: "parse_error", message: "invalid JSON" });
		process.exitCode = 1;
		return;
	}

	try {
		const result = await buildCodexHookInjection(payload, opts);
		emitJson(result);
	} catch (err) {
		logHookEvent(
			`codemem codex-hook-inject failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		emitJson(continueResult());
	}
});
