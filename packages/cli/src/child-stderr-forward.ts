import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

export interface ChildStderrForwardOptions {
	/** Text placed before every forwarded line, such as "[maintenance-worker] ". */
	prefix: string;
	/** Receives each prefixed line, including its newline. Defaults to this process's stderr. */
	write?: (text: string) => void;
}

const defaultWrite = (text: string): void => {
	process.stderr.write(text);
};

/**
 * Copy a child process's stderr into this process's stderr one prefixed line
 * at a time, so container logs show which process wrote each line.
 *
 * The parent reads the pipe from its event loop, so the child only waits when
 * the pipe buffer (64 KiB on Linux) fills while the parent is busy. Read and
 * write errors end forwarding instead of crashing either process.
 */
export function forwardChildStderr(source: Readable, options: ChildStderrForwardOptions): void {
	const write = options.write ?? defaultWrite;
	const lines = createInterface({ input: source, crlfDelay: Number.POSITIVE_INFINITY });
	// readline re-emits input errors on the interface. A broken pipe means the
	// child is gone, so there is nothing left to forward.
	const ignorePipeError = () => undefined;
	source.on("error", ignorePipeError);
	lines.on("error", ignorePipeError);
	lines.on("line", (line) => {
		try {
			write(`${options.prefix}${line}\n`);
		} catch {
			// Losing a forwarded log line must not take down the viewer.
		}
	});
}
