import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeCommandArtifact } from "./artifacts.js";
import { ComposeManager, type RunCommandResult } from "./compose.js";
import { handleScenarioFailure, type ScenarioContext } from "./scenario-context.js";
import { redactViewerLog } from "./viewer-logs.js";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

function success(stdout = ""): RunCommandResult {
	return { command: "synthetic compose", status: 0, stdout, stderr: "", durationMs: 1 };
}

function assertRetainedLogs(artifactsDir: string): void {
	for (const artifact of ["initial", "restart-one", "restart-two"]) {
		const log = readFileSync(join(artifactsDir, `99-peer-a-${artifact}-viewer-log.json`), "utf8");
		expect(log).toContain(artifact === "restart-two" ? "startup failed" : "Listening");
	}
}

describe("detached viewer failure artifacts", () => {
	it("retains every launch, including failed second-restart output, before teardown", () => {
		const artifactsDir = mkdtempSync(join(tmpdir(), "codemem-viewer-logs-"));
		directories.push(artifactsDir);
		const launches: string[][] = [];
		const exits: Array<number | null> = [];
		const containerDir = join(artifactsDir, "container");
		mkdirSync(containerDir);
		let removed = false;
		const compose = new ComposeManager(
			{ composeFile: "synthetic.yml", projectName: "synthetic-viewer", artifactsDir },
			(_command, args, options) => {
				if (args.includes("-d")) {
					launches.push(args);
					const result = spawnSync(
						"sh",
						["-c", String(args.at(-1)).replaceAll("/tmp/", `${containerDir}/`)],
						{ encoding: "utf8" },
					);
					exits.push(result.status);
					return success();
				}
				if (args.includes("down")) {
					assertRetainedLogs(artifactsDir);
					removed = true;
					rmSync(containerDir, { recursive: true });
				}
				if (!options.artifactName.endsWith("-viewer-log")) return success();
				expect(removed).toBe(false);
				const readArgs = args
					.slice(args.indexOf("node") + 1)
					.map((arg) => arg.replaceAll("/tmp/", `${containerDir}/`));
				const captured = spawnSync("node", readArgs, { encoding: "utf8" });
				const result = {
					...success(captured.stdout),
					status: captured.status,
					stderr: captured.stderr,
				};
				writeCommandArtifact(artifactsDir, options.artifactName, result);
				return result;
			},
		);
		for (const artifact of ["initial", "restart-one", "restart-two"]) {
			const script = `if (process.argv[1] !== "argument with ' quotes") throw new Error('quoting changed');
console.log('Listening'); console.error(${JSON.stringify(artifact === "restart-two" ? "startup failed Bearer synthetic-token" : "startup stderr")});
process.exitCode = ${artifact === "restart-two" ? 7 : 0};`;
			compose.execDetachedLogged(
				"peer-a",
				["node", "-e", script, "argument with ' quotes"],
				artifact,
			);
			if (artifact !== "restart-two") compose.restart("peer-a", `${artifact}-restart`);
		}
		const failure = new Error("viewer readiness: ECONNREFUSED");
		const ctx: ScenarioContext = {
			artifactsDir,
			compose,
			keepStackOnFailure: false,
			recordNote: () => {},
			captureFailure: (error) => expect(error).toBe(failure),
		};

		expect(compose.getDetachedLogPath("peer-a")).toBe(
			"/tmp/codemem-e2e-peer-a-restart-two-viewer.log",
		);
		handleScenarioFailure(ctx, failure);
		// The runner also collects on success after a scenario may already have torn down.
		compose.captureDetachedLogs("99");

		expect(removed).toBe(true);
		expect(exits).toEqual([0, 0, 7]);
		const failedLog = readFileSync(
			join(artifactsDir, "99-peer-a-restart-two-viewer-log.json"),
			"utf8",
		);
		expect(failedLog).toContain("Bearer [redacted]");
		expect(failedLog).not.toContain("synthetic-token");
		expect(new Set(launches.map((args) => args.at(-1))).size).toBe(3);
		expect(launches[2]?.at(-1)).toContain("2>&1");
		expect(compose.getDetachedLogPath("peer-a")).toBeUndefined();
	});

	it.each([false, true])(
		"continues collecting after a capture throws with keepStack=%s",
		(keepStackOnFailure) => {
			const captures: string[] = [];
			let removed = false;
			const compose = new ComposeManager(
				{ composeFile: "synthetic.yml", projectName: "synthetic-viewer", artifactsDir: "unused" },
				(_command, args, options) => {
					if (args.includes("down")) removed = true;
					if (!options.artifactName.endsWith("-viewer-log")) return success();
					captures.push(options.artifactName);
					if (captures.length === 1) throw new Error("container unavailable");
					return success("startup failed");
				},
			);
			compose.execDetachedLogged("peer-a", ["node", "viewer.js"], "first");
			compose.execDetachedLogged("peer-b", ["node", "viewer.js"], "second");
			const failure = new Error("original readiness failure");
			handleScenarioFailure(
				{
					artifactsDir: "unused",
					compose,
					keepStackOnFailure,
					recordNote: () => {},
					captureFailure: (error) => expect(error).toBe(failure),
				},
				failure,
			);
			expect(captures).toEqual(["99-peer-a-first-viewer-log", "99-peer-b-second-viewer-log"]);
			expect(removed).toBe(!keepStackOnFailure);
		},
	);
});

describe("viewer log redaction", () => {
	it("redacts credential forms and home paths without erasing startup errors", () => {
		const text =
			"startup failed /Users/synthetic/project /home/synthetic/project " +
			"Bearer token-value api_key=key-value sync_coordinator_admin_secret: secret-value e2e-admin-secret\n" +
			'"password": "secret with spaces"\n' +
			"-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----";
		const redacted = redactViewerLog(text);
		expect(redacted).toContain("startup failed");
		for (const secret of [
			"synthetic",
			"token-value",
			"key-value",
			"secret-value",
			"e2e-admin-secret",
			"private-material",
			"secret with spaces",
		])
			expect(redacted).not.toContain(secret);
	});
});
