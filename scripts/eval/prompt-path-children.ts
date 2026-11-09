import { type ChildProcess, spawn } from "node:child_process";

export const ownedChildren = new Set<ChildProcess>();

export class CommandInterruptedError extends Error {
	constructor() {
		super("command timed out or interrupted");
		this.name = "CommandInterruptedError";
	}
}

interface CommandResult {
	exitCode: number;
	stdout: string;
}

interface CommandOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	stdin?: string;
	timeoutMs?: number;
	detached?: boolean;
	stopGroupOnExit?: boolean;
	signal?: AbortSignal;
}

export function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.pid) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {
			// Non-detached children do not have their own group.
		}
	}
	try {
		child.kill(signal);
	} catch {
		// The child may already have exited.
	}
}

function processGroupExists(child: ChildProcess): boolean {
	if (!child.pid) return false;
	try {
		process.kill(-child.pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		// macOS can return EPERM while a killed orphan is being reaped. This
		// does not confirm absence: keep polling and fail if the deadline expires.
		if (code === "EPERM") return true;
		throw error;
	}
}

async function stopProcessGroup(child: ChildProcess): Promise<void> {
	killProcessGroup(child, "SIGKILL");
	const deadline = performance.now() + 5_000;
	while (processGroupExists(child)) {
		if (performance.now() >= deadline) throw new Error("phase descendants did not exit");
		await new Promise((done) => setTimeout(done, 25));
	}
}

function commandTermination(child: ChildProcess, options: CommandOptions) {
	let interrupted = false;
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	let notifyInterrupted: () => void;
	const interruption = new Promise<void>((resolve) => {
		notifyInterrupted = resolve;
	});
	const terminate = () => {
		if (interrupted) return;
		interrupted = true;
		killProcessGroup(child, "SIGTERM");
		killTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), 1_000);
		notifyInterrupted();
	};
	const timer = setTimeout(terminate, options.timeoutMs ?? 120_000);
	options.signal?.addEventListener("abort", terminate, { once: true });
	if (options.signal?.aborted) terminate();
	return {
		interruption,
		wasInterrupted: () => interrupted,
		finish: async () => {
			clearTimeout(timer);
			clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", terminate);
			// A non-detached command shares its phase owner's group. Only the
			// owner can stop that group without killing the phase worker itself.
			if (options.detached !== false && (options.stopGroupOnExit || interrupted))
				await stopProcessGroup(child);
			ownedChildren.delete(child);
		},
	};
}

function completedCommandResult(
	code: number | null,
	output: { stdout: string; stderr: string; spawnError?: Error; interrupted: boolean },
): CommandResult {
	if (output.spawnError) throw output.spawnError;
	if (output.interrupted) throw new CommandInterruptedError();
	if (code !== 0)
		throw new Error(`command failed with exit ${code ?? 1} (stderr ${output.stderr.length} bytes)`);
	return { exitCode: 0, stdout: output.stdout };
}

function finishAfterInterruption(
	child: ChildProcess,
	interruption: Promise<void>,
	finish: (code: number | null) => void,
): Promise<void> {
	return interruption.then(() => {
		// Exit may precede the timeout while descendants still retain stdio.
		// A live child must still exit before its termination cleanup finishes.
		if (child.exitCode !== null || child.signalCode !== null) finish(child.exitCode);
	});
}

export function runCommand(
	command: string,
	args: readonly string[],
	options: CommandOptions,
): Promise<CommandResult> {
	return new Promise((resolveCommand, rejectCommand) => {
		const child = spawn(command, [...args], {
			cwd: options.cwd,
			env: options.env,
			detached: options.detached ?? true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		ownedChildren.add(child);
		const termination = commandTermination(child, options);
		let stdout = "";
		let stderr = "";
		let spawnError: Error | undefined;
		let finishing = false;
		let resolveClose: () => void;
		const closed = new Promise<void>((resolve) => {
			resolveClose = resolve;
		});
		const finish = (code: number | null) => {
			if (finishing) return;
			finishing = true;
			const interruptedInPhase = options.detached === false && termination.wasInterrupted();
			if (interruptedInPhase) {
				// Descendants may retain these pipes after the immediate child exits.
				// Disconnect now so the worker can fail and its owner can reap the group.
				child.stdin.destroy();
				child.stdout.destroy();
				child.stderr.destroy();
			}
			void termination
				.finish()
				.then(async () => {
					if (!interruptedInPhase) await closed;
					resolveCommand(
						completedCommandResult(code, {
							stdout,
							stderr,
							spawnError,
							interrupted: termination.wasInterrupted(),
						}),
					);
				})
				.catch(rejectCommand);
		};
		void finishAfterInterruption(child, termination.interruption, finish).catch(rejectCommand);
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.once("error", (error) => {
			spawnError = error;
		});
		child.once("exit", (code) => {
			// Group cleanup must start before close: descendants can also inherit
			// the outer worker's pipes and keep close pending indefinitely.
			if (options.stopGroupOnExit || (options.detached === false && termination.wasInterrupted()))
				finish(code);
		});
		child.once("close", (code) => {
			resolveClose();
			finish(code);
		});
		child.stdin.on("error", () => undefined);
		child.stdin.end(options.stdin);
	});
}

export async function stopOwnedChildren(): Promise<void> {
	const children = [...ownedChildren];
	for (const child of children) killProcessGroup(child, "SIGTERM");
	if (children.length > 0) await new Promise((done) => setTimeout(done, 1_000));
	for (const child of children) killProcessGroup(child, "SIGKILL");
	ownedChildren.clear();
}
