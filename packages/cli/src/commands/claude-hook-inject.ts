import { MemoryStore, resolveDbPath, resolveHookProject } from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import { addDbOption, type DbOpts, resolveDbOpt } from "../shared-options.js";

type InjectResult = {
	continue: true;
	hookSpecificOutput?: {
		hookEventName: "UserPromptSubmit";
		additionalContext: string;
	};
};

// claude-hook-inject is wired exclusively to UserPromptSubmit. The
// hookSpecificOutput schema is event-specific (additionalContext is a
// UserPromptSubmit-only field), so emitting any other event name would
// produce invalid output regardless of what the payload claims.
const HOOK_EVENT_NAME = "UserPromptSubmit" as const;

type InjectOpts = DbOpts;

type HttpPackResponse = {
	pack_text?: string;
};

type InjectDeps = {
	buildLocalPack?: typeof buildLocalPack;
	httpPack?: typeof tryHttpPack;
	resolveDb?: typeof resolveDbPath;
};

const DEFAULT_VIEWER_HOST = "127.0.0.1";
const DEFAULT_VIEWER_PORT = 38888;
const DEFAULT_MAX_CHARS = 16000;
const DEFAULT_HTTP_MAX_TIME_S = 2;

function emitJson(value: InjectResult | { error: string; message: string }): void {
	console.log(JSON.stringify(value));
}

function envNotDisabled(value: string | undefined): boolean {
	const normalized = String(value ?? "")
		.trim()
		.toLowerCase();
	return normalized !== "0" && normalized !== "false" && normalized !== "off";
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return fallback;
	}
	return parsed;
}

function continueResult(additionalContext?: string): InjectResult {
	if (!additionalContext) {
		return { continue: true };
	}
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
	if (!normalized) {
		return "";
	}
	if (!Number.isFinite(maxChars) || maxChars <= 0 || normalized.length <= maxChars) {
		return normalized;
	}
	return normalized.slice(0, maxChars);
}

function extractInjectContext(payload: Record<string, unknown>): string | null {
	const prompt = String(payload.prompt ?? "").trim();
	return prompt || null;
}

function resolveInjectProject(payload: Record<string, unknown>): string | null {
	const cwd = typeof payload.cwd === "string" ? payload.cwd : null;
	return resolveHookProject(cwd, payload.project);
}

async function buildLocalPack(
	context: string,
	project: string | null,
	dbPath: string,
): Promise<string> {
	const store = new MemoryStore(dbPath);
	try {
		const limit = parsePositiveInt(process.env.CODEMEM_INJECT_LIMIT, 8);
		const budget = parsePositiveInt(process.env.CODEMEM_INJECT_TOKEN_BUDGET, 800);
		const filters: { project?: string } = {};
		if (project) {
			filters.project = project;
		}
		const pack = await store.buildMemoryPackAsync(context, limit, budget, filters);
		return String(pack.pack_text ?? "").trim();
	} finally {
		store.close();
	}
}

async function tryHttpPack(
	context: string,
	project: string | null,
	maxTimeMs = DEFAULT_HTTP_MAX_TIME_S * 1000,
): Promise<string> {
	const host = process.env.CODEMEM_VIEWER_HOST || DEFAULT_VIEWER_HOST;
	const port = parsePositiveInt(process.env.CODEMEM_VIEWER_PORT, DEFAULT_VIEWER_PORT);
	const url = new URL(`http://${host}:${port}/api/pack`);
	url.searchParams.set("context", context);
	url.searchParams.set("limit", String(parsePositiveInt(process.env.CODEMEM_INJECT_LIMIT, 8)));
	url.searchParams.set(
		"token_budget",
		String(parsePositiveInt(process.env.CODEMEM_INJECT_TOKEN_BUDGET, 800)),
	);
	if (project) {
		url.searchParams.set("project", project);
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), maxTimeMs);
	try {
		const res = await fetch(url, { signal: controller.signal });
		if (!res.ok) {
			return "";
		}
		const body = (await res.json()) as HttpPackResponse;
		return String(body.pack_text ?? "").trim();
	} catch {
		return "";
	} finally {
		clearTimeout(timeout);
	}
}

export async function buildClaudeHookInjection(
	payload: Record<string, unknown>,
	opts: InjectOpts,
	deps: InjectDeps = {},
): Promise<InjectResult> {
	if (!envNotDisabled(process.env.CODEMEM_INJECT_CONTEXT || "1")) {
		return continueResult();
	}

	const context = extractInjectContext(payload);
	if (!context) {
		return continueResult();
	}

	const buildPack = deps.buildLocalPack ?? buildLocalPack;
	const httpPack = deps.httpPack ?? tryHttpPack;
	const resolveDb = deps.resolveDb ?? resolveDbPath;
	const project = resolveInjectProject(payload);
	const maxChars = parsePositiveInt(process.env.CODEMEM_INJECT_MAX_CHARS, DEFAULT_MAX_CHARS);
	const httpMaxTimeMs =
		parsePositiveInt(process.env.CODEMEM_INJECT_HTTP_MAX_TIME_S, DEFAULT_HTTP_MAX_TIME_S) * 1000;

	let additionalContext = "";
	try {
		const dbPath = resolveDb(resolveDbOpt(opts));
		additionalContext = await buildPack(context, project, dbPath);
	} catch {
		additionalContext = "";
	}

	if (!additionalContext && envNotDisabled(process.env.CODEMEM_INJECT_HTTP_FALLBACK || "1")) {
		additionalContext = await httpPack(context, project, httpMaxTimeMs);
	}

	return continueResult(truncateAdditionalContext(additionalContext, maxChars));
}

const claudeHookInjectCmd = new Command("claude-hook-inject")
	.configureHelp(helpStyle)
	.description("Return Claude hook additionalContext from local pack generation");

addDbOption(claudeHookInjectCmd);

export const claudeHookInjectCommand = claudeHookInjectCmd.action(async (opts: InjectOpts) => {
	let raw = "";
	for await (const chunk of process.stdin) {
		raw += String(chunk);
	}
	const trimmed = raw.trim();
	if (!trimmed) {
		emitJson(continueResult());
		return;
	}

	let payload: Record<string, unknown>;
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
			emitJson({ error: "parse_error", message: "payload must be a JSON object" });
			process.exitCode = 1;
			return;
		}
		payload = parsed as Record<string, unknown>;
	} catch {
		emitJson({ error: "parse_error", message: "invalid JSON" });
		process.exitCode = 1;
		return;
	}

	const result = await buildClaudeHookInjection(payload, opts);
	emitJson(result);
});
