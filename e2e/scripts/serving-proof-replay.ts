/**
 * Released extraction replay must not send a transitioned store's transcripts to
 * an observer. Each release first replays a persisted canary batch to a local
 * observer stub, which proves the stub receives replay traffic. After the
 * transition the same command must fail before any request, and the current
 * build must still replay the batch.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: { releases: { type: "string" }, version: { type: "string" } },
});
assert.ok(values.releases, "--releases must name the directory of compiled release tags");
const cases = ["0.49.1", "0.50.0-beta.2", "0.50.0-beta.3", "0.50.0-beta.4"];
const root = mkdtempSync(join(tmpdir(), "serving-proof-replay-"));
for (const name of Object.keys(process.env))
	if (name.startsWith("CODEMEM_") || name.startsWith("XDG_")) delete process.env[name];
Object.assign(process.env, { HOME: root, CODEMEM_EMBEDDING_DISABLED: "1" });
const { connect } = await import("../../packages/core/src/db.js");
const { prepareOfflineScopeServingStore } = await import(
	"../../packages/core/src/offline-serving-preparation.js"
);
const current = fileURLToPath(new URL("../../", import.meta.url));

/** A local OpenAI-compatible observer that records whether the canary reached it. */
async function observerStub(canary: string) {
	const seen = { requests: 0, canary: 0 };
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			seen.requests += 1;
			if (Buffer.concat(chunks).toString("utf8").includes(canary)) seen.canary += 1;
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					id: "stub",
					object: "chat.completion",
					model: "stub-model",
					choices: [{ index: 0, message: { role: "assistant", content: "{}" } }],
				}),
			);
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return { seen, url: `http://127.0.0.1:${address.port}/v1`, close: () => server.close() };
}

function seedBatch(path: string, canary: string): number {
	const db = connect(path);
	try {
		const now = new Date().toISOString();
		const session = Number(
			db
				.prepare("INSERT INTO sessions(started_at, cwd, project) VALUES (?, '/fixture', 'fixture')")
				.run(now).lastInsertRowid,
		);
		db.prepare(`INSERT INTO opencode_sessions(source, stream_id, opencode_session_id, session_id, created_at)
			VALUES ('opencode', 'stream-1', 'stream-1', ?, ?)`).run(session, now);
		const events = [
			{ type: "user_prompt", prompt_text: `Explain why ${canary} fails in the parser`, prompt_number: 1 },
			{ type: "assistant_message", assistant_text: `The ${canary} parser rejects nested quotes.` },
		];
		events.forEach((event, seq) => {
			db.prepare(`INSERT INTO raw_events(source, stream_id, opencode_session_id, event_seq, event_type,
				ts_wall_ms, payload_json, created_at) VALUES ('opencode', 'stream-1', 'stream-1', ?, ?, ?, ?, ?)`).run(
				seq,
				event.type,
				Date.now() + seq,
				JSON.stringify(event),
				now,
			);
		});
		return Number(
			db
				.prepare(`INSERT INTO raw_event_flush_batches(source, stream_id, opencode_session_id, start_event_seq,
				end_event_seq, extractor_version, status, created_at, updated_at)
				VALUES ('opencode', 'stream-1', 'stream-1', 0, 1, 'fixture', 'completed', ?, ?)`)
				.run(now, now).lastInsertRowid,
		);
	} finally {
		db.close();
	}
}

async function replay(build: string, home: string, path: string, batchId: number, observer: string) {
	const child = spawn(
		process.execPath,
		[
			join(build, "packages/cli/dist/index.js"),
			"diagnostics",
			"extraction",
			"replay",
			"--batch-id",
			String(batchId),
			"--scenario",
			"simple-batch-shape",
			"--db-path",
			path,
			"--json",
		],
		{
			env: {
				HOME: home,
				PATH: process.env.PATH,
				CODEMEM_CONFIG: join(home, "config.json"),
				CODEMEM_EMBEDDING_DISABLED: "1",
				CODEMEM_OBSERVER_PROVIDER: "openai",
				CODEMEM_OBSERVER_BASE_URL: observer,
				CODEMEM_OBSERVER_MODEL: "stub-model",
				OPENAI_API_KEY: "fixture-observer-key",
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let output = "";
	child.stdout.on("data", (chunk) => (output += chunk));
	child.stderr.on("data", (chunk) => (output += chunk));
	const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
	const [status] = (await once(child, "exit")) as [number | null];
	clearTimeout(timer);
	return { status, output };
}

async function verify(release: string, version: string): Promise<string> {
	const home = join(root, version);
	mkdirSync(home);
	const path = join(home, "device.sqlite");
	const canary = `replay-canary-${randomUUID()}`;
	const batchId = seedBatch(path, canary);
	const stub = await observerStub(canary);
	try {
		const control = await replay(release, home, path, batchId, stub.url);
		assert.ok(
			stub.seen.canary > 0,
			`${version} positive control: replay never reached the stub\n${control.output}`,
		);

		prepareOfflineScopeServingStore(
			path,
			{ coordinatorId: "fixture", groupId: "team", generation: randomUUID() },
			[],
		);
		const before = { ...stub.seen };
		const refused = await replay(release, home, path, batchId, stub.url);
		assert.notEqual(refused.status, 0, refused.output);
		assert.match(refused.output, /no such table: (?:main\.)?(?:raw_event_flush_batches|raw_events)/);
		assert.ok(!refused.output.includes(canary), "Released replay printed the canary");
		assert.deepEqual(stub.seen, before, `${version} sent a request after the transition`);

		await replay(current, home, path, batchId, stub.url);
		assert.ok(stub.seen.canary > before.canary, "Current replay no longer reads the batch");
		return refused.output.match(/no such table: [\w.]+/)?.[0] ?? "";
	} finally {
		stub.close();
	}
}

const failures: Error[] = [];
try {
	for (const version of cases.filter((v) => !values.version || v === values.version)) {
		try {
			const reason = await verify(resolve(values.releases, `v${version}`), version);
			process.stdout.write(
				`${version}: replay reached the stub before; after, it failed with "${reason}" and sent nothing; current build replayed\n`,
			);
		} catch (cause) {
			failures.push(new Error(version, { cause }));
		}
	}
	if (failures.length) throw new AggregateError(failures, "Replay canary failed");
} finally {
	rmSync(root, { recursive: true, force: true });
}
