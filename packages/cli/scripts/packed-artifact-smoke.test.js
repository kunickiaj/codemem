import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { smokeAdapterWrapper, smokeCodexSpoolIsolation } from "./packed-artifact-smoke.mjs";

const httpControl = vi.hoisted(() => ({ withholdSuccess: false, withheld: 0, closed: 0 }));
vi.mock("node:http", async (importOriginal) => {
	const http = await importOriginal();
	return {
		...http,
		createServer(listener) {
			return http.createServer((request, response) => {
				const end = response.end;
				response.end = function (...args) {
					if (!httpControl.withholdSuccess || response.statusCode !== 200) {
						return end.apply(this, args);
					}
					httpControl.withheld += 1;
					response.once("close", () => {
						httpControl.closed += 1;
					});
					return this;
				};
				listener(request, response);
			});
		},
	};
});

const roots = [];
afterEach(() => {
	vi.unstubAllEnvs();
	httpControl.withholdSuccess = false;
	httpControl.withheld = 0;
	httpControl.closed = 0;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function isolatedAdapters() {
	const root = mkdtempSync(join(tmpdir(), "codemem-packed-isolation-test-"));
	roots.push(root);
	const isolatedRoot = join(root, "child");
	for (const adapter of ["claude", "codex"]) {
		const directory = join(isolatedRoot, "plugins", adapter, "scripts");
		mkdirSync(directory, { recursive: true });
		cpSync(
			resolve(
				import.meta.dirname,
				"../../..",
				"plugins",
				adapter,
				"scripts/codemem-normalizer.mjs",
			),
			join(directory, "codemem-normalizer.mjs"),
		);
	}
	return { root, isolatedRoot };
}

test.each([
	["claude", true],
	["codex", true],
	["codex", false],
])(
	"%s packed children ignore inherited home, profile, and queues (explicit spool: %s)",
	async (source, explicitSpool) => {
		// Arrange: all inherited paths are synthetic, including the default HOME queue.
		const { root, isolatedRoot } = isolatedAdapters();
		const normalizer = await import(
			pathToFileURL(join(isolatedRoot, "plugins/codex/scripts/codemem-normalizer.mjs")).href
		);
		const envelope = normalizer.buildRawEventEnvelopeFromCodexHook(
			{
				hook_event_name: "PostToolUse",
				session_id: "synthetic-outside-queue",
				timestamp: "2026-08-15T14:00:00Z",
				tool_name: "Read",
				tool_input: { filePath: "synthetic.txt" },
				tool_response: { content: "synthetic" },
			},
			normalizer.TRUSTED_HOOK_MAPPER_OPTIONS,
		);
		expect(envelope).not.toBeNull();
		const outsideHome = join(root, "outside-home");
		const outsideQueue = join(root, "outside-queue");
		const files = [];
		const bytes = JSON.stringify(envelope);
		for (const directory of [outsideQueue, join(outsideHome, ".codemem/codex-raw-event-spool")]) {
			mkdirSync(directory, { recursive: true });
			const file = join(directory, "raw-event-synthetic.json");
			writeFileSync(file, bytes);
			files.push(file);
		}
		for (const [key, value] of Object.entries({
			HOME: outsideHome,
			XDG_CONFIG_HOME: join(root, "outside-config"),
			CODEMEM_DB: join(root, "outside.sqlite"),
			CODEMEM_CONFIG: join(root, "outside.json"),
			CODEMEM_RUNTIME_ROOT: join(root, "outside-runtime"),
			CODEMEM_KEYS_DIR: join(root, "outside-keys"),
			CODEMEM_CODEX_RAW_EVENT_SPOOL_DIR: outsideQueue,
			CODEMEM_DEVICE_ID: "synthetic-parent-device",
			CODEMEM_ACTOR_ID: "synthetic-parent-actor",
		}))
			vi.stubEnv(key, value);
		if (!explicitSpool) vi.stubEnv("CODEMEM_CODEX_RAW_EVENT_SPOOL_DIR", undefined);

		// Act: run the real smoke child and loopback mock transport, not a mocked spawn.
		let failure;
		try {
			await smokeAdapterWrapper(source, isolatedRoot);
			if (source === "codex") {
				await smokeCodexSpoolIsolation(isolatedRoot);
			}
		} catch (error) {
			failure = error;
		}

		// Assert: success posts exactly the expected event; no inherited queue is drained.
		for (const file of files) {
			expect(existsSync(file), "outside queue must still exist").toBe(true);
			expect(readFileSync(file, "utf8")).toBe(bytes);
		}
		expect(failure).toBeUndefined();
		expect(existsSync(join(root, "outside.sqlite"))).toBe(false);
	},
);

test("spool contract does not depend on real HTTP acknowledgment scheduling", async () => {
	// Arrange: the mock server never acknowledges success, rather than sleeping near a deadline.
	const { isolatedRoot } = isolatedAdapters();
	await smokeAdapterWrapper("codex", isolatedRoot);
	httpControl.withholdSuccess = true;

	// Act: the spool fixture must control transport results, not race a 50 ms socket deadline.
	let failure;
	try {
		await smokeCodexSpoolIsolation(isolatedRoot);
	} catch (error) {
		failure = error;
	}

	// Assert: spool/drain checks work without any real HTTP success acknowledgment.
	expect({ withheld: httpControl.withheld, closed: httpControl.closed, failure }).toEqual({
		withheld: 0,
		closed: 0,
		failure: undefined,
	});
});
