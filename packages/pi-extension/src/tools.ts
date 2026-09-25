/**
 * Native memory_* tool registration for pi.
 * HTTP preferred via PiCodememClient; CLI fallback for every tool.
 * Errors return as tool results (never throw through pi's loop).
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { errorResult, jsonResult, type PiCodememClient, type ToolResultContent } from "./client.js";
import { MEMORY_LEARN_PAYLOAD } from "./learn.js";
import {
	apiUrl,
	profileMatchesViewerTarget,
	promptPackProfileUrl,
	proveAndPostPack,
	viewerRequestTarget,
} from "./viewer.js";

/** Loose tool def — TypeBox Static inference is intentionally erased at the boundary. */
type AnyToolDef = ToolDefinition;

const filterProps = {
	kind: Type.Optional(Type.String({ description: "Filter by memory kind" })),
	project: Type.Optional(
		Type.String({ description: "Filter by project scope (matches sessions.project)" }),
	),
};

const memoryKind = Type.Union([
	Type.Literal("discovery"),
	Type.Literal("change"),
	Type.Literal("feature"),
	Type.Literal("bugfix"),
	Type.Literal("refactor"),
	Type.Literal("decision"),
	Type.Literal("exploration"),
]);

function asRecord(value: unknown): Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function projectOrClient(
	params: Record<string, unknown>,
	client: PiCodememClient,
): string | undefined {
	if (typeof params.project === "string" && params.project.trim()) return params.project.trim();
	return client.project ?? undefined;
}

async function withToolError(
	label: string,
	fn: () => Promise<ToolResultContent>,
): Promise<ToolResultContent> {
	try {
		return await fn();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return errorResult(`codemem ${label} failed: ${msg}`);
	}
}

async function httpOrCli(
	_client: PiCodememClient,
	_signal: AbortSignal | undefined,
	http: () => Promise<ToolResultContent | null>,
	cli: () => Promise<ToolResultContent>,
): Promise<ToolResultContent> {
	try {
		const httpResult = await http();
		if (httpResult) return httpResult;
	} catch {
		// fall through to CLI
	}
	return cli();
}

type HttpJsonResult =
	| { ok: true; status: number; data: unknown }
	| { ok: false; error: string; safeFallback: boolean; status?: number };

const SAFE_CONNECT_CODES = new Set([
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ENETUNREACH",
	"EHOSTUNREACH",
]);

function collectErrorTokens(err: unknown): string[] {
	const tokens: string[] = [];
	let current: unknown = err;
	for (let i = 0; i < 6 && current && typeof current === "object"; i++) {
		const rec = current as { code?: unknown; name?: unknown; cause?: unknown };
		if (typeof rec.code === "string") tokens.push(rec.code);
		if (typeof rec.name === "string") tokens.push(rec.name);
		current = rec.cause;
	}
	return tokens;
}

function isSafeConnectFailure(err: unknown): boolean {
	return collectErrorTokens(err).some((token) => SAFE_CONNECT_CODES.has(token));
}

function applyQuery(
	url: URL,
	query?: Record<string, string | number | boolean | undefined | null>,
): void {
	if (!query) return;
	for (const [key, value] of Object.entries(query)) {
		if (value == null || value === "") continue;
		url.searchParams.set(key, String(value));
	}
}

