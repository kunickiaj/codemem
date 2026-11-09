import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ingestClaudeHookPayload } from "./claude-hook-ingest.js";
import { ingestCodexHookPayload } from "./codex-hook-ingest.js";
import { ingestPiHookPayload } from "./pi-hook-ingest.js";

vi.mock("./claude-hook-plugin-log.js", () => ({ logHookEvent: vi.fn() }));
vi.mock("node:fs", async (importActual) => {
	const actual = await importActual<typeof import("node:fs")>();
	return {
		...actual,
		linkSync: vi.fn(actual.linkSync),
		unlinkSync: vi.fn(actual.unlinkSync),
		writeFileSync: vi.fn(actual.writeFileSync),
	};
});

const providers = [
	{ provider: "claude", ingest: ingestClaudeHookPayload },
	{ provider: "codex", ingest: ingestCodexHookPayload },
	{ provider: "pi", ingest: ingestPiHookPayload },
] as const;
const head = "hook-1730000000-123-1234.json";
const terminalCases = providers.flatMap((entry) => [
	{ ...entry, status: 400, body: { error: "invalid session id" }, reason: "invalid_payload" },
	{
		...entry,
		status: 413,
		body: { error: "payload too large", max_bytes: 1 },
		reason: "payload_too_large",
	},
]);
let home: string;
let dir: string;
let actualFs: typeof fs;

beforeEach(async () => {
	actualFs = await vi.importActual<typeof fs>("node:fs");
	vi.mocked(fs.linkSync).mockImplementation(actualFs.linkSync);
	vi.mocked(fs.unlinkSync).mockImplementation(actualFs.unlinkSync);
	vi.mocked(fs.writeFileSync).mockImplementation(actualFs.writeFileSync);
	home = fs.mkdtempSync(join(tmpdir(), "codemem-native-activation-"));
	dir = join(home, "spool");
	fs.mkdirSync(dir, { mode: 0o755 });
	vi.stubEnv("HOME", home);
	vi.stubEnv("CODEMEM_CONFIG", join(home, "config.json"));
	for (const { provider } of providers) {
		vi.stubEnv(`CODEMEM_${provider.toUpperCase()}_HOOK_SPOOL_DIR`, dir);
		vi.stubEnv(`CODEMEM_${provider.toUpperCase()}_HOOK_LOCK_DIR`, join(home, `${provider}-lock`));
	}
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("unexpected network");
		}),
	);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	fs.rmSync(home, { recursive: true, force: true });
});

function payload(provider: string, tag: string) {
	return provider === "pi"
		? { piEvent: "session_start", sessionId: `fixture-${tag}`, ts: "2026-09-17T12:00:00.000Z", tag }
		: {
				hook_event_name: "UserPromptSubmit",
				session_id: `fixture-${tag}`,
				prompt: "café",
				timestamp: "2026-09-17T12:00:00.000Z",
				tag,
			};
}
function seed(provider: string) {
	const bytes = ` \n${JSON.stringify(payload(provider, "head"))}\n`;
	fs.writeFileSync(join(dir, head), bytes, { mode: 0o644 });
	return bytes;
}

it("Codex rejects terminal delivery when the first spool write fails without a backlog", async () => {
	// Arrange: fail only the durability write after a real HTTP rejection has been parsed.
	const fetchImpl = vi.fn(async () =>
		Response.json({ error: "invalid session id" }, { status: 400 }),
	);
	vi.stubGlobal("fetch", fetchImpl);
	vi.mocked(fs.writeFileSync).mockImplementation(() => {
		throw new Error("spool write unavailable");
	});
	// Act.
	const result = ingestCodexHookPayload(payload("codex", "current"), options(), deps());
	// Assert: failed durable capture cannot produce HTTP acceptance or a successful spool result.
	await expect(result).rejects.toThrow("codex-hook-ingest: HTTP and spool failed");
	expect(fetchImpl).toHaveBeenCalledTimes(1);
	expect(fs.readdirSync(dir)).toEqual([]);
	expect(fs.existsSync(join(home, "fixture.sqlite"))).toBe(false);
});
function options() {
	return { host: "127.0.0.1", port: 38888 };
}
function deps() {
	return { resolveDb: () => join(home, "fixture.sqlite") };
}
function requests(response: () => Response) {
	const seen: unknown[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (_input, init) => {
			if (typeof init?.body !== "string") throw new Error("expected serialized hook request");
			const body = JSON.parse(init.body);
			seen.push(body.tag);
			return body.tag === "head"
				? response()
				: Response.json({ accepted: 1, queued: 1 }, { status: 202 });
		}),
	);
	return seen;
}

