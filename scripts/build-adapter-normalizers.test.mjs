import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildAdapterNormalizers } from "./build-adapter-normalizers.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const fixturePath = resolve(
	repoRoot,
	"packages/core/src/fixtures/adapter-normalizer-golden.json",
);
const targets = {
	claude: "plugins/claude/scripts/codemem-normalizer.mjs",
	codex: "plugins/codex/scripts/codemem-normalizer.mjs",
};

async function withGeneratedArtifacts(run) {
	const directory = await mkdtemp(join(tmpdir(), "codemem-normalizers-"));
	try {
		await buildAdapterNormalizers(directory);
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("generated normalizers have deterministic checked-in bytes", async () => {
	await withGeneratedArtifacts(async (directory) => {
		for (const relativePath of Object.values(targets)) {
			const [generated, checkedIn] = await Promise.all([
				readFile(resolve(directory, relativePath)),
				readFile(resolve(repoRoot, relativePath)),
			]);
			assert.deepEqual(
				generated,
				checkedIn,
				`${relativePath} is stale; run pnpm run build:adapter-normalizers`,
			);
		}
	});
});

test("generated normalizers import without workspace dependencies", async () => {
	await withGeneratedArtifacts(async (directory) => {
		for (const relativePath of Object.values(targets)) {
			const path = resolve(directory, relativePath);
			const source = await readFile(path, "utf8");
			const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
			assert.ok(imports.every((specifier) => specifier.startsWith("node:")));
			await import(`${pathToFileURL(path).href}?test=${Date.now()}`);
		}
	});
});

test("generated normalizers match the frozen core fixtures", async () => {
	await withGeneratedArtifacts(async (directory) => {
		const fixtures = JSON.parse(await readFile(fixturePath, "utf8"));
		const modules = {
			claude: await import(pathToFileURL(resolve(directory, targets.claude)).href),
			codex: await import(pathToFileURL(resolve(directory, targets.codex)).href),
		};
		const transcriptDirectory = await mkdtemp(join(tmpdir(), "codemem-normalizer-fixtures-"));
		const previousProject = process.env.CODEMEM_PROJECT;
		process.env.CODEMEM_PROJECT = "golden-project";
		try {
			for (const source of ["claude", "codex"]) {
				for (const [index, fixture] of fixtures[source].entries()) {
					const originalDate = globalThis.Date;
					if (fixture.now) {
						const fixedTime = originalDate.parse(fixture.now);
						globalThis.Date = class extends originalDate {
							constructor(...args) {
								super(...(args.length > 0 ? args : [fixedTime]));
							}

							static now() {
								return fixedTime;
							}
						};
					}
					let transcriptPath = null;
					try {
						if (fixture.transcript) {
							transcriptPath = join(transcriptDirectory, `${source}-${index}.jsonl`);
							await writeFile(transcriptPath, fixture.transcript);
						}
						const payload = Object.fromEntries(
							Object.entries(fixture.input).map(([key, value]) => [
								key,
								value === "$TRANSCRIPT" ? transcriptPath : value,
							]),
						);
						const buildEnvelope =
							source === "claude"
								? modules.claude.buildRawEventEnvelopeFromHook
								: modules.codex.buildRawEventEnvelopeFromCodexHook;
						const options = modules[source].TRUSTED_HOOK_MAPPER_OPTIONS;
						const first = buildEnvelope(payload, options);
						const retry = buildEnvelope(payload, options);
						assert.ok(first, fixture.name);
						assert.equal(retry.event_id, first.event_id, `${fixture.name} changed event ID`);
						const adapter = first.payload._adapter;
						assert.equal(adapter.source, fixture.expected.source);
						assert.equal(adapter.event_type, fixture.expected.event_type);
						assert.equal(adapter.meta.event_id_algo, fixture.expected.event_id_algo);
						if (fixture.expected.payload) assert.deepEqual(adapter.payload, fixture.expected.payload);
						if (fixture.expected.status) assert.equal(adapter.payload.status, fixture.expected.status);
						if (fixture.expected.text) assert.equal(adapter.payload.text, fixture.expected.text);
						if (fixture.expected.unknown_field) {
							assert.ok(fixture.expected.unknown_field in adapter.meta.hook_fields);
						}
					} finally {
						globalThis.Date = originalDate;
					}
				}
			}
		} finally {
			if (previousProject === undefined) delete process.env.CODEMEM_PROJECT;
			else process.env.CODEMEM_PROJECT = previousProject;
			await rm(transcriptDirectory, { recursive: true, force: true });
		}
	});
});

test("OpenCode random event IDs remain outside derived algorithm versioning", async () => {
	const source = await readFile(
		resolve(repoRoot, "packages/opencode-plugin/.opencode/plugins/codemem.js"),
		"utf8",
	);
	assert.match(source, /const nextEventId = \(\) => \{/);
	assert.match(source, /crypto\.randomUUID\(\)/);
	assert.doesNotMatch(source, /event_id_algo/);
});
