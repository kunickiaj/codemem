import assert from "node:assert/strict";
import { type ChildProcess, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { MemoryStore as Store } from "@codemem/core";
import {
	applyEnvironment,
	benchmarkEnvironment,
	createMessageOutput,
	type Hook,
	type PluginFactory,
	readSubprocessCounts,
	reservePort,
	runCommand,
	runnerSource,
	settlePluginStartupChecks,
	startViewer,
	stopOwnedChildren,
	stopViewer,
	waitFor,
	waitForViewer,
} from "./prompt-path.js";
import { parseSubprocessLog, subprocessActivitySettled } from "./prompt-path-lib.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixturePath = "scripts/eval/fixtures/automatic-recall-pre-policy.json";
const manifest = JSON.parse(
	readFileSync(join(root, "scripts/eval/automatic-recall-pre-policy.json"), "utf8"),
);
const fixture = JSON.parse(readFileSync(join(root, fixturePath), "utf8")) as {
	fixture_id: string;
	query: string;
	explicit_control_query: string;
	project: string;
	requester_host_session_id: string;
	limit: number;
	core_token_budget: number;
	sessions: Array<{
		host_session_id: string;
		started_at: string;
		memories: Array<{
			key: string;
			kind: string;
			title: string;
			body: string;
			confidence: number;
			tags: string[];
			metadata: Record<string, unknown>;
			created_at: string;
		}>;
	}>;
};
const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const scratch = join(root, ".tmp");
mkdirSync(scratch, { recursive: true });

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const fields = Object.entries(value).sort(([left], [right]) => left.localeCompare(right, "en"));
		return `{${fields.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
	}
	return JSON.stringify(value) as string;
}

function fixtureDigest() {
	const digest = sha(canonicalJson(JSON.parse(readFileSync(join(root, fixturePath), "utf8"))));
	assert.equal(digest, manifest.gates.incident_fixture_digest, "canonical fixture digest mismatch");
	return digest;
}

function sourceEvidence(source: string) {
	const paths = git(
		"ls-tree",
		"-r",
		"--name-only",
		manifest.source.commit,
		"packages",
		"pnpm-lock.yaml",
	)
		.toString()
		.trim()
		.split("\n")
		.sort();
	const hashes = paths.map((path) => [path, sha(readFileSync(join(source, path)))]);
	return {
		tracked_source_sha256: sha(JSON.stringify(hashes)),
		blobs: Object.fromEntries(
			Object.keys(manifest.source.blobs).map((path) => [
				path,
				execFileSync("git", ["hash-object", join(source, path)], { cwd: root })
					.toString()
					.trim(),
			]),
		),
		version: JSON.parse(readFileSync(join(source, "packages/core/package.json"), "utf8")).version,
	};
}

function seed(store: Store) {
	for (const session of fixture.sessions) {
		const id = store.getOrCreateSessionForOpencodeSession({
			opencodeSessionId: session.host_session_id,
			project: fixture.project,
			startedAt: session.started_at,
		});
		for (const memory of session.memories) {
			const memoryId = store.remember(
				id,
				memory.kind,
				memory.title,
				memory.body,
				memory.confidence,
				memory.tags,
				memory.metadata,
			);
			store.db
				.prepare("UPDATE memory_items SET created_at = ?, updated_at = ? WHERE id = ?")
				.run(memory.created_at, memory.created_at, memoryId);
		}
	}
}

function outcome(text: string, options: { summaryEligible?: boolean } = {}) {
	const memories = fixture.sessions.flatMap((session) => session.memories);
	const selected = memories
		.filter((memory) => text.includes(memory.body))
		.map((memory) => memory.key)
		.sort();
	return {
		selected_keys: selected,
		useful_fact_coverage: {
			present: Number(selected.includes("relevant_durable_parallel_fact")),
			total: 1,
		},
		wrongful_summary_inclusion: {
			count: Number(!options.summaryEligible && selected.includes("newest_unrelated_continuity")),
			total: Number(!options.summaryEligible),
		},
		missed_updates: { count: 0, total: 0 },
		estimated_tokens: { new: Math.ceil(text.length / 4), retained: 0 },
	};
}

async function evaluate(source: string, policy: "baseline" | "candidate") {
	const sourceModule = await import(pathToFileURL(join(source, "packages/core/src/index.ts")).href);
	const { CodememPlugin } = (await import(
		pathToFileURL(join(source, "packages/opencode-plugin/.opencode/plugins/codemem.js")).href
	)) as { CodememPlugin: PluginFactory };
	const results: Results = {};
	for (const transport of ["viewer", "cli"] as const) {
		for (const identity of ["mapped", "unmapped", "missing", "summary_owner_control"] as const) {
			Object.assign(
				results,
				await evaluateCase(
					{ source, policy, transport, identity },
					CodememPlugin,
					sourceModule.MemoryStore,
				),
			);
		}
	}
	return results;
}

type Results = Record<
	string,
	ReturnType<typeof outcome> & {
		pack_children: number;
		compression_mode: string | undefined;
	}
>;
type Case = {
	source: string;
	policy: "baseline" | "candidate";
	transport: "viewer" | "cli";
	identity: "mapped" | "unmapped" | "missing" | "summary_owner_control";
};

function caseEnvironment(source: string) {
	const temp = mkdtempSync(join(scratch, "recall-transport-"));
	const paths = {
		root: source,
		db: join(temp, "fixture.sqlite"),
		config: join(temp, "config.toml"),
		runtimeRoot: join(temp, "runtime"),
		runner: join(temp, "runner.mjs"),
		counter: join(temp, "children.log"),
	};
	writeFileSync(paths.config, "");
	writeFileSync(paths.runner, runnerSource());
	writeFileSync(paths.counter, "");
	const env = {
		...benchmarkEnvironment(process.env, paths),
		CODEMEM_PROJECT: fixture.project,
		CODEMEM_EMBEDDING_DISABLED: "1",
		CODEMEM_PACK_COMPRESSION: "off",
		CODEMEM_INJECT_RETAINED_TOKEN_BUDGET: "0",
		CODEMEM_INJECT_TOKEN_BUDGET: "800",
		CODEMEM_INJECT_LIMIT: String(fixture.limit),
		NODE_OPTIONS: `--import=${pathToFileURL(join(root, "scripts/eval/automatic-recall-clock.mjs")).href}`,
	};
	return { temp, paths, env };
}

async function evaluateCase(test: Case, plugin: PluginFactory, MemoryStore: typeof Store) {
	const { temp, paths, env } = caseEnvironment(test.source);
	const restore = applyEnvironment(env);
	const originalFetch = globalThis.fetch;
	let viewer: ChildProcess | undefined;
	const store = new MemoryStore(paths.db);
	try {
		seed(store);
		await store.flushPendingVectorWrites();
		const port = await reservePort();
		if (test.transport === "viewer") {
			viewer = startViewer(test.source, port, env);
			await waitForViewer(port, viewer);
		} else {
			// Reject only this Viewer origin so a foreign listener cannot win the reserved-port race.
			globalThis.fetch = async (input, init) => {
				const url = input instanceof Request ? input.url : String(input);
				if (new URL(url).origin === `http://127.0.0.1:${port}`) {
					throw new TypeError("fixture Viewer network unavailable");
				}
				return originalFetch(input, init);
			};
		}
		process.env.CODEMEM_VIEWER_PORT = String(port);
		const hooks = await plugin({
			project: { name: fixture.project },
			client: { app: { log: async () => undefined }, tui: {} },
			directory: temp,
			worktree: temp,
		});
		await settlePluginStartupChecks(paths.counter);
		const result = await inject(test, hooks, paths.counter);
		const results: Results = { [`${test.transport}_${test.identity}`]: result };
		if (test.transport === "cli" && test.identity === "mapped") {
			Object.assign(results, await explicitControls(paths.runner, test.source, env));
		}
		return results;
	} finally {
		if (viewer) await stopViewer(viewer);
		await stopOwnedChildren();
		store.close();
		globalThis.fetch = originalFetch;
		restore();
	}
}

