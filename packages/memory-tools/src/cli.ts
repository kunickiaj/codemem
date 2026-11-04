/**
 * `codemem` CLI runner for the fallback path when the viewer is unreachable.
 * Honors AbortSignal by sending SIGTERM to the child. A write the child has
 * already committed is still reported as a normal result, never as aborted.
 */

import { execFile } from "node:child_process";

export interface CliRunOptions {
	stdin?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

export interface CliRunResult {
	stdout: string;
	stderr: string;
}

export type CodememCliRunner = (args: string[], options?: CliRunOptions) => Promise<CliRunResult>;

export const DEFAULT_CLI_TIMEOUT_MS = 15_000;
const MAX_CLI_OUTPUT_BYTES = 8 * 1024 * 1024;

export class CliAbortedError extends Error {
	constructor() {
		super("codemem CLI call aborted");
		this.name = "CliAbortedError";
	}
}

/**
 * Parse CLI stdout that may contain log lines before a JSON payload. Scans
 * candidate JSON value starts in document order and returns the first suffix
 * that parses, so nested top-level objects are handled correctly.
 */
export function parseCliJson(stdout: string): unknown {
	const trimmed = stdout.trim();
	if (!trimmed) return null;
	for (let index = 0; index < trimmed.length; index++) {
		const char = trimmed[index];
		if (char !== "{" && char !== "[") continue;
		try {
			return JSON.parse(trimmed.slice(index));
		} catch {
			// not a parseable suffix — keep scanning
		}
	}
	return trimmed;
}

export interface CreateCliRunnerOptions {
	/** Executable name or path; defaults to `codemem` on PATH. */
	command?: string;
	/** Prepended to every invocation (for `node dist/index.js`-style launchers). */
	prefixArgs?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

export function createCodememCliRunner(defaults: CreateCliRunnerOptions = {}): CodememCliRunner {
	const command = defaults.command ?? "codemem";
	const prefixArgs = defaults.prefixArgs ?? [];
	return (args, options = {}) =>
		new Promise<CliRunResult>((resolve, reject) => {
			if (options.signal?.aborted) {
				reject(new CliAbortedError());
				return;
			}
			let aborted = false;
			const child = execFile(
				command,
				[...prefixArgs, ...args],
				{
					cwd: options.cwd ?? defaults.cwd,
					env: options.env ?? defaults.env ?? process.env,
					timeout: options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS,
					maxBuffer: MAX_CLI_OUTPUT_BYTES,
					killSignal: "SIGTERM",
				},
				(err, stdout, stderr) => {
					options.signal?.removeEventListener("abort", onAbort);
					if (aborted) {
						reject(new CliAbortedError());
						return;
					}
					if (err) {
						const error = err as Error & { stdout?: string; stderr?: string };
						error.stdout = String(stdout ?? "");
						error.stderr = String(stderr ?? "");
						reject(error);
						return;
					}
					resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
				},
			);
			const onAbort = () => {
				// A child that already exited has produced its result; let the
				// callback report it instead of claiming the work was cancelled.
				if (child.exitCode !== null || child.signalCode !== null) return;
				aborted = true;
				try {
					child.kill("SIGTERM");
				} catch {
					// already exited
				}
			};
			options.signal?.addEventListener("abort", onAbort, { once: true });
			if (!child.stdin) return;
			// Stdin larger than the pipe buffer raises EPIPE on this stream when the
			// child exits or is killed before draining it. Without a listener that is
			// an uncaught exception in the host process; the exec callback still
			// reports the exit, so the error itself carries no extra information.
			child.stdin.on("error", () => {});
			if (options.stdin != null) child.stdin.write(options.stdin);
			child.stdin.end();
		});
}
