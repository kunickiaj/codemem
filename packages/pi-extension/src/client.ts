/**
 * PiCodememClient — HTTP preferred, CLI exec fallback.
 * Never opens the store or imports @codemem/core.
 */

import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { PiExtensionConfig } from "./config.js";
import { logPiInjectPack } from "./plugin-log.js";
import {
	checkIngestAvailable,
	clearStreamFailure,
	ensureViewerRunning,
	isStreamInBackoff,
	isViewerTargetConflict,
	markStreamFailure,
	type ProvenPack,
	parseProvenPack,
	piHooksUrl,
	proveAndPostPack,
	type RenderedPackItem,
	type ViewerRuntime,
	viewerRequestTarget,
} from "./viewer.js";

/** pi AgentToolResult shape (content + required details). */
export type ToolResultContent = {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
};

export function textResult(text: string, details?: Record<string, unknown>): ToolResultContent {
	return {
		content: [{ type: "text", text }],
		details: details ?? {},
	};
}

export function errorResult(message: string, details?: Record<string, unknown>): ToolResultContent {
	return {
		content: [{ type: "text", text: message }],
		details: { isError: true, ...(details ?? {}) },
	};
}

export function jsonResult(value: unknown): ToolResultContent {
	return textResult(JSON.stringify(value, null, 2), { value });
}

export function isToolErrorResult(result: ToolResultContent): boolean {
	return result.details.isError === true;
}

export type IngestOutcome = {
	ok: boolean;
	via: "http" | "cli" | "skipped";
	inserted?: number;
	skipped?: number;
};

