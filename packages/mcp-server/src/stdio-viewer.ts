import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { probeCodememViewerLiveness } from "@codemem/core";

const DEFAULT_VIEWER_HOST = "127.0.0.1";
const DEFAULT_VIEWER_PORT = "38888";
const VIEWER_PROBE_TIMEOUT_MS = 2_000;
const VIEWER_POLL_INTERVAL_MS = 1_000;
const VIEWER_POLL_ATTEMPTS = 5;

export interface ViewerChildProcess {
	on(event: "error", listener: () => void): unknown;
	unref(): void;
}

export type SpawnViewerProcess = (
	command: string,
	args: string[],
	options: {
		detached: true;
		stdio: "ignore";
		env: NodeJS.ProcessEnv;
	},
) => ViewerChildProcess;

export interface ViewerProbeOptions {
	host?: string;
	port?: string;
	fetchImpl?: typeof fetch;
}

export interface EnsureViewerOptions extends ViewerProbeOptions {
	env?: NodeJS.ProcessEnv;
	execPath?: string;
	resolveCliPath?: () => string | null;
	sleep?: (milliseconds: number) => Promise<void>;
	spawnImpl?: SpawnViewerProcess;
}

/** Resolve the `codemem` CLI binary path. Checks package-local paths first, then PATH. */
export function resolveCliPath(): string | null {
	const selfDir = dirname(import.meta.dirname ?? ".");
	const candidates = [
		join(selfDir, "..", "cli", "dist", "index.js"),
		join(selfDir, "..", ".bin", "codemem"),
		join(selfDir, "..", "..", ".bin", "codemem"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return "codemem";
}

/** Check for a live CodeMem viewer via the shared core probe contract. */
export async function isViewerHealthy(options: ViewerProbeOptions = {}): Promise<boolean> {
	const host = options.host ?? process.env.CODEMEM_VIEWER_HOST ?? DEFAULT_VIEWER_HOST;
	const rawPort = options.port ?? process.env.CODEMEM_VIEWER_PORT ?? DEFAULT_VIEWER_PORT;
	// Strict parse: "38888abc" must not silently probe a different port than
	// the `--port` value forwarded to `serve start`.
	if (!/^\d+$/.test(rawPort.trim())) return false;
	const port = Number.parseInt(rawPort, 10);
	if (!Number.isInteger(port) || port <= 0 || port > 65_535) return false;

	// A degraded-but-live viewer must not trigger redundant detached starts.
	const probe = await probeCodememViewerLiveness(
		{ host, port },
		{ fetch: options.fetchImpl ?? fetch, timeoutMs: VIEWER_PROBE_TIMEOUT_MS },
	);
	return probe.state === "live";
}

/** Attempt to start the viewer as a detached, best-effort background process. */
export async function ensureViewer(options: EnsureViewerOptions = {}): Promise<void> {
	const env = options.env ?? process.env;
	if (env.CODEMEM_VIEWER === "0" || env.CODEMEM_VIEWER_AUTO === "0") return;

	const host = options.host ?? env.CODEMEM_VIEWER_HOST ?? DEFAULT_VIEWER_HOST;
	const port = options.port ?? env.CODEMEM_VIEWER_PORT ?? DEFAULT_VIEWER_PORT;
	const probeOptions = { host, port, fetchImpl: options.fetchImpl };
	if (await isViewerHealthy(probeOptions)) return;

	const cli = (options.resolveCliPath ?? resolveCliPath)();
	if (!cli) return;

	try {
		const isJsFile = cli.endsWith(".js");
		const command = isJsFile ? (options.execPath ?? process.execPath) : cli;
		const args = isJsFile ? [cli, "serve", "start"] : ["serve", "start"];
		if (host !== DEFAULT_VIEWER_HOST) args.push("--host", host);
		if (port !== DEFAULT_VIEWER_PORT) args.push("--port", port);

		const spawnImpl: SpawnViewerProcess =
			options.spawnImpl ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
		const child = spawnImpl(command, args, {
			detached: true,
			stdio: "ignore",
			env: { ...env, CODEMEM_PLUGIN_IGNORE: "1" },
		});
		child.on("error", () => {});
		child.unref();

		const sleep =
			options.sleep ??
			((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
		for (let attempt = 0; attempt < VIEWER_POLL_ATTEMPTS; attempt++) {
			await sleep(VIEWER_POLL_INTERVAL_MS);
			if (await isViewerHealthy(probeOptions)) return;
		}
	} catch {
		// Best effort — MCP server continues regardless.
	}
}
