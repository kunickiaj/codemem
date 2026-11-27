import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";

/**
 * Test fixture: a separate process that takes the Viewer lock for `dbPath` and
 * holds it until it is signalled. It never serves HTTP. `extraArgs` end up on its
 * command line, which lets a test make it look like a Viewer command.
 */
export async function holdViewerLockInAnotherProcess(
	dbPath: string,
	options: { owner?: { host: string; port: number }; extraArgs?: string[] } = {},
): Promise<ChildProcess> {
	const script = `
		const [moduleUrl, path, owner] = process.argv.slice(1);
		const { acquireViewerWriterLock } = await import(moduleUrl);
		try {
			acquireViewerWriterLock(path, owner === "-" ? {} : { owner: JSON.parse(owner) });
			process.stdout.write("held\\n");
		} catch (error) {
			process.stdout.write(\`failed \${error.name}\\n\`);
			process.exit(3);
		}
		setInterval(() => {}, 60_000);
	`;
	const child = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			"--input-type=module",
			"-e",
			script,
			new URL("./viewer-writer-lock.ts", import.meta.url).href,
			dbPath,
			options.owner ? JSON.stringify(options.owner) : "-",
			...(options.extraArgs ?? []),
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	let output = "";
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		output += chunk;
	});
	await new Promise<void>((resolve, reject) => {
		child.stdout?.on("data", (chunk: string) => {
			output += chunk;
			if (output.includes("held\n")) resolve();
			if (output.includes("failed ")) reject(new Error(`holder could not lock: ${output}`));
		});
		child.once("exit", (code) => reject(new Error(`holder exited (${code}): ${output}`)));
	});
	return child;
}

/** Stops a holder started by `holdViewerLockInAnotherProcess` and waits for it to exit. */
export async function stopHolder(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, "exit");
	child.kill("SIGKILL");
	await exited;
}
