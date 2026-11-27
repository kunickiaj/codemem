import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";

/**
 * Test fixture: a separate process that takes the Viewer lock for `dbPath` and
 * holds it until it is signalled.
 *
 * - `owner`: records the holder, as a Viewer does.
 * - `answerAsViewer`: also answers the Viewer health and stats routes on that
 *   port, so liveness probes see a codemem Viewer there.
 * - `lock: false`: takes no lock, like a Viewer from a release before the lock.
 * - `extraArgs` end up on its command line, which lets a test make it look like
 *   a Viewer command.
 */
export async function holdViewerLockInAnotherProcess(
	dbPath: string,
	options: {
		owner?: { host: string; port: number };
		answerAsViewer?: { host: string; port: number };
		lock?: boolean;
		extraArgs?: string[];
	} = {},
): Promise<ChildProcess> {
	const script = `
		const [moduleUrl, path, owner, lock, serve] = process.argv.slice(1);
		const { acquireViewerWriterLock } = await import(moduleUrl);
		try {
			// Keep a reference: a collected lock connection closes and releases the lock.
			if (lock === "lock")
				globalThis.heldViewerLock = acquireViewerWriterLock(
					path,
					owner === "-" ? {} : { owner: JSON.parse(owner) },
				);
		} catch (error) {
			process.stdout.write(\`failed \${error.name}\\n\`);
			process.exit(3);
		}
		if (serve !== "-") {
			const { host, port } = JSON.parse(serve);
			const { createServer } = await import("node:http");
			const health = { service: "codemem-viewer", ready: true, database: { reachable: true } };
			const server = createServer((request, response) => {
				const body = request.url === "/api/stats" ? { viewer_pid: process.pid } : health;
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify(body));
			});
			await new Promise((resolve) => server.listen(port, host, resolve));
		}
		process.stdout.write("held\\n");
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
			options.lock === false ? "no-lock" : "lock",
			options.answerAsViewer ? JSON.stringify(options.answerAsViewer) : "-",
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
