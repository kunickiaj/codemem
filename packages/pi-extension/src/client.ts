/**
 * PiCodememClient — HTTP preferred, CLI exec fallback.
 * Never opens the store or imports @codemem/core.
 */

import { execFile } from "node:child_process";
import type { PiExtensionConfig } from "./config.js";
import {
	apiUrl,
	checkIngestAvailable,
	clearStreamFailure,
	ensureViewerRunning,
	isStreamInBackoff,
	markStreamFailure,
	packUrl,
	piHooksUrl,
	type ViewerRuntime,
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
		if (piEvent === "session_before_compact" || piEvent === "session_shutdown") {
			return this.tryCliIngest(body, signal);
		}

		if (!isStreamInBackoff(this.runtime)) {
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
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		const timeout = setTimeout(() => controller.abort(), this.config.httpTimeoutMs);
		try {
			const res = await fetch(piHooksUrl(this.config), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
				signal: controller.signal,
			});
			if (!res.ok) return { ok: false, inserted: 0, skipped: 0 };
			let parsed: unknown;
			try {
				parsed = await res.json();
			} catch {
				return { ok: false, inserted: 0, skipped: 0 };
			}
			if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
				return { ok: false, inserted: 0, skipped: 0 };
			}
			const obj = parsed as Record<string, unknown>;
			if (typeof obj.inserted !== "number" || typeof obj.skipped !== "number") {
				return { ok: false, inserted: 0, skipped: 0 };
			}
			return { ok: true, inserted: obj.inserted, skipped: obj.skipped };
		} catch {
			return { ok: false, inserted: 0, skipped: 0 };
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
			const { stdout } = await this.execCodemem(["pi-hook-ingest"], {
				stdin: JSON.stringify(payload),
				signal,
				timeoutMs: this.config.httpTimeoutMs + 2000,
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

	/** GET /api/pack then CLI pi-hook-inject / pack --json fallback. */
	async fetchPackText(context: string, signal?: AbortSignal): Promise<string> {
		const query = context.trim().slice(0, 500) || "recent work";
		await this.ensureViewer(signal);

		const httpText = await this.tryHttpPack(query, signal);
		if (httpText) return httpText;

		// CLI pi-hook-inject already emits the ## codemem memories block.
		try {
			const { stdout } = await this.execCodemem(["pi-hook-inject"], {
				stdin: JSON.stringify({
					prompt: context,
					context: query,
					cwd: this.cwd,
					project: this.project,
				}),
				signal,
				timeoutMs: 8_000,
			});
			return stdout.trim();
		} catch {
			// Last resort: pack --json and let caller format.
			try {
				const args = ["pack", query, "--json", "-n", String(this.config.injectLimit)];
				if (this.project) args.push("--project", this.project);
				args.push("--token-budget", String(this.config.injectTokenBudget));
				const { stdout } = await this.execCodemem(args, { signal, timeoutMs: 8_000 });
				const parsed = JSON.parse(stdout) as { pack_text?: string };
				return String(parsed.pack_text ?? "").trim();
			} catch {
				return "";
			}
		}
	}

	private async tryHttpPack(context: string, signal?: AbortSignal): Promise<string> {
		const url = new URL(packUrl(this.config));
		url.searchParams.set("context", context);
		url.searchParams.set("limit", String(this.config.injectLimit));
		url.searchParams.set("token_budget", String(this.config.injectTokenBudget));
		if (this.project) url.searchParams.set("project", this.project);

		const controller = new AbortController();
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		const timeout = setTimeout(() => controller.abort(), 2_000);
		try {
			const res = await fetch(url, { signal: controller.signal });
			if (!res.ok) return "";
			const body = (await res.json()) as { pack_text?: string };
			return String(body.pack_text ?? "").trim();
		} catch {
			return "";
		} finally {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	async httpJson(
		method: "GET" | "POST",
		path: string,
		opts: {
			query?: Record<string, string | number | boolean | undefined | null>;
			body?: unknown;
			signal?: AbortSignal;
			timeoutMs?: number;
		} = {},
	): Promise<{ ok: true; status: number; data: unknown } | { ok: false; error: string }> {
		await this.ensureViewer(opts.signal);
		const url = new URL(apiUrl(this.config, path));
		if (opts.query) {
			for (const [key, value] of Object.entries(opts.query)) {
				if (value == null || value === "") continue;
				url.searchParams.set(key, String(value));
			}
		}
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		const timeout = setTimeout(
			() => controller.abort(),
			opts.timeoutMs ?? this.config.httpTimeoutMs,
		);
		try {
			const res = await fetch(url, {
				method,
				headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
				body: method === "POST" ? JSON.stringify(opts.body ?? {}) : undefined,
				signal: controller.signal,
			});
			let data: unknown = null;
			const text = await res.text();
			if (text) {
				try {
					data = JSON.parse(text);
				} catch {
					data = text;
				}
			}
			if (!res.ok) {
				const errMsg =
					data != null && typeof data === "object" && !Array.isArray(data)
						? String((data as Record<string, unknown>).error ?? res.statusText)
						: res.statusText;
				return { ok: false, error: errMsg || `HTTP ${res.status}` };
			}
			return { ok: true, status: res.status, data };
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			};
		} finally {
			clearTimeout(timeout);
			opts.signal?.removeEventListener("abort", onAbort);
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
			const child = execFile(
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
			const onAbort = () => {
				try {
					child.kill("SIGTERM");
				} catch {
					// ignore
				}
			};
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

	/** Best-effort project label from cwd basename (viewer accepts explicit project). */
	static projectFromCwd(cwd: string): string | null {
		const trimmed = cwd.trim().replace(/[/\\]+$/, "");
		if (!trimmed) return null;
		const parts = trimmed.split(/[/\\]/);
		const base = parts[parts.length - 1] ?? "";
		return base || null;
	}
}
