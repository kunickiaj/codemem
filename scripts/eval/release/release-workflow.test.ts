import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PREFLIGHT_PATH = fileURLToPath(
	new URL("../../../scripts/release-tag-preflight.sh", import.meta.url),
);

interface WorkflowJob {
	needs: Set<string>;
	source: string;
}

async function source(path: string): Promise<string> {
	return await readFile(new URL(`../../../${path}`, import.meta.url), "utf8");
}

function parseWorkflowJobs(workflow: string): Map<string, WorkflowJob> {
	const jobs = new Map<string, WorkflowJob>();
	let inJobs = false;
	let currentName: string | null = null;
	for (const line of workflow.split("\n")) {
		if (line === "jobs:") {
			inJobs = true;
			continue;
		}
		if (!inJobs) continue;
		const jobMatch = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
		if (jobMatch) {
			const name = jobMatch[1];
			if (!name) throw new Error("Workflow fixture invariant failed: job name is missing");
			currentName = name;
			jobs.set(name, { needs: new Set(), source: `${line}\n` });
			continue;
		}
		if (!currentName) continue;
		const job = jobs.get(currentName);
		if (!job) throw new Error(`Workflow fixture invariant failed: job ${currentName} disappeared`);
		job.source += `${line}\n`;
		const needsMatch = line.match(/^ {4}needs:\s*(.+)\s*$/);
		if (!needsMatch) continue;
		const raw = needsMatch[1]?.trim();
		if (!raw) throw new Error(`Workflow fixture invariant failed: ${currentName} needs is empty`);
		const names = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1).split(",") : [raw];
		for (const name of names.map((value) => value.trim()).filter(Boolean)) job.needs.add(name);
	}
	return jobs;
}

function referencedNeeds(job: WorkflowJob): Set<string> {
	return new Set(
		Array.from(job.source.matchAll(/needs\.([A-Za-z0-9_-]+)/g), (match) => match[1]).filter(
			(value): value is string => value !== undefined,
		),
	);
}

function needsGraphViolations(jobs: Map<string, WorkflowJob>): string[] {
	return [...jobs].flatMap(([name, job]) =>
		[...referencedNeeds(job)]
			.filter((referenced) => !job.needs.has(referenced))
			.map((referenced) => `${name} references needs.${referenced} indirectly`),
	);
}

function workflowExpression(value: string): string {
	return `${"$"}{{ ${value} }}`;
}

async function writeExecutable(path: string, body: string): Promise<void> {
	await writeFile(path, body, "utf8");
	await chmod(path, 0o755);
}