export type ExecCodememFn = (
	args: string[],
	opts?: { stdin?: string; signal?: AbortSignal; timeoutMs?: number; cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Memory-pack fetch result. `preformatted` tells the caller whether `text` is
 * already the full `## codemem memories` block (CLI pi-hook-inject) or bare
 * pack text (HTTP /api/pack, CLI pack --json) that must be framed via
 * formatPiInjectionBlock. Never sniff the memory text to decide framing.
 *
 * `renderedItems` + `itemCount` exist only on span-bearing transports (HTTP
 * /api/pack, CLI pack --json) and are absent on plain-text pi-hook-inject.
 */
export type PackFetch = {
	text: string;
	preformatted: boolean;
	/** Renderer item spans for injection dedup; undefined without span data. */
	renderedItems?: RenderedPackItem[];
	/** metrics.total_items from the same span-bearing response. */
	itemCount?: number;
};

function packFetchFromProven(pack: ProvenPack): PackFetch {
	const result: PackFetch = { text: pack.packText, preformatted: false };
	if (pack.renderedItems) result.renderedItems = pack.renderedItems;
	if (pack.itemCount != null) result.itemCount = pack.itemCount;
	return result;
}

function logFetchedPack(
	origin: "local" | "viewer",
	pack: ProvenPack,
	query: string,
	project: string | null,
): void {
	logPiInjectPack({
		origin,
		items: pack.itemCount ?? 0,
		packTokens: pack.packTokens ?? 0,
		queryLen: query.length,
		empty: !pack.packText,
		project,
	});
}

/** Boundary flush signals that need the long CLI budget (HTTP cannot flush). */
function isBoundaryFlushEvent(piEvent: string): boolean {
	return piEvent === "session_before_compact" || piEvent === "session_shutdown";
}

/** CLI budget for pack/inject and file-context queries (was a 3s probe). */
export const CLI_PACK_TIMEOUT_MS = 8_000;

/**
 * Independent CLI budget for boundary flushes — a drain + LLM finish can
 * exceed the short HTTP ingest timeout, so it must not reuse httpTimeoutMs.
 */
export const BOUNDARY_CLI_TIMEOUT_MS = 30_000;

function projectFromGitMarker(dir: string, gitPath: string): string {
	try {
		if (lstatSync(gitPath).isDirectory()) return basename(dir);
		const text = readFileSync(gitPath, "utf8").trim();
		if (text.startsWith("gitdir:")) {
			const gitdir = resolve(dir, text.slice("gitdir:".length).trim()).replaceAll("\\", "/");
			const marker = "/.git/worktrees/";
			const index = gitdir.indexOf(marker);
			if (index >= 0) return basename(gitdir.slice(0, index));
		}
	} catch {
		return basename(dir);
	}
	return basename(dir);
}

export class PiCodememClient {
	readonly config: PiExtensionConfig;
	readonly runtime: ViewerRuntime;
	cwd: string;
	project: string | null;
	sessionId: string | null;
	/** Injectable for tests; defaults to spawning the codemem CLI. */
	execImpl: ExecCodememFn | null;

	constructor(
		config: PiExtensionConfig,
		runtime: ViewerRuntime,
		opts: {
			cwd?: string;
			project?: string | null;
			sessionId?: string | null;
			execImpl?: ExecCodememFn | null;
		} = {},
	) {
		this.config = config;
		this.runtime = runtime;
		this.cwd = opts.cwd ?? process.cwd();
		this.project = opts.project ?? null;
		this.sessionId = opts.sessionId ?? null;
		this.execImpl = opts.execImpl ?? null;
	}

	rekey(sessionId: string, cwd: string, project: string | null): void {
		this.sessionId = sessionId;
		this.cwd = cwd;
		this.project = project;
	}

	async ensureViewer(signal?: AbortSignal): Promise<boolean> {
		return ensureViewerRunning(this.config, this.runtime, { cwd: this.cwd, signal });
	}

	/**
	 * POST /api/pi-hooks then CLI `codemem pi-hook-ingest` fallback.
	 * Honors stream backoff like the opencode plugin.
	 *
	 * Boundary events (`session_before_compact`, `session_shutdown`) always go
	 * through the CLI: HTTP can acknowledge a flush-only payload as
	 * `{inserted:0,skipped:1}` without ever running `flushRawEvents`. The CLI's
	 * `shouldForcePiBoundaryFlush` path performs the actual extraction flush
	 * (with spool fallback).
	 */
	async ingest(payload: Record<string, unknown>, signal?: AbortSignal): Promise<IngestOutcome> {
		const body: Record<string, unknown> = {
			...payload,
			cwd: payload.cwd ?? this.cwd,
			project: payload.project ?? this.project,
			sessionId: payload.sessionId ?? this.sessionId,
		};

		const piEvent = typeof payload.piEvent === "string" ? payload.piEvent.trim() : "";
		if (isBoundaryFlushEvent(piEvent)) {
			return this.tryCliIngest(body, signal);
		}

		if (this.config.viewerEnabled && !isStreamInBackoff(this.runtime)) {
			await this.ensureViewer(signal);
			const available = await checkIngestAvailable(this.config, this.runtime, signal);
			if (available) {
				const http = await this.tryHttpIngest(body, signal);
				if (http.ok) {
					clearStreamFailure(this.runtime);
					return {
						ok: true,
						via: "http",
						inserted: http.inserted,
						skipped: http.skipped,
					};
				}
				markStreamFailure(this.config, this.runtime);
			} else {
				markStreamFailure(this.config, this.runtime);
			}
		}

		const cli = await this.tryCliIngest(body, signal);
		return cli;
	}

	private async tryHttpIngest(
		payload: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<{ ok: boolean; inserted: number; skipped: number }> {
		const failed = { ok: false, inserted: 0, skipped: 0 };
		if (!this.config.viewerEnabled) return failed;
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		const timeout = setTimeout(() => controller.abort(), this.config.httpTimeoutMs);
		try {
			const res = await fetch(piHooksUrl(this.config), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ...payload, ...viewerRequestTarget(this.cwd) }),
				signal: controller.signal,
			});
			let parsed: unknown;
			try {
				parsed = await res.json();
			} catch {
				return failed;
			}
			if (isViewerTargetConflict(res.status, parsed) || !res.ok) return failed;
			if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
				return failed;
			}
			const obj = parsed as Record<string, unknown>;
			if (typeof obj.inserted !== "number" || typeof obj.skipped !== "number") {
				return failed;
			}
			return { ok: true, inserted: obj.inserted, skipped: obj.skipped };
		} catch {
			return failed;
		} finally {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	private async tryCliIngest(
		payload: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<IngestOutcome> {
		try {
			const piEvent = typeof payload.piEvent === "string" ? payload.piEvent.trim() : "";
			// Boundary flushes drain + finalize the LLM turn and can run far
			// longer than the HTTP ingest timeout — give them their own budget.
			const timeoutMs = isBoundaryFlushEvent(piEvent)
				? BOUNDARY_CLI_TIMEOUT_MS
				: this.config.httpTimeoutMs + 2000;
			const { stdout } = await this.execCodemem(["pi-hook-ingest"], {
				stdin: JSON.stringify(payload),
				signal,
				timeoutMs,
			});
			// CLI prints structured JSON on success/error; treat exit 0 as ok.
			let inserted = 0;
			let skipped = 0;
			try {
				const parsed = JSON.parse(stdout) as Record<string, unknown>;
				if (typeof parsed.inserted === "number") inserted = parsed.inserted;
				if (typeof parsed.skipped === "number") skipped = parsed.skipped;
			} catch {
				// human or empty output is fine
			}
			return { ok: true, via: "cli", inserted, skipped };
		} catch {
			return { ok: false, via: "cli" };
		}
	}

	/**
	 * Profile-proven POST /api/pack, then CLI pack --json / pi-hook-inject fallback.
	 * A contract-valid span-bearing response ends the chain, including a zero-item
	 * pack. `{}` and error-shaped bodies are not success and fall through.
	 * Plain-text pi-hook-inject runs only when no contract-valid response is
	 * obtainable. Span-bearing successes log `inject.pack.ok source=pi`.
	 * `opts.tokenBudget` sizes the pack request (default injectTokenBudget).
	 */
	async fetchPackText(
		context: string,
		signal?: AbortSignal,
		opts?: { tokenBudget?: number },
	): Promise<PackFetch> {
		const query = context.trim().slice(0, 500) || "recent work";
		const tokenBudget = opts?.tokenBudget ?? this.config.injectTokenBudget;
		if (this.config.viewerEnabled) {
			await this.ensureViewer(signal);
			const httpPack = await this.tryHttpPack(query, tokenBudget, signal);
			if (httpPack) return httpPack;
		}

		// CLI pack --json carries renderer item spans for injection dedup.
		try {
			const args = ["pack", query, "--json", "-n", String(this.config.injectLimit)];
			if (this.project) args.push("--project", this.project);
			args.push("--token-budget", String(tokenBudget));
			const { stdout } = await this.execCodemem(args, {
				signal,
				timeoutMs: CLI_PACK_TIMEOUT_MS,
			});
			const parsed = parseProvenPack(JSON.parse(stdout));
			if (!parsed) throw new Error("pack response is not a PackResponse");
			logFetchedPack("local", parsed, query, this.project);
			return packFetchFromProven(parsed);
		} catch {
			// Last resort: pi-hook-inject prints the framed block without span data.
		}

		try {
			const { stdout } = await this.execCodemem(["pi-hook-inject"], {
				stdin: JSON.stringify({
					prompt: context,
					context: query,
					cwd: this.cwd,
					project: this.project,
				}),
				signal,
				timeoutMs: CLI_PACK_TIMEOUT_MS,
			});
			return { text: stdout.trim(), preformatted: true };
		} catch {
			return { text: "", preformatted: false };
		}
	}

	/** Null when the viewer is unproven/unavailable; a proven success ends the pack chain. */
	private async tryHttpPack(
		context: string,
		tokenBudget: number,
		signal?: AbortSignal,
	): Promise<PackFetch | null> {
		if (!this.config.viewerEnabled) return null;
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		const timeout = setTimeout(() => controller.abort(), 2_000);
		try {
			const pack = await proveAndPostPack(this.config, {
				context,
				cwd: this.cwd,
				project: this.project,
				tokenBudget,
				signal: controller.signal,
			});
			if (!pack) return null;
			logFetchedPack("viewer", pack, context, this.project);
			return packFetchFromProven(pack);
		} catch {
			return null;
		} finally {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	async execCodemem(
		args: string[],
		opts: { stdin?: string; signal?: AbortSignal; timeoutMs?: number } = {},
	): Promise<{ stdout: string; stderr: string }> {
		if (this.execImpl) {
			return this.execImpl(args, { ...opts, cwd: this.cwd });
		}
		const timeout = opts.timeoutMs ?? 15_000;
		return new Promise((resolve, reject) => {
			let child: ReturnType<typeof execFile>;
			const onAbort = () => {
				try {
					child.kill("SIGTERM");
				} catch {
					// ignore
				}
			};
			child = execFile(
				"codemem",
				args,
				{
					cwd: this.cwd,
					env: process.env,
					timeout,
					maxBuffer: 8 * 1024 * 1024,
					killSignal: "SIGTERM",
				},
				(err, stdout, stderr) => {
					opts.signal?.removeEventListener("abort", onAbort);
					if (err) {
						const error = err as Error & { stdout?: string; stderr?: string };
						error.stdout = stdout;
						error.stderr = stderr;
						reject(error);
						return;
					}
					resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
				},
			);
			if (opts.signal) {
				if (opts.signal.aborted) onAbort();
				else opts.signal.addEventListener("abort", onAbort, { once: true });
			}
			if (opts.stdin != null && child.stdin) {
				child.stdin.write(opts.stdin);
				child.stdin.end();
			} else if (child.stdin) {
				child.stdin.end();
			}
		});
	}

	/**
	 * Project label from the nearest Git root: walks up for a directory `.git`,
	 * or a `gitdir:` file (linked worktree) resolved back to the primary
	 * checkout. Mirrors `resolveProject` in packages/core/src/project.ts —
	 * implemented locally so the runtime never imports @codemem/core.
	 */
	static projectFromCwd(cwd: string): string | null {
		let current = resolve(cwd);
		while (true) {
			const gitPath = resolve(current, ".git");
			if (existsSync(gitPath)) return projectFromGitMarker(current, gitPath);
			const parent = dirname(current);
			if (parent === current) break;
			current = parent;
		}
		return basename(resolve(cwd)) || null;
	}
}