it.each(terminalCases)(
	"$provider retains exact terminal-head bytes for HTTP $status before healthy progress",
	async ({ provider, ingest, status, body, reason }) => {
		// Arrange: legacy supported permissions must not be repaired or changed by retention.
		const bytes = seed(provider);
		const mode = fs.statSync(join(dir, head)).mode;
		const seen = requests(() => Response.json(body, { status }));
		// Act.
		const result = await ingest(payload(provider, "healthy"), options(), deps());
		// Assert.
		expect(seen).toEqual(["head", "healthy"]);
		expect(result).toMatchObject({ via: "http", inserted: 0, skipped: 0 });
		const retained = `rejected-${status}-${reason}-${head}.retained`;
		expect(fs.readdirSync(dir)).toEqual([retained]);
		expect(fs.readFileSync(join(dir, retained), "utf8")).toBe(bytes);
		expect(fs.statSync(join(dir, retained)).mode).toBe(mode);
		expect(fs.statSync(dir).mode & 0o777).toBe(0o755);
	},
);

it.each(terminalCases)(
	"$provider reports a current HTTP $status rejection as spool, never delivery",
	async ({ provider, ingest, status, body, reason }) => {
		// Arrange.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(body, { status })),
		);
		const live = payload(provider, "current");
		// Act.
		const result = await ingest(live, options(), deps());
		// Assert: absence of the active filename is not evidence of HTTP acceptance.
		expect(result).toEqual({ inserted: 0, skipped: 0, via: "spool" });
		const files = fs.readdirSync(dir);
		expect(files).toHaveLength(1);
		const receipt = files[0];
		if (!receipt) throw new Error("expected retained current receipt");
		expect(receipt.startsWith(`rejected-${status}-${reason}-`)).toBe(true);
		expect(receipt.endsWith(".retained")).toBe(true);
		expect(JSON.parse(fs.readFileSync(join(dir, receipt), "utf8"))).toEqual(live);
	},
);

const retryable = [
	{ label: "unknown", status: 400, body: { error: "invalid json" } },
	{ label: "auth", status: 401, body: { error: "invalid session id" } },
	{
		label: "target",
		status: 400,
		body: { error: { code: "invalid_request", message: "invalid session id" } },
	},
	{ label: "server", status: 500, body: { error: "invalid session id" } },
	{ label: "redirected", status: 400, body: { error: "invalid session id" }, redirected: true },
];
for (const providerCase of providers)
	it.each(retryable)(
		`${providerCase.provider} blocks the queue for $label failure`,
		async ({ status, body, ...flags }) => {
			// Arrange.
			const bytes = seed(providerCase.provider);
			const seen = requests(() => {
				const response = Response.json(body, { status });
				if ("redirected" in flags) Object.defineProperty(response, "redirected", { value: true });
				return response;
			});
			// Act.
			const result = await providerCase.ingest(
				payload(providerCase.provider, "healthy"),
				options(),
				deps(),
			);
			// Assert.
			expect(result.via).toBe("spool");
			expect(seen).toEqual(["head"]);
			expect(fs.readFileSync(join(dir, head), "utf8")).toBe(bytes);
			expect(fs.readdirSync(dir).filter((name) => name.endsWith(".retained"))).toEqual([]);
			expect(fs.readdirSync(dir).filter((name) => name.endsWith(".json"))).toHaveLength(2);
		},
	);

for (const providerCase of providers)
	it.each(["permissions", "publication", "release"] as const)(
		`${providerCase.provider} stops after retention %s failure`,
		async (failure) => {
			// Arrange: inject only filesystem failure points. Provider ingest, locking and retention stay real.
			const bytes = seed(providerCase.provider);
			if (failure === "permissions") fs.chmodSync(join(dir, head), 0o666);
			if (failure === "publication")
				vi.mocked(fs.linkSync).mockImplementation(() => {
					throw new Error("publication unavailable");
				});
			if (failure === "release")
				vi.mocked(fs.unlinkSync).mockImplementation((path) => {
					if (String(path).includes(".native-retain-") && String(path).endsWith(".lock"))
						throw new Error("release uncertain");
					actualFs.unlinkSync(path);
				});
			const seen = requests(() => Response.json({ error: "invalid session id" }, { status: 400 }));
			// Act.
			const result = await providerCase.ingest(
				payload(providerCase.provider, "healthy"),
				options(),
				deps(),
			);
			// Assert: completed publication can move the head before release fails, but cannot authorize queue progress.
			expect(result.via).toBe("spool");
			expect(seen).toEqual(["head"]);
			const location =
				failure === "release" ? `rejected-400-invalid_payload-${head}.retained` : head;
			expect(fs.readFileSync(join(dir, location), "utf8")).toBe(bytes);
			expect(fs.readdirSync(dir).filter((name) => name.includes("zz-hook-live"))).toHaveLength(1);
			if (failure === "permissions") expect(fs.statSync(join(dir, head)).mode & 0o777).toBe(0o666);
		},
	);