async function runPreflight(input: {
	attestation: "required" | "not_required" | "unknown";
	createAttestation?: boolean;
	distTag: "latest" | "rc";
	pnpmExitCode?: number;
	prerelease: "true" | "false";
	releaseTag: string;
}): Promise<{
	exitCode: number;
	pnpmArgs: string | null;
	stdout: string;
	stderr: string;
	pnpmInvoked: boolean;
}> {
	const root = await mkdtemp(join(tmpdir(), "codemem-release-preflight-test-"));
	const bin = join(root, "bin");
	const pnpmMarker = join(root, "pnpm-invoked");
	const attestationPath = join(
		root,
		"scripts/eval/baselines/releases/v0.40.0/release-attestation-v1.json",
	);
	await mkdir(bin);
	try {
		if (input.createAttestation) {
			await mkdir(dirname(attestationPath), { recursive: true });
			await writeFile(attestationPath, "{}\n", "utf8");
		}
		await writeExecutable(
			join(bin, "git"),
			`#!/bin/sh
case "$1" in
  rev-parse) printf '%s\\n' '${"a".repeat(40)}' ;;
  fetch|merge-base|for-each-ref) exit 0 ;;
  *) exit 0 ;;
esac
`,
		);
		await writeExecutable(
			join(bin, "node"),
			`#!/bin/sh
if [ "$2" = "parse" ]; then
  printf '%s\\n' \\
    'release-version=0.40.0' \\
    'dist-tag=${input.distTag}' \\
    'prerelease=${input.prerelease}' \\
    'attestation=${input.attestation}' \\
    'attestation-path=scripts/eval/baselines/releases/v0.40.0/release-attestation-v1.json'
fi
exit 0
`,
		);
		await writeExecutable(
			join(bin, "pnpm"),
			`#!/bin/sh
printf '%s\\n' "$*" > "$PNPM_MARKER"
exit ${input.pnpmExitCode ?? 0}
`,
		);
		const result = await new Promise<{
			exitCode: number;
			stdout: string;
			stderr: string;
		}>((resolveResult, reject) => {
			const child = spawn("bash", [PREFLIGHT_PATH], {
				cwd: root,
				env: {
					...process.env,
					GITHUB_ACTIONS: "1",
					PATH: `${bin}:${process.env.PATH ?? ""}`,
					PNPM_MARKER: pnpmMarker,
					RELEASE_TAG: input.releaseTag,
					RELEASE_TAG_COMMIT: "a".repeat(40),
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk;
			});
			child.once("error", reject);
			child.once("close", (code) => resolveResult({ exitCode: code ?? 1, stdout, stderr }));
		});
		const pnpmArgs = await readFile(pnpmMarker, "utf8").then(
			(contents) => contents.trim(),
			() => null,
		);
		return { ...result, pnpmArgs, pnpmInvoked: pnpmArgs !== null };
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("stable-only release attestation policy", () => {
	it("fails stable preflight when deterministic evidence is missing", async () => {
		const result = await runPreflight({
			attestation: "required",
			distTag: "latest",
			prerelease: "false",
			releaseTag: "v0.40.0",
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("stable release attestation is missing");
		expect(result.pnpmInvoked).toBe(false);
	});

	it("propagates a nonzero stable attestation verifier exit code", async () => {
		const input = {
			attestation: "required",
			createAttestation: true,
			distTag: "latest",
			pnpmExitCode: 23,
			prerelease: "false",
			releaseTag: "v0.40.0",
		} as const;

		const result = await runPreflight(input);

		expect(result.exitCode).toBe(23);
		expect(result.pnpmInvoked).toBe(true);
		expect(result.pnpmArgs).toBe(
			"run eval:release -- verify --report scripts/eval/baselines/releases/v0.40.0/release-attestation-v1.json",
		);
		expect(result.stdout).not.toContain("Release tag preflight passed");
	});

	it("passes stable preflight when the attestation verifier returns zero", async () => {
		const input = {
			attestation: "required",
			createAttestation: true,
			distTag: "latest",
			pnpmExitCode: 0,
			prerelease: "false",
			releaseTag: "v0.40.0",
		} as const;

		const result = await runPreflight(input);

		expect(result.exitCode).toBe(0);
		expect(result.pnpmInvoked).toBe(true);
		expect(result.pnpmArgs).toBe(
			"run eval:release -- verify --report scripts/eval/baselines/releases/v0.40.0/release-attestation-v1.json",
		);
		expect(result.stdout).toContain("Release tag preflight passed");
	});

	it("skips recognized prereleases without invoking attestation verification", async () => {
		const result = await runPreflight({
			attestation: "not_required",
			distTag: "rc",
			prerelease: "true",
			releaseTag: "v0.40.0-rc.1",
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("attestation not_required");
		expect(result.pnpmInvoked).toBe(false);
	});

	it("rejects unknown attestation policy output", async () => {
		const result = await runPreflight({
			attestation: "unknown",
			distTag: "latest",
			prerelease: "false",
			releaseTag: "v0.40.0",
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("unsupported attestation policy 'unknown'");
		expect(result.pnpmInvoked).toBe(false);
	});

	it("requires every needs-context reference to name a direct dependency", async () => {
		const jobs = parseWorkflowJobs(await source(".github/workflows/release.yml"));
		expect(needsGraphViolations(jobs)).toEqual([]);
	});

	it("detects a transitive needs-context reference like the prior release wiring bug", () => {
		const broken = `jobs:
  preflight-tag:
    runs-on: ubuntu-latest
  publish-npm:
    needs: preflight-tag
    runs-on: ubuntu-latest
  release:
    needs: [publish-npm]
    if: ${workflowExpression("needs.preflight-tag.result == 'success'")}
    runs-on: ubuntu-latest
`;
		expect(needsGraphViolations(parseWorkflowJobs(broken))).toEqual([
			"release references needs.preflight-tag indirectly",
		]);
	});

	it("wires GitHub Release directly to preflight and publish with fail-closed policy", async () => {
		const jobs = parseWorkflowJobs(await source(".github/workflows/release.yml"));
		const release = jobs.get("release");
		if (!release) throw new Error("Workflow fixture invariant failed: release job is missing");
		expect(release.needs).toEqual(new Set(["preflight-tag", "publish-npm"]));
		expect(release.source).toContain("needs.preflight-tag.result == 'success'");
		expect(release.source).toContain("needs.publish-npm.result == 'success'");
		expect(release.source).toContain('case "$PRERELEASE" in');
		expect(release.source).toContain('true) PRERELEASE_FLAG="--prerelease"');
		expect(release.source).toContain('false) PRERELEASE_FLAG=""');
		expect(release.source).toContain("invalid prerelease policy");
		expect(release.source).toMatch(/\*\)[\s\S]*invalid prerelease policy[\s\S]*exit 1[\s\S]*esac/);
	});

	it("runs release-version parser tests in the standard local and CI gates", async () => {
		const packageJson = JSON.parse(await source("package.json")) as {
			scripts?: Record<string, string>;
		};
		const check = packageJson.scripts?.check;
		if (!check) throw new Error("Package fixture invariant failed: check script is missing");
		expect(check).toContain("pnpm run test:release-version");

		const ci = await source(".github/workflows/ci.yml");
		expect(ci).toContain("run: pnpm run test:release-version");

		const lint = packageJson.scripts?.lint;
		const format = packageJson.scripts?.format;
		if (!lint || !format)
			throw new Error("Package fixture invariant failed: lint or format script is missing");
		for (const path of ["scripts/release-version.mjs", "scripts/release-version.test.mjs"]) {
			expect(lint).toContain(path);
			expect(format).toContain(path);
		}
	});
});