async function inject(test: Case, hooks: Record<string, unknown>, counter: string) {
	const before = readSubprocessCounts(counter);
	let sessionID = fixture.requester_host_session_id;
	if (test.identity === "unmapped") sessionID = "host-unmapped-fixture";
	if (test.identity === "missing") sessionID = "";
	const summaryEligible = test.identity === "summary_owner_control";
	if (summaryEligible) {
		const owner = fixture.sessions.find((session) =>
			session.memories.some((memory) => memory.key === "newest_unrelated_continuity"),
		);
		assert.ok(owner);
		sessionID = owner.host_session_id;
	}
	const output = createMessageOutput(0, sessionID);
	const prompt = output.messages[0]?.parts[0];
	assert.ok(prompt);
	prompt.text = fixture.query;
	await (hooks["experimental.chat.messages.transform"] as Hook)({ sessionID }, output);
	if (test.transport === "cli") {
		await waitFor(
			() => {
				const activity = parseSubprocessLog(readFileSync(counter, "utf8"));
				return (
					activity.counts.pack > before.pack &&
					activity.counts.ledger > before.ledger &&
					subprocessActivitySettled(activity)
				);
			},
			30_000,
			"CLI pack and delivery did not execute",
		);
	}
	const text = output.messages
		.flatMap((message) => message.parts)
		.filter((part) => part.synthetic && part.id.startsWith("codemem-context-"))
		.map((part) => part.text)
		.join("\n");
	const label = `${test.policy}/${test.transport}/${test.identity}`;
	assert.ok(text.startsWith("[codemem context]"), `${label}: injection absent`);
	const result = outcome(text, { summaryEligible });
	assert.equal(result.useful_fact_coverage.present, 1, `${label}: durable lost`);
	assert.equal(
		result.wrongful_summary_inclusion.count,
		Number(test.policy === "baseline" && !summaryEligible),
		`${label}: summary policy`,
	);
	assert.ok(result.estimated_tokens.new <= 800);
	if (summaryEligible) assert.ok(result.selected_keys.includes("newest_unrelated_continuity"));
	return { ...result, ...transportEvidence(counter, before, test.transport) };
}