async function readResponseData(res: Response): Promise<unknown> {
	const text = await res.text();
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/**
 * Target-aware proof for native-tool HTTP ops: GET /api/prompt-pack-profile
 * and verify the server reports THIS process's db_path + identity_target.
 * Older viewers 404 the route or report a different target — without this
 * proof they would silently serve operations from their own database.
 */
async function proveViewerTarget(
	client: PiCodememClient,
	target: { db_path: string; identity_target: unknown },
	signal?: AbortSignal,
): Promise<boolean> {
	try {
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		const timeout = setTimeout(
			() => controller.abort(),
			Math.min(client.config.httpTimeoutMs, 2000),
		);
		try {
			const res = await fetch(promptPackProfileUrl(client.config), {
				method: "GET",
				redirect: "manual",
				signal: controller.signal,
			});
			if (!res.ok) return false;
			return profileMatchesViewerTarget(
				await readResponseData(res),
				target.db_path,
				target.identity_target,
			);
		} finally {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
		}
	} catch {
		return false;
	}
}

function httpErrorMessage(data: unknown, res: Response): string {
	if (data != null && typeof data === "object" && !Array.isArray(data)) {
		return (
			String((data as Record<string, unknown>).error ?? res.statusText) || `HTTP ${res.status}`
		);
	}
	return res.statusText || `HTTP ${res.status}`;
}

function firstList(...candidates: unknown[]): unknown[] {
	for (const candidate of candidates) {
		if (Array.isArray(candidate)) return candidate;
	}
	return [];
}

function optionalFilter(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cliItemMatchesFilters(
	item: unknown,
	kind: string | undefined,
	project: string | undefined,
): boolean {
	if (item == null || typeof item !== "object" || Array.isArray(item)) return false;
	const row = item as Record<string, unknown>;
	if (row.error) return false;
	if (kind && String(row.kind ?? "") !== kind) return false;
	if (project && String(row.project ?? "") !== project) return false;
	return true;
}

async function searchMemoriesHttp(
	client: PiCodememClient,
	query: string,
	limit: number,
	project: string | undefined,
	kind: string | undefined,
	signal: AbortSignal | undefined,
): Promise<ToolResultContent | null> {
	const index = await httpJson(client, "GET", "/api/memories/search_index", {
		query: { query, limit, project, kind },
		signal,
	});
	if (!index.ok) return null;
	const items = asRecord(index.data).items;
	if (!Array.isArray(items) || items.length === 0) return jsonResult({ items: [] });
	const ids = items
		.map((item) => asRecord(item).id)
		.filter((id): id is number => typeof id === "number");
	if (ids.length === 0) return jsonResult({ items });
	const expanded = await httpJson(client, "POST", "/api/memories/expand", {
		body: {
			ids,
			depth_before: 0,
			depth_after: 0,
			include_observations: true,
			project,
			kind,
		},
		signal,
	});
	if (!expanded.ok) return jsonResult({ items });
	const data = asRecord(expanded.data);
	const obs = data.observations;
	if (Array.isArray(obs) && obs.length > 0) return jsonResult({ items: obs });
	const anchors = data.anchors;
	if (Array.isArray(anchors)) return jsonResult({ items: anchors });
	return jsonResult({ items });
}

function compactIndexItems(parsed: unknown): unknown[] {
	return firstList(asRecord(parsed).items, parsed).map((item) => {
		const row = asRecord(item);
		return {
			id: row.id,
			kind: row.kind,
			title: row.title,
			score: row.score,
			created_at: row.created_at,
			session_id: row.session_id,
			metadata: row.metadata,
		};
	});
}

function distillCliArgs(params: Record<string, unknown>, body: Record<string, unknown>): string[] {
	const args = ["distill", "--json"];
	if (params.limit != null) args.push("-l", String(params.limit));
	if (params.min_recurrence != null) args.push("-m", String(params.min_recurrence));
	if (typeof params.kind === "string" && params.kind) args.push("-k", params.kind);
	const project = body.project;
	if (typeof project === "string" && project) args.push("-p", project);
	if (params.all_projects) args.push("-A");
	if (params.include_documented) args.push("--include-documented");
	if (params.judge === false) args.push("--no-judge");
	return args;
}

function asTool(def: {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
	) => Promise<ToolResultContent>;
}): AnyToolDef {
	return def as unknown as AnyToolDef;
}

async function httpJson(
	client: PiCodememClient,
	method: "GET" | "POST",
	path: string,
	opts: {
		query?: Record<string, string | number | boolean | undefined | null>;
		body?: unknown;
		signal?: AbortSignal;
		timeoutMs?: number;
	} = {},
): Promise<HttpJsonResult> {
	if (!client.config.viewerEnabled)
		return { ok: false, error: "viewer disabled", safeFallback: true };
	// A stale older viewer on the port ignores unknown query params and would
	// serve the operation from its own database with a 2xx. Every native-tool
	// HTTP op therefore requires a target-aware proof first: GET
	// /api/prompt-pack-profile and match the server-reported db_path +
	// identity_target against this process's target. Old viewers 404 the route
	// or report a different target, so an unproven viewer falls back to CLI.
	await client.ensureViewer(opts.signal);
	const target = viewerRequestTarget(client.cwd);
	if (!(await proveViewerTarget(client, target, opts.signal))) {
		return { ok: false, error: "viewer target not proven", safeFallback: true };
	}
	const url = new URL(apiUrl(client.config, path));
	applyQuery(url, opts.query);
	url.searchParams.set("db_path", target.db_path);
	url.searchParams.set("identity_target", JSON.stringify(target.identity_target));
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	opts.signal?.addEventListener("abort", onAbort, { once: true });
	const timeout = setTimeout(
		() => controller.abort(),
		opts.timeoutMs ?? client.config.httpTimeoutMs,
	);
	try {
		const res = await fetch(url, {
			method,
			headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
			body: method === "POST" ? JSON.stringify(opts.body ?? {}) : undefined,
			signal: controller.signal,
		});
		const data = await readResponseData(res);
		if (!res.ok) {
			return {
				ok: false,
				error: httpErrorMessage(data, res),
				safeFallback: res.status >= 400 && res.status < 500,
				status: res.status,
			};
		}
		return { ok: true, status: res.status, data };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
			safeFallback: isSafeConnectFailure(err),
		};
	} finally {
		clearTimeout(timeout);
		opts.signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * Parse CLI stdout that may contain log lines before a JSON payload.
 * Scans candidate JSON value starts in document order and returns the first
 * suffix that parses — handling nested top-level objects/arrays correctly
 * (lastIndexOf picks inner objects and breaks on `{"items":[{"id":1}]}`).
 */
export function parseCliJson(stdout: string): unknown {
	const trimmed = stdout.trim();
	if (!trimmed) return null;
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (ch !== "{" && ch !== "[") continue;
		try {
			return JSON.parse(trimmed.slice(i));
		} catch {
			// not a parseable suffix — keep scanning
		}
	}
	return trimmed;
}

function paramsOf(params: unknown): Record<string, unknown> {
	return params != null && typeof params === "object" && !Array.isArray(params)
		? (params as Record<string, unknown>)
		: {};
}

/**
 * Build a memory_distill_candidates request body. `all_projects` and `project`
 * are mutually exclusive server-side (memory-tools.ts / MCP distill guard), so
 * client/session project must NOT be attached when all_projects is requested.
 */
export function buildDistillBody(
	params: Record<string, unknown>,
	clientProject?: string,
): Record<string, unknown> {
	const body = { ...(params as Record<string, unknown>) };
	if (params.all_projects === true || params.all_projects === "true") {
		delete body.project;
		return body;
	}
	if (typeof body.project !== "string" || !body.project.trim()) {
		if (clientProject) body.project = clientProject;
	}
	return body;
}

async function executeMemorySearch(
	client: PiCodememClient,
	rawParams: unknown,
	signal: AbortSignal | undefined,
): Promise<ToolResultContent> {
	const params = paramsOf(rawParams);
	return withToolError("memory_search", async () => {
		const query = String(params.query ?? "");
		const limit = Number(params.limit ?? 5);
		const project = projectOrClient(params as Record<string, unknown>, client);
		const kind = typeof params.kind === "string" ? params.kind : undefined;

		return httpOrCli(
			client,
			signal,
			() => searchMemoriesHttp(client, query, limit, project, kind, signal),
			async () => {
				const args = ["search", query, "--json", "-n", String(limit)];
				if (project) args.push("--project", project);
				if (kind) args.push("--kind", kind);
				const { stdout } = await client.execCodemem(args, { signal });
				return jsonResult(parseCliJson(stdout) ?? { items: [] });
			},
		);
	});
}

async function executeMemorySearchIndex(
	client: PiCodememClient,
	rawParams: unknown,
	signal: AbortSignal | undefined,
): Promise<ToolResultContent> {
	const params = paramsOf(rawParams);
	return withToolError("memory_search_index", async () => {
		const query = String(params.query ?? "");
		const limit = Number(params.limit ?? 8);
		const project = projectOrClient(params as Record<string, unknown>, client);
		const kind = typeof params.kind === "string" ? params.kind : undefined;
		return httpOrCli(
			client,
			signal,
			async () => {
				const res = await httpJson(client, "GET", "/api/memories/search_index", {
					query: { query, limit, project, kind },
					signal,
				});
				if (!res.ok) return null;
				return jsonResult(res.data);
			},
			async () => {
				const args = ["search", query, "--json", "-n", String(limit)];
				if (project) args.push("--project", project);
				if (kind) args.push("--kind", kind);
				const { stdout } = await client.execCodemem(args, { signal });
				return jsonResult({ items: compactIndexItems(parseCliJson(stdout)) });
			},
		);
	});
}

async function executeMemoryExplain(
	client: PiCodememClient,
	rawParams: unknown,
	signal: AbortSignal | undefined,
): Promise<ToolResultContent> {
	const params = paramsOf(rawParams);
	return withToolError("memory_explain", async () => {
		const body = { ...(params as Record<string, unknown>) };
		if (!body.project && client.project) body.project = client.project;
		return httpOrCli(
			client,
			signal,
			async () => {
				const res = await httpJson(client, "POST", "/api/memories/explain", {
					body,
					signal,
				});
				if (!res.ok) return null;
				return jsonResult(res.data);
			},
			async () => {
				// No dedicated CLI twin — surface a clear degraded message.
				return errorResult(
					"memory_explain requires the codemem viewer server (HTTP). Start it with `codemem serve start`.",
				);
			},
		);
	});
}

async function executeMemoryRecent(
	client: PiCodememClient,
	rawParams: unknown,
	signal: AbortSignal | undefined,
): Promise<ToolResultContent> {
	const params = paramsOf(rawParams);
	return withToolError("memory_recent", async () => {
		const limit = Number(params.limit ?? 8);
		const project = projectOrClient(params as Record<string, unknown>, client);
		const kind = typeof params.kind === "string" ? params.kind : undefined;
		return httpOrCli(
			client,
			signal,
			async () => {
				const res = await httpJson(client, "GET", "/api/memory", {
					query: { limit, project, kind },
					signal,
				});
				if (!res.ok) return null;
				return jsonResult(res.data);
			},
			async () => {
				const args = ["recent", "--json", "--limit", String(limit)];
				if (project) args.push("--project", project);
				if (kind) args.push("--kind", kind);
				const { stdout } = await client.execCodemem(args, { signal });
				return jsonResult(parseCliJson(stdout) ?? { items: [] });
			},
		);
	});
}

async function executeMemoryPack(
	client: PiCodememClient,
	rawParams: unknown,
	signal: AbortSignal | undefined,
): Promise<ToolResultContent> {
	const params = paramsOf(rawParams);
	return withToolError("memory_pack", async () => {
		const context = String(params.context ?? "");
		const limit = params.limit != null ? Number(params.limit) : undefined;
		const project = projectOrClient(params as Record<string, unknown>, client);
		return httpOrCli(
			client,
			signal,
			async () => {
				if (!client.config.viewerEnabled) return null;
				await client.ensureViewer(signal);
				const controller = new AbortController();
				const onAbort = () => controller.abort();
				signal?.addEventListener("abort", onAbort, { once: true });
				const timeout = setTimeout(() => controller.abort(), client.config.httpTimeoutMs);
				try {
					const text = await proveAndPostPack(client.config, {
						context,
						cwd: client.cwd,
						project: project ?? null,
						signal: controller.signal,
						limit: limit ?? 10,
						tokenBudget: client.config.injectTokenBudget,
					});
					if (!text) return null;
					return jsonResult({ pack_text: text });
				} finally {
					clearTimeout(timeout);
					signal?.removeEventListener("abort", onAbort);
				}
			},
			async () => {
				const args = ["pack", context, "--json"];
				if (limit != null) args.push("-n", String(limit));
				if (project) args.push("--project", project);
				const { stdout } = await client.execCodemem(args, { signal });
				return jsonResult(parseCliJson(stdout) ?? {});
			},
		);
	});
}

async function executeMemoryGet(
	client: PiCodememClient,
	rawParams: unknown,
	signal: AbortSignal | undefined,
): Promise<ToolResultContent> {
	const params = paramsOf(rawParams);
	return withToolError("memory_get", async () => {
		const memoryId = Number(params.memory_id);
		const project = projectOrClient(params as Record<string, unknown>, client);
		const kind = optionalFilter(params.kind);
		return httpOrCli(
			client,
			signal,
			async () => {
				const res = await httpJson(client, "POST", "/api/memories/expand", {
					body: {
						ids: [memoryId],
						depth_before: 0,
						depth_after: 0,
						include_observations: true,
						project,
						kind,
					},
					signal,
				});
				if (!res.ok) return null;
				const data = asRecord(res.data);
				const obs = Array.isArray(data.observations) ? data.observations : [];
				const anchors = Array.isArray(data.anchors) ? data.anchors : [];
				const item = obs[0] ?? anchors[0] ?? null;
				if (!item) return errorResult("not_found");
				return jsonResult(item);
			},
			async () => {
				const { stdout } = await client.execCodemem(
					["memory", "show", String(memoryId), "--json"],
					{ signal },
				);
				const parsed = parseCliJson(stdout);
				if (
					parsed != null &&
					typeof parsed === "object" &&
					!Array.isArray(parsed) &&
					(parsed as { error?: string }).error
				) {
					return errorResult(String((parsed as { message?: string }).message ?? "not_found"));
				}
				if (!cliItemMatchesFilters(parsed, kind, project)) return errorResult("not_found");
				return jsonResult(parsed);
			},
		);
	});
}

async function executeMemoryGetObservations(
	client: PiCodememClient,
	rawParams: unknown,
	signal: AbortSignal | undefined,
): Promise<ToolResultContent> {
	const params = paramsOf(rawParams);
	return withToolError("memory_get_observations", async () => {
		const ids = Array.isArray(params.ids) ? params.ids.map(Number) : [];
		const project = projectOrClient(params as Record<string, unknown>, client);
		const kind = optionalFilter(params.kind);
		return httpOrCli(
			client,
			signal,
			async () => {
				const res = await httpJson(client, "POST", "/api/memories/expand", {
					body: {
						ids,
						depth_before: 0,
						depth_after: 0,
						include_observations: true,
						project,
						kind,
					},
					signal,
				});
				if (!res.ok) return null;
				const data = asRecord(res.data);
				return jsonResult({ items: firstList(data.observations, data.anchors) });
			},
			async () => {
				const items: unknown[] = [];
				for (const id of ids) {
					try {
						const { stdout } = await client.execCodemem(["memory", "show", String(id), "--json"], {
							signal,
						});
						const parsed = parseCliJson(stdout);
						if (cliItemMatchesFilters(parsed, kind, project)) items.push(parsed);
					} catch {
						// skip missing
					}
				}
				return jsonResult({ items });
			},
		);
	});
}

async function executeMemoryRemember(
	client: PiCodememClient,
	rawParams: unknown,
	signal: AbortSignal | undefined,
): Promise<ToolResultContent> {
	const params = paramsOf(rawParams);
	return withToolError("memory_remember", async () => {
		const project = projectOrClient(params as Record<string, unknown>, client);
		const body = {
			kind: params.kind,
			title: params.title,
			body: params.body,
			confidence: params.confidence ?? 0.5,
			project,
		};
		return httpOrCli(
			client,
			signal,
			async () => {
				const res = await httpJson(client, "POST", "/api/memories/remember", {
					body,
					signal,
				});
				if (res.ok) return jsonResult(res.data);
				if (!res.safeFallback) return errorResult(res.error);
				return null;
			},
			async () => {
				const args = [
					"memory",
					"remember",
					"-k",
					String(params.kind),
					"-t",
					String(params.title),
					"-b",
					String(params.body),
					"--json",
				];
				if (project) args.push("--project", project);
				if (params.confidence != null) args.push("--confidence", String(params.confidence));
				const { stdout } = await client.execCodemem(args, { signal });
				return jsonResult(parseCliJson(stdout) ?? { status: "ok" });
			},
		);
	});
}

async function executeMemoryForget(
	client: PiCodememClient,
	rawParams: unknown,
	signal: AbortSignal | undefined,
): Promise<ToolResultContent> {
	const params = paramsOf(rawParams);
	return withToolError("memory_forget", async () => {
		const memoryId = Number(params.memory_id);
		const kind = optionalFilter(params.kind);
		const project = optionalFilter(params.project);
		return httpOrCli(
			client,
			signal,
			async () => {
				const res = await httpJson(client, "POST", "/api/memories/forget", {
					body: { memory_id: memoryId, kind, project },
					signal,
				});
				if (res.ok) return jsonResult(res.data);
				if (res.status === 404) return errorResult("not_found");
				if (!res.safeFallback) return errorResult(res.error);
				return null;
			},
			async () => {
				const { stdout } = await client.execCodemem(
					["memory", "show", String(memoryId), "--json"],
					{ signal },
				);
				const parsed = parseCliJson(stdout);
				if (!cliItemMatchesFilters(parsed, kind, project)) return errorResult("not_found");
				const forgotten = await client.execCodemem(
					["memory", "forget", String(memoryId), "--json"],
					{ signal },
				);
				return jsonResult(parseCliJson(forgotten.stdout) ?? { status: "ok" });
			},
		);
	});
}

async function executeMemoryLearn(): Promise<ToolResultContent> {
	return jsonResult(MEMORY_LEARN_PAYLOAD);
}

async function executeMemorySchema(
	client: PiCodememClient,
	_rawParams: unknown,
	signal: AbortSignal | undefined,
): Promise<ToolResultContent> {
	return withToolError("memory_schema", async () => {
		return httpOrCli(
			client,
			signal,
			async () => {
				const res = await httpJson(client, "GET", "/api/memories/schema", { signal });
				if (!res.ok) return null;
				return jsonResult(res.data);
			},
			async () => {
				// Static fallback matching MCP memory_schema when viewer is down.
				return jsonResult({
					kinds: [
						"discovery",
						"change",
						"feature",
						"bugfix",
						"refactor",
						"decision",
						"exploration",
					],
					kind_descriptions: {
						discovery: "Something learned about the codebase, architecture, or tools",
						change: "A code change that was made",
						feature: "A new feature that was implemented",
						bugfix: "A bug that was found and fixed",
						refactor: "Code that was refactored or restructured",
						decision: "A design or architecture decision",
						exploration: "An experiment or investigation (may not have shipped)",
					},
					fields: {
						title: "short text",
						body: "long text",
						subtitle: "short text",
						facts: "list<string>",
						narrative: "long text",
						concepts: "list<string>",
						files_read: "list<string>",
						files_modified: "list<string>",
						prompt_number: "int",
					},
					filters: ["kind", "project"],
					note: "schema served from extension fallback (viewer unreachable)",
				});
			},
		);
	});
}

async function executeMemoryTimeline(
	client: PiCodememClient,
	rawParams: unknown,
	signal: AbortSignal | undefined,
): Promise<ToolResultContent> {
	const params = paramsOf(rawParams);
	return withToolError("memory_timeline", async () => {
		const project = projectOrClient(params as Record<string, unknown>, client);
		const kind = typeof params.kind === "string" ? params.kind : undefined;
		return httpOrCli(
			client,
			signal,
			async () => {
				const res = await httpJson(client, "GET", "/api/memories/timeline", {
					query: {
						query: typeof params.query === "string" ? params.query : undefined,
						memory_id: typeof params.memory_id === "number" ? params.memory_id : undefined,
						depth_before: typeof params.depth_before === "number" ? params.depth_before : 3,
						depth_after: typeof params.depth_after === "number" ? params.depth_after : 3,
						project,
						kind,
					},
					signal,
				});
				if (!res.ok) return null;
				return jsonResult(res.data);
			},
			async () => {
				return errorResult(
					"memory_timeline requires the codemem viewer server (HTTP). Start it with `codemem serve start`.",
				);
			},
		);
	});
}

async function executeMemoryExpand(
	client: PiCodememClient,
	rawParams: unknown,
	signal: AbortSignal | undefined,
): Promise<ToolResultContent> {
	const params = paramsOf(rawParams);
	return withToolError("memory_expand", async () => {
		const body = {
			ids: params.ids,
			depth_before: params.depth_before ?? 3,
			depth_after: params.depth_after ?? 3,
			include_observations: params.include_observations ?? false,
			project: projectOrClient(params as Record<string, unknown>, client),
			kind: typeof params.kind === "string" ? params.kind : undefined,
		};
		return httpOrCli(
			client,
			signal,
			async () => {
				const res = await httpJson(client, "POST", "/api/memories/expand", {
					body,
					signal,
				});
				if (!res.ok) return null;
				return jsonResult(res.data);
			},
			async () => {
				return errorResult(
					"memory_expand requires the codemem viewer server (HTTP). Start it with `codemem serve start`.",
				);
			},
		);
	});
}

async function executeMemoryDistillCandidates(
	client: PiCodememClient,
	rawParams: unknown,
	signal: AbortSignal | undefined,
): Promise<ToolResultContent> {
	const params = paramsOf(rawParams);
	return withToolError("memory_distill_candidates", async () => {
		const body = buildDistillBody(params as Record<string, unknown>, client.project ?? undefined);
		return httpOrCli(
			client,
			signal,
			async () => {
				const res = await httpJson(client, "POST", "/api/memories/distill_candidates", {
					body,
					signal,
					timeoutMs: 60_000,
				});
				if (!res.ok) return null;
				return jsonResult(res.data);
			},
			async () => {
				const { stdout } = await client.execCodemem(distillCliArgs(params, body), {
					signal,
					timeoutMs: 60_000,
				});
				return jsonResult(parseCliJson(stdout) ?? {});
			},
		);
	});
}

function registerMemorySearch(
	register: (def: AnyToolDef) => void,
	tool: typeof asTool,
	client: PiCodememClient,
): void {
	register(
		tool({
			name: "memory_search",
			label: "Memory Search",
			description: "Search memories by text query. Returns full body text for each match.",
			parameters: Type.Object({
				query: Type.String({ description: "Search query" }),
				limit: Type.Optional(
					Type.Integer({ minimum: 1, maximum: 50, default: 5, description: "Max results" }),
				),
				...filterProps,
			}),
			async execute(_id, rawParams, signal) {
				return executeMemorySearch(client, rawParams, signal);
			},
		}),
	);
}

function registerMemorySearchIndex(
	register: (def: AnyToolDef) => void,
	tool: typeof asTool,
	client: PiCodememClient,
): void {
	register(
		tool({
			name: "memory_search_index",
			label: "Memory Search Index",
			description:
				"Search memories by text query. Returns compact index entries (no body) for browsing.",
			parameters: Type.Object({
				query: Type.String({ description: "Search query" }),
				limit: Type.Optional(
					Type.Integer({ minimum: 1, maximum: 50, default: 8, description: "Max results" }),
				),
				...filterProps,
			}),
			async execute(_id, rawParams, signal) {
				return executeMemorySearchIndex(client, rawParams, signal);
			},
		}),
	);
}

function registerMemoryExplain(
	register: (def: AnyToolDef) => void,
	tool: typeof asTool,
	client: PiCodememClient,
): void {
	register(
		tool({
			name: "memory_explain",
			label: "Memory Explain",
			description: "Explain why memories match a query or set of IDs (ranking diagnostics).",
			parameters: Type.Object({
				query: Type.Optional(Type.String({ description: "Search query" })),
				ids: Type.Optional(
					Type.Array(Type.Integer(), { maxItems: 200, description: "Memory IDs to explain" }),
				),
				limit: Type.Optional(
					Type.Integer({ minimum: 1, maximum: 50, default: 10, description: "Max results" }),
				),
				include_pack_context: Type.Optional(
					Type.Boolean({ description: "Include pack assembly context" }),
				),
				...filterProps,
			}),
			async execute(_id, rawParams, signal) {
				return executeMemoryExplain(client, rawParams, signal);
			},
		}),
	);
}

function registerMemoryRecent(
	register: (def: AnyToolDef) => void,
	tool: typeof asTool,
	client: PiCodememClient,
): void {
	register(
		tool({
			name: "memory_recent",
			label: "Memory Recent",
			description: "Return recent memories, newest first.",
			parameters: Type.Object({
				limit: Type.Optional(
					Type.Integer({ minimum: 1, maximum: 100, default: 8, description: "Max results" }),
				),
				...filterProps,
			}),
			async execute(_id, rawParams, signal) {
				return executeMemoryRecent(client, rawParams, signal);
			},
		}),
	);
}

function registerMemoryPack(
	register: (def: AnyToolDef) => void,
	tool: typeof asTool,
	client: PiCodememClient,
): void {
	register(
		tool({
			name: "memory_pack",
			label: "Memory Pack",
			description:
				"Build a formatted memory pack from search results — quick one-shot context block.",
			parameters: Type.Object({
				context: Type.String({ description: "Context description to search for" }),
				limit: Type.Optional(
					Type.Integer({ minimum: 1, maximum: 50, description: "Max items to include" }),
				),
				project: Type.Optional(
					Type.String({ description: "Filter by project scope (matches sessions.project)" }),
				),
			}),
			async execute(_id, rawParams, signal) {
				return executeMemoryPack(client, rawParams, signal);
			},
		}),
	);
}

function registerMemoryGet(
	register: (def: AnyToolDef) => void,
	tool: typeof asTool,
	client: PiCodememClient,
): void {
	register(
		tool({
			name: "memory_get",
			label: "Memory Get",
			description: "Fetch a single memory item by ID.",
			parameters: Type.Object({
				memory_id: Type.Integer({ description: "Memory ID" }),
				...filterProps,
			}),
			async execute(_id, rawParams, signal) {
				return executeMemoryGet(client, rawParams, signal);
			},
		}),
	);
}

function registerMemoryGetObservations(
	register: (def: AnyToolDef) => void,
	tool: typeof asTool,
	client: PiCodememClient,
): void {
	register(
		tool({
			name: "memory_get_observations",
			label: "Memory Get Observations",
			description: "Fetch multiple memory items by their IDs.",
			parameters: Type.Object({
				ids: Type.Array(Type.Integer(), { maxItems: 200, description: "Memory IDs to fetch" }),
				...filterProps,
			}),
			async execute(_id, rawParams, signal) {
				return executeMemoryGetObservations(client, rawParams, signal);
			},
		}),
	);
}

function registerMemoryRemember(
	register: (def: AnyToolDef) => void,
	tool: typeof asTool,
	client: PiCodememClient,
): void {
	register(
		tool({
			name: "memory_remember",
			label: "Memory Remember",
			description: "Create a new memory. Use for milestones, decisions, and notable facts.",
			parameters: Type.Object({
				kind: memoryKind,
				title: Type.String({ description: "Short title" }),
				body: Type.String({ description: "Body text (high-signal content)" }),
				confidence: Type.Optional(
					Type.Number({ minimum: 0, maximum: 1, default: 0.5, description: "Confidence 0-1" }),
				),
				project: Type.Optional(Type.String({ description: "Project identifier" })),
			}),
			async execute(_id, rawParams, signal) {
				return executeMemoryRemember(client, rawParams, signal);
			},
		}),
	);
}

function registerMemoryForget(
	register: (def: AnyToolDef) => void,
	tool: typeof asTool,
	client: PiCodememClient,
): void {
	register(
		tool({
			name: "memory_forget",
			label: "Memory Forget",
			description: "Soft-delete a memory item. Use for incorrect or sensitive data.",
			parameters: Type.Object({
				memory_id: Type.Integer({ description: "Memory ID to forget" }),
				...filterProps,
			}),
			async execute(_id, rawParams, signal) {
				return executeMemoryForget(client, rawParams, signal);
			},
		}),
	);
}

function registerMemoryLearn(
	register: (def: AnyToolDef) => void,
	tool: typeof asTool,
	_client: PiCodememClient,
): void {
	register(
		tool({
			name: "memory_learn",
			label: "Memory Learn",
			description: "Learn how to use codemem memory tools. Call this first if unfamiliar.",
			parameters: Type.Object({}),
			async execute() {
				return executeMemoryLearn();
			},
		}),
	);
}

function registerMemorySchema(
	register: (def: AnyToolDef) => void,
	tool: typeof asTool,
	client: PiCodememClient,
): void {
	register(
		tool({
			name: "memory_schema",
			label: "Memory Schema",
			description: "Return the memory schema — kinds, fields, and available filters.",
			parameters: Type.Object({}),
			async execute(_id, rawParams, signal) {
				return executeMemorySchema(client, rawParams, signal);
			},
		}),
	);
}

function registerMemoryTimeline(
	register: (def: AnyToolDef) => void,
	tool: typeof asTool,
	client: PiCodememClient,
): void {
	register(
		tool({
			name: "memory_timeline",
			label: "Memory Timeline",
			description: "Get a chronological window of memories around an anchor (by ID or query).",
			parameters: Type.Object({
				query: Type.Optional(Type.String({ description: "Search query to find anchor" })),
				memory_id: Type.Optional(Type.Integer({ description: "Anchor memory ID" })),
				depth_before: Type.Optional(
					Type.Integer({ minimum: 0, default: 3, description: "Items before anchor" }),
				),
				depth_after: Type.Optional(
					Type.Integer({ minimum: 0, default: 3, description: "Items after anchor" }),
				),
				...filterProps,
			}),
			async execute(_id, rawParams, signal) {
				return executeMemoryTimeline(client, rawParams, signal);
			},
		}),
	);
}

function registerMemoryExpand(
	register: (def: AnyToolDef) => void,
	tool: typeof asTool,
	client: PiCodememClient,
): void {
	register(
		tool({
			name: "memory_expand",
			label: "Memory Expand",
			description: "Fetch memories by ID with surrounding timeline context.",
			parameters: Type.Object({
				ids: Type.Array(Type.Union([Type.Integer(), Type.String()]), {
					maxItems: 200,
					description: "Memory IDs to expand",
				}),
				depth_before: Type.Optional(
					Type.Integer({ minimum: 0, default: 3, description: "Timeline items before" }),
				),
				depth_after: Type.Optional(
					Type.Integer({ minimum: 0, default: 3, description: "Timeline items after" }),
				),
				include_observations: Type.Optional(
					Type.Boolean({ default: false, description: "Include full observation details" }),
				),
				...filterProps,
			}),
			async execute(_id, rawParams, signal) {
				return executeMemoryExpand(client, rawParams, signal);
			},
		}),
	);
}

function registerMemoryDistillCandidates(
	register: (def: AnyToolDef) => void,
	tool: typeof asTool,
	client: PiCodememClient,
): void {
	register(
		tool({
			name: "memory_distill_candidates",
			label: "Memory Distill Candidates",
			description: "Mine recurring memories into reviewable context candidates.",
			parameters: Type.Object({
				limit: Type.Optional(
					Type.Integer({ minimum: 1, maximum: 50, default: 10, description: "Max candidates" }),
				),
				min_recurrence: Type.Optional(
					Type.Integer({
						minimum: 1,
						maximum: 50,
						default: 2,
						description: "Minimum member count per candidate",
					}),
				),
				kind: Type.Optional(Type.String({ description: "Memory kind to mine" })),
				project: Type.Optional(Type.String({ description: "Project identifier" })),
				all_projects: Type.Optional(
					Type.Boolean({ description: "Mine memories across all projects" }),
				),
				include_documented: Type.Optional(
					Type.Boolean({
						description: "Include candidates already represented in context files",
					}),
				),
				judge: Type.Optional(
					Type.Boolean({
						description: "Run observer worthiness judgment (default true)",
					}),
				),
			}),
			async execute(_id, rawParams, signal) {
				return executeMemoryDistillCandidates(client, rawParams, signal);
			},
		}),
	);
}

async function executeMemorySessionSearch(
	client: PiCodememClient,
	rawParams: unknown,
	signal: AbortSignal | undefined,
): Promise<ToolResultContent> {
	const params = paramsOf(rawParams);
	return withToolError("memory_session_search", async () => {
		const query = String(params.query ?? "");
		if (!query.trim()) return errorResult("query required");
		return httpOrCli(
			client,
			signal,
			async () => {
				const res = await httpJson(client, "GET", "/api/pi/sessions/search", {
					query: {
						query,
						limit: params.limit != null ? Number(params.limit) : undefined,
						snippet_chars: params.snippet_chars != null ? Number(params.snippet_chars) : undefined,
						project: optionalFilter(params.project),
						session_id: optionalFilter(params.session_id),
					},
					signal,
				});
				if (!res.ok) return null;
				return jsonResult(res.data);
			},
			async () => {
				const { stdout } = await client.execCodemem(sessionSearchCliArgs(params), { signal });
				return jsonResult(parseCliJson(stdout));
			},
		);
	});
}

/**
 * CLI fallback args: codemem pi-session-search <query> --json plus optional
 * filters. Mirrors the HTTP query-param mapping (bounds are clamped core-side
 * and by the CLI command itself).
 */
function sessionSearchCliArgs(params: Record<string, unknown>): string[] {
	const args = ["pi-session-search", String(params.query ?? ""), "--json"];
	if (params.limit != null) args.push("--limit", String(Number(params.limit)));
	if (params.snippet_chars != null)
		args.push("--snippet-chars", String(Number(params.snippet_chars)));
	const project = optionalFilter(params.project);
	if (project) args.push("--project", project);
	const sessionId = optionalFilter(params.session_id);
	if (sessionId) args.push("--session-id", sessionId);
	return args;
}

function registerMemorySessionSearch(
	register: (def: AnyToolDef) => void,
	tool: typeof asTool,
	client: PiCodememClient,
): void {
	register(
		tool({
			name: "memory_session_search",
			label: "Memory Session Search",
			description:
				"Search stored pi session transcripts by free-text query. Matches raw pi " +
				"conversation events captured by codemem ingest (source pi), ordered " +
				"most-recent-first, with optional project and session_id filters. Each " +
				"result carries source, session id, project, role (user/assistant), " +
				"timestamp, and a bounded text snippet; results are capped (default 10, " +
				"max 20) and a no-match query returns an explicit empty result, never an " +
				"error. Empty results usually mean the index only covers sessions captured " +
				"since codemem was installed — backfill pre-install history with " +
				"`codemem pi-import-sessions`.",
			parameters: Type.Object({
				query: Type.String({ description: "Free-text search over stored pi session text" }),
				project: Type.Optional(Type.String({ description: "Filter by project label" })),
				session_id: Type.Optional(Type.String({ description: "Filter by pi session id" })),
				limit: Type.Optional(
					Type.Integer({ minimum: 1, maximum: 20, default: 10, description: "Max results" }),
				),
				snippet_chars: Type.Optional(
					Type.Integer({
						minimum: 100,
						maximum: 4000,
						default: 1200,
						description: "Per-result snippet cap in chars",
					}),
				),
			}),
			async execute(_id, rawParams, signal) {
				return executeMemorySessionSearch(client, rawParams, signal);
			},
		}),
	);
}

export function registerMemoryTools(pi: ExtensionAPI, client: PiCodememClient): string[] {
	const registered: string[] = [];
	const register = (def: AnyToolDef) => {
		pi.registerTool(def);
		registered.push(def.name);
	};
	registerMemorySessionSearch(register, asTool, client);
	registerMemorySearch(register, asTool, client);
	registerMemorySearchIndex(register, asTool, client);
	registerMemoryExplain(register, asTool, client);
	registerMemoryRecent(register, asTool, client);
	registerMemoryPack(register, asTool, client);
	registerMemoryGet(register, asTool, client);
	registerMemoryGetObservations(register, asTool, client);
	registerMemoryRemember(register, asTool, client);
	registerMemoryForget(register, asTool, client);
	registerMemoryLearn(register, asTool, client);
	registerMemorySchema(register, asTool, client);
	registerMemoryTimeline(register, asTool, client);
	registerMemoryExpand(register, asTool, client);
	registerMemoryDistillCandidates(register, asTool, client);
	return registered;
}

/** No-op helper for tests asserting tool absence in adapter mode. */
export function expectedToolNames(): string[] {
	return [
		"memory_search",
		"memory_search_index",
		"memory_explain",
		"memory_recent",
		"memory_pack",
		"memory_get",
		"memory_get_observations",
		"memory_remember",
		"memory_forget",
		"memory_learn",
		"memory_schema",
		"memory_timeline",
		"memory_expand",
		"memory_distill_candidates",
		"memory_session_search",
	];
}
