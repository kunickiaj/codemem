import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	executeCommand,
	historicalProcessEnvironment,
	withHistoricalObserverSubjects,
} from "./historical-observer.js";

const repositories: string[] = [];

async function command(cwd: string, executable: string, ...args: string[]): Promise<string> {
	const result = await executeCommand(executable, args, { cwd });
	if (result.exitCode !== 0)
		throw new Error(`${executable} ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

async function repository(): Promise<{ root: string; commit: string }> {
	const root = await mkdtemp(join(tmpdir(), "codemem-observer-release-"));
	repositories.push(root);
	await command(root, "git", "init", "--initial-branch=main");
	await command(root, "git", "config", "user.name", "Codemem Test");
	await command(root, "git", "config", "user.email", "codemem-test@example.invalid");
	await mkdir(join(root, "packages/core/src"), { recursive: true });
	await writeFile(join(root, ".gitignore"), ".tmp/\n", "utf8");
	await writeFile(join(root, "package.json"), '{"type":"module"}\n', "utf8");
	await writeFile(
		join(root, "packages/core/package.json"),
		'{"name":"@codemem/core","version":"0.39.1","type":"module"}\n',
		"utf8",
	);
	await writeFile(
		join(root, "packages/core/src/ingest-prompts.ts"),
		'export function buildObserverPrompt(context) { return { system: "historical", user: context.transcript }; }\n',
		"utf8",
	);
	await command(
		root,
		"git",
		"add",
		".gitignore",
		"package.json",
		"packages/core/package.json",
		"packages/core/src/ingest-prompts.ts",
	);
	await command(root, "git", "commit", "-m", "fixture");
	return { root, commit: await command(root, "git", "rev-parse", "HEAD") };
}

afterEach(async () => {
	for (const root of repositories.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("historical observer subjects", () => {
	it("resolves an immutable commit, invokes its prompt builder, and cleans only its registered worktree", async () => {
		const { root, commit } = await repository();
		let worktreePath = "";
		const executions: Array<{
			executable: string;
			args: readonly string[];
			cwd: string;
			env?: NodeJS.ProcessEnv;
		}> = [];
		const prompt = await withHistoricalObserverSubjects(
			{
				repositoryRoot: root,
				runRoot: ".tmp/release",
				runId: "run-1",
				subjects: [
					{
						label: "stable",
						requestedRef: commit,
						observerContextSchemaVersion: 1,
						sanitizedSubject: { kind: "release", version: "0.39.1" },
					},
				],
				dependencies: {
					execute: async (executable, args, options) => {
						executions.push({ executable, args, cwd: options.cwd, env: options.env });
						return await executeCommand(executable, args, options);
					},
				},
			},
			async ([subject]) => {
				if (!subject) throw new Error("historical subject missing");
				worktreePath = subject.worktreePath;
				return await subject.buildObserverPrompt({
					project: null,
					userPrompt: "",
					promptNumber: 1,
					transcript: "historical transcript",
					toolEvents: [],
					lastAssistantMessage: null,
					includeSummary: false,
					diffSummary: "",
					recentFiles: "",
				});
			},
		);
		expect(prompt).toEqual({ system: "historical", user: "historical transcript" });
		const driverExecution = executions.find((entry) => entry.executable === process.execPath);
		expect(driverExecution).toMatchObject({ cwd: worktreePath });
		expect(driverExecution?.env?.NODE_OPTIONS).toBeUndefined();
		expect(driverExecution?.env?.GIT_CONFIG_COUNT).toBeUndefined();
		const addIndex = executions.findIndex(
			(entry) =>
				entry.executable === "git" && entry.args[0] === "worktree" && entry.args[1] === "add",
		);
		expect(addIndex).toBeGreaterThan(0);
		expect(
			executions
				.slice(0, addIndex)
				.some((entry) => entry.args[0] === "worktree" && entry.args[1] === "prune"),
		).toBe(true);
		await expect(stat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("allowlists historical process environment variables", () => {
		expect(
			historicalProcessEnvironment({
				PATH: "/usr/bin",
				HOME: "/home/test",
				NODE_OPTIONS: "--import ./inject.mjs",
				GIT_CONFIG_COUNT: "1",
				CODEMEM_OBSERVER_API_KEY: "secret",
			}),
		).toEqual({ PATH: "/usr/bin", HOME: "/home/test" });
	});

	it("rejects revision expressions before worktree mutation", async () => {
		const { root } = await repository();
		await expect(
			withHistoricalObserverSubjects(
				{
					repositoryRoot: root,
					runRoot: ".tmp/release",
					runId: "run-2",
					subjects: [
						{
							label: "bad",
							requestedRef: "main~1",
							observerContextSchemaVersion: 1,
							sanitizedSubject: { kind: "candidate", version: "0.40.0" },
						},
					],
				},
				async () => undefined,
			),
		).rejects.toMatchObject({ code: "invalid_input" });
	});

	it("rejects a declared version that does not match the resolved commit", async () => {
		const { root, commit } = await repository();
		await expect(
			withHistoricalObserverSubjects(
				{
					repositoryRoot: root,
					runRoot: ".tmp/release",
					runId: "run-3",
					subjects: [
						{
							label: "mismatch",
							requestedRef: commit,
							observerContextSchemaVersion: 1,
							sanitizedSubject: { kind: "candidate", version: "0.40.0" },
						},
					],
				},
				async () => undefined,
			),
		).rejects.toMatchObject({ code: "version_mismatch" });
		expect(await command(root, "git", "worktree", "list", "--porcelain")).not.toContain("run-3");
	});

	it("cleans a stale deterministic run namespace before recreating subjects", async () => {
		const { root, commit } = await repository();
		let stalePath = "";
		await withHistoricalObserverSubjects(
			{
				repositoryRoot: root,
				runRoot: ".tmp/release",
				runId: "reused-run",
				retention: "keep",
				subjects: [
					{
						label: "stable",
						requestedRef: commit,
						observerContextSchemaVersion: 1,
						sanitizedSubject: { kind: "release", version: "0.39.1" },
					},
				],
			},
			async ([subject]) => {
				if (!subject) throw new Error("historical subject missing");
				stalePath = subject.worktreePath;
			},
		);
		await expect(stat(stalePath)).resolves.toBeDefined();
		await withHistoricalObserverSubjects(
			{
				repositoryRoot: root,
				runRoot: ".tmp/release",
				runId: "reused-run",
				subjects: [
					{
						label: "stable",
						requestedRef: commit,
						observerContextSchemaVersion: 1,
						sanitizedSubject: { kind: "release", version: "0.39.1" },
					},
				],
			},
			async ([subject]) => {
				if (!subject) throw new Error("historical subject missing");
				expect(subject.worktreePath).toBe(stalePath);
			},
		);
		await expect(stat(stalePath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("preserves the original execution error when cleanup also fails", async () => {
		const { root, commit } = await repository();
		const original = new Error("original failure");
		let caught: unknown;
		try {
			await withHistoricalObserverSubjects(
				{
					repositoryRoot: root,
					runRoot: ".tmp/release",
					runId: "cleanup-failure",
					subjects: [
						{
							label: "stable",
							requestedRef: commit,
							observerContextSchemaVersion: 1,
							sanitizedSubject: { kind: "release", version: "0.39.1" },
						},
					],
					dependencies: {
						execute: async (executable, args, options) => {
							if (executable === "git" && args[0] === "worktree" && args[1] === "remove") {
								return { exitCode: 1, stdout: "", stderr: "cleanup failed" };
							}
							return await executeCommand(executable, args, options);
						},
					},
				},
				async () => {
					throw original;
				},
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBe(original);
		expect((caught as Error & { cleanupError?: unknown }).cleanupError).toMatchObject({
			code: "cleanup_failed",
		});
	});
});