function transportEvidence(
	counter: string,
	before: ReturnType<typeof readSubprocessCounts>,
	transport: Case["transport"],
) {
	const children = readSubprocessCounts(counter);
	assert.equal(children.failed, 0);
	assert.equal(children.pack - before.pack, Number(transport === "cli"));
	assert.equal(children.ledger - before.ledger, Number(transport === "cli"));
	assert.equal(children.other, before.other);
	return {
		pack_children: children.pack - before.pack,
		compression_mode: process.env.CODEMEM_PACK_COMPRESSION,
	};
}

async function explicitControls(runner: string, source: string, env: NodeJS.ProcessEnv) {
	const results: Results = {};
	// Explicit retrieval is a real uninstrumented CLI call, not an automatic plugin query.
	for (const [name, query] of [
		["explicit_control", fixture.explicit_control_query],
		["generic_control", fixture.query],
	] as const) {
		const response = await runCommand(
			process.execPath,
			[
				runner,
				"pack",
				query,
				"--json",
				"--project",
				fixture.project,
				"--limit",
				String(fixture.limit),
				"--token-budget",
				String(fixture.core_token_budget),
			],
			{ cwd: source, env },
		);
		const control = outcome(JSON.parse(response.stdout).pack_text);
		assert.equal(control.useful_fact_coverage.present, 1);
		assert.equal(control.wrongful_summary_inclusion.count, Number(name === "generic_control"));
		results[name] = {
			...control,
			pack_children: 1,
			compression_mode: env.CODEMEM_PACK_COMPRESSION,
		};
	}
	return results;
}

