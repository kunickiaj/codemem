import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readViewerWriterLockOwner, viewerRuntimeDir } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/*
 * Two `codemem serve start` runs race on one database from separate processes,
 * each on its own port, with the CLI run from source. Exactly one Viewer runs;
 * the other start reports failure and leaves the running Viewer's PID record.
 */

const cliEntry = fileURLToPath(new URL("../index.ts", import.meta.url));
const cliPackageDir = dirname(dirname(cliEntry));

let directory: string;
let dbPath: string;
let env: NodeJS.ProcessEnv;
const viewerPids: number[] = [];

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-serve-race-"));
	dbPath = join(directory, "data", "mem.sqlite");
	mkdirSync(join(directory, "data"));
	mkdirSync(join(directory, "home"));
	const configPath = join(directory, "config.json");
	writeFileSync(configPath, "{}");
	// Everything the Viewer reads or writes stays in this folder.
	env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("CODEMEM_")) delete env[key];
	Object.assign(env, {
		HOME: join(directory, "home"),
		CODEMEM_DB: dbPath,
		CODEMEM_CONFIG: configPath,
		CODEMEM_KEYS_DIR: join(directory, "keys"),
		CODEMEM_EMBEDDING_DISABLED: "1",
	});
});

afterEach(async () => {
	// Every process a start may have left: the lock holder and any recorded one.
	for (const name of ["viewer.pid", "maintenance-worker.pid"]) {
		const pid = recordedPid(join(viewerRuntimeDir(dbPath), name));
		if (pid) viewerPids.push(pid);
	}
	await Promise.all([...new Set(viewerPids.splice(0))].map(stopProcess));
	rmSync(directory, { recursive: true, force: true });
});

function recordedPid(path: string): number | null {
	try {
		const pid = (JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown }).pid;
		return typeof pid === "number" ? pid : null;
	} catch {
		return null;
	}
}

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return true;
}

async function stopProcess(pid: number): Promise<void> {
	if (!isRunning(pid)) return;
	process.kill(pid, "SIGTERM");
	if (!(await waitFor(() => !isRunning(pid), 15_000))) process.kill(pid, "SIGKILL");
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => resolve(port));
		});
	});
}

function serveStart(port: number): Promise<{ port: number; code: number | null; output: string }> {
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				cliEntry,
				"serve",
				"start",
				"--db-path",
				dbPath,
				"--host",
				"127.0.0.1",
				"--port",
				String(port),
			],
			{ cwd: cliPackageDir, env, stdio: ["ignore", "pipe", "pipe"] },
		);
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk;
		});
		child.stderr.on("data", (chunk) => {
			output += chunk;
		});
		child.once("exit", (code) => resolve({ port, code, output }));
	});
}

function viewerPidRecord(): { pid: number; port: number } | null {
	const path = join(viewerRuntimeDir(dbPath), "viewer.pid");
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

describe("concurrent Viewer starts on one database", () => {
	it("runs exactly one Viewer and keeps its PID record", async () => {
		const ports = [await freePort(), await freePort()];

		const results = await Promise.all(ports.map(serveStart));
		const owner = readViewerWriterLockOwner(dbPath);
		if (owner) viewerPids.push(owner.pid);
		const transcript = JSON.stringify(results);

		expect(results.map((result) => result.code).sort(), transcript).toEqual([0, 1]);
		const winner = results.find((result) => result.code === 0);
		const loser = results.find((result) => result.code === 1);
		expect(loser?.output).toMatch(/Another codemem viewer is already using|is not answering/);
		expect(owner?.port).toBe(winner?.port);
		// The Viewer writes its record once it serves; the losing start writes none.
		expect(await waitFor(() => viewerPidRecord() !== null, 30_000), transcript).toBe(true);
		expect(viewerPidRecord()).toMatchObject({ pid: owner?.pid, port: winner?.port });
	}, 120_000);
});