function prepareHistoricalSource() {
	assert.equal(process.versions.node.split(".")[0], "24");
	const frozenFixture = JSON.parse(readFileSync(join(root, fixturePath), "utf8"));
	assert.equal(
		Date.now(),
		new Date(frozenFixture.clock).getTime(),
		"run with automatic-recall-clock.mjs preload",
	);
	const pnpm = execFileSync("pnpm", ["--version"], { cwd: root }).toString().trim();
	assert.equal(
		`pnpm@${pnpm}`,
		JSON.parse(readFileSync(join(root, "package.json"), "utf8")).packageManager,
	);
	assert.deepEqual(
		readFileSync(join(root, fixturePath)),
		git("show", `${manifest.artifacts.frozen_harness_commit}:${fixturePath}`),
	);
	const historical = execFileSync(
		process.execPath,
		["scripts/eval/run-automatic-recall-baseline.mjs"],
		{ cwd: root, encoding: "utf8", timeout: 90_000 },
	);
	assert.match(historical, /12 passed/);
	const snapshot = historical.match(/Baseline snapshot: (.+)/)?.[1];
	assert.ok(snapshot);
	// The original runner links workspace dependencies; the canonical plugin also has nested SDK dependencies.
	const nested = join(snapshot, "packages/opencode-plugin/.opencode/node_modules");
	const installedNested = join(root, "packages/opencode-plugin/.opencode/node_modules");
	if (!existsSync(nested) && existsSync(installedNested))
		symlinkSync(installedNested, nested, "dir");
	return { snapshot, pnpm };
}

function reportProvenance(pnpm: string) {
	const sdkEntry = execFileSync(
		process.execPath,
		["--input-type=module", "-e", "console.log(import.meta.resolve('@opencode-ai/plugin'))"],
		{ cwd: join(root, "packages/opencode-plugin/.opencode/plugins") },
	)
		.toString()
		.trim();
	const harnessPaths = [
		"scripts/eval/automatic-recall-transport.ts",
		"scripts/eval/automatic-recall-clock.mjs",
		"scripts/eval/prompt-path.ts",
		"scripts/eval/prompt-path-lib.ts",
		"scripts/eval/run-automatic-recall-baseline.mjs",
	];
	return {
		schema_version: 1,
		fixture_id: fixture.fixture_id,
		harness_sha256: Object.fromEntries(
			harnessPaths.map((path) => [path, sha(readFileSync(join(root, path)))]),
		),
		fixture_bytes_sha256: sha(readFileSync(join(root, fixturePath))),
		fixture_canonical_sha256: fixtureDigest(),
		baseline_commit: manifest.source.commit,
		candidate_head: git("rev-parse", "HEAD").toString().trim(),
		candidate_dirty: git("status", "--porcelain", "--untracked-files=normal").length > 0,
		runtime: {
			node: process.versions.node,
			pnpm,
			platform: process.platform,
			architecture: process.arch,
			plugin_sdk: JSON.parse(readFileSync(new URL("../package.json", sdkEntry), "utf8")).version,
		},
		embeddings: "CODEMEM_EMBEDDING_DISABLED=1; no provider calls; lexical/fallback paths only",
		clock:
			"JavaScript Date frozen to fixture clock in harness and children; SQLite clock unchanged",
		token_scope:
			"ceil(text.length / 4): automatic includes the actual injected wrapper; explicit uses bare CLI pack_text. Not provider token counts or a production reserved-budget guarantee. Fresh history only.",
		cli_network:
			"Only the case Viewer origin rejects fetch; real CLI children and healthy Viewer routes are unchanged",
	};
}

async function main() {
	const { snapshot, pnpm } = prepareHistoricalSource();
	const baselineSource = sourceEvidence(snapshot);
	assert.deepEqual(baselineSource.blobs, manifest.source.blobs);
	const candidateSource = sourceEvidence(root);
	const provenance = reportProvenance(pnpm);
	const baseline = await evaluate(snapshot, "baseline");
	const candidate = await evaluate(root, "candidate");
	assert.deepEqual(candidate.explicit_control, baseline.explicit_control);
	assert.deepEqual(candidate.generic_control, baseline.generic_control);
	assert.deepEqual(sourceEvidence(root), candidateSource, "candidate changed during evaluation");
	assert.deepEqual(reportProvenance(pnpm), provenance, "harness changed during evaluation");
	const report = {
		...provenance,
		baseline_source: baselineSource,
		candidate_source: candidateSource,
		baseline,
		candidate,
	};
	writeFileSync(
		join(scratch, "automatic-recall-transport-latest.json"),
		`${JSON.stringify(report, null, 2)}\n`,
	);
	writeFileSync(
		join(mkdtempSync(join(scratch, "recall-transport-report-")), "report.json"),
		`${JSON.stringify(report, null, 2)}\n`,
	);
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
