import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerRootCommands } from "../command-tree.js";
import { retryNativeHookReceipt } from "./capture-native-retry.js";

const services = vi.hoisted(() => ({
	identity: {
		device_id: null,
		actor_id_present: false,
		actor_id: null,
		config_path: null,
		runtime_root: null,
		workspace_id: null,
		home_dir: null,
		pack_compression: null,
		embedding_disabled: true,
		embedding_offline: true,
		embedding_model: "fixture-model",
		embedding_revision: null,
	},
	store: vi.fn(() => {
		throw new Error("unexpected local database access");
	}),
}));
vi.mock("@codemem/core", async (importActual) => ({
	...(await importActual<typeof import("@codemem/core")>()),
	buildViewerIdentityTarget: () => services.identity,
	MemoryStore: services.store,
	connect: services.store,
	connectReadOnly: services.store,
}));

const providers = ["claude", "codex", "pi"] as const;
const receipt = "rejected-400-invalid_payload-hook-1730000000-123-1234.json.retained";
const savedExitCode = process.exitCode;
let home: string;
let dir: string;
let path: string;
let dbPath: string;
let profile: Record<string, unknown>;
let limit: number;
let response: () => Response;
let beforeProfile: () => Promise<void>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
const payload = {
	hook_event_name: "UserPromptSubmit",
	session_id: "private-session",
	prompt: "private-payload café 🦊",
	db_path: "old-target",
	identity_target: { device_id: "old-device" },
};
const serialized = ` \n${JSON.stringify(payload, null, 2)}\t\n`;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "codemem-native-http-"));
	dir = join(home, "spool");
	path = join(dir, receipt);
	dbPath = join(home, "selected.sqlite");
	await mkdir(dir, { mode: 0o755 });
	await writeFile(path, serialized, { mode: 0o644 });
	vi.stubEnv("HOME", home);
	vi.stubEnv("CODEMEM_DB", join(home, "wrong.sqlite"));
	vi.stubEnv("CODEMEM_VIEWER_HOST", "127.0.0.1");
	vi.stubEnv("CODEMEM_VIEWER_PORT", "38888");
	vi.stubEnv("CODEMEM_CLAUDE_HOOK_FLUSH", "1");
	vi.stubEnv("CODEMEM_CLAUDE_HOOK_FLUSH_ON_STOP", "0");
	for (const provider of providers)
		vi.stubEnv(`CODEMEM_${provider.toUpperCase()}_HOOK_SPOOL_DIR`, dir);
	profile = {
		service: "codemem-viewer",
		protocol_version: 1,
		min_supported_protocol_version: 1,
		db_path: dbPath,
		identity_target: services.identity,
	};
	limit = 1024 * 1024;
	beforeProfile = async () => {};
	response = () => Response.json({ accepted: 1, queued: 1 }, { status: 202 });
	fetchMock = vi.fn<typeof fetch>(async (input, init) => {
		const url = new URL(String(input));
		if (url.origin !== "http://127.0.0.1:38888") throw new Error("unexpected origin");
		if (url.pathname === "/api/prompt-pack-profile") {
			await beforeProfile();
			return Response.json(profile);
		}
		if (url.pathname === "/api/raw-events/status")
			return Response.json({ ingest: { available: true, max_body_bytes: limit } });
		if (
			providers.some((provider) => url.pathname === `/api/${provider}-hooks`) &&
			init?.method === "POST"
		)
			return response();
		throw new Error("unexpected request");
	});
	vi.stubGlobal("fetch", fetchMock);
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	services.store.mockClear();
	process.exitCode = undefined;
});

afterEach(async () => {
	expect(services.store).not.toHaveBeenCalled();
	process.exitCode = savedExitCode;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await rm(home, { recursive: true, force: true });
});

function posts() {
	return fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
}
function retry(provider: (typeof providers)[number] = "claude", keepReceipt = false) {
	return retryNativeHookReceipt(
		receipt,
		{ provider, dbPath, yes: true, keepReceipt },
		{ fetchImpl: fetchMock },
	);
}
function output() {
	return [...vi.mocked(process.stdout.write).mock.calls, ...vi.mocked(console.log).mock.calls]
		.map(([text]) => String(text))
		.join("");
}
async function run(extra: string[] = [], json = true) {
	const command = registerRootCommands(new Command("codemem"));
	function exits(parent: Command) {
		parent.exitOverride();
		for (const child of parent.commands) exits(child);
	}
	exits(command);
	try {
		await command.parseAsync(
			[
				"capture",
				"recover-rejected",
				receipt,
				"--format",
				"native-hook-v1",
				"--provider",
				"claude",
				"--db-path",
				dbPath,
				"-y",
				...(json ? ["--json"] : []),
				...extra,
			],
			{ from: "user" },
		);
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!("code" in error) ||
			!String(error.code).startsWith("commander.")
		)
			throw error;
		process.exitCode = 2;
	}
	return process.exitCode ?? 0;
}

it.each(providers)(
	"posts flat %s native data with current target metadata and no fallback",
	async (provider) => {
		// Arrange
		const expected = { ...payload, db_path: dbPath, identity_target: services.identity };
		// Act
		const result = await retry(provider);
		// Assert
		expect(result).toMatchObject({
			ok: true,
			recovery: { acknowledgement: "queued", cleanup: "removed", lock: "released" },
		});
		expect(posts()).toHaveLength(1);
		expect(String(posts()[0]?.[0])).toBe(`http://127.0.0.1:38888/api/${provider}-hooks`);
		expect(JSON.parse(String(posts()[0]?.[1]?.body))).toEqual(expected);
		for (const [, init] of fetchMock.mock.calls) {
			expect(init?.redirect).toBe("error");
			expect(init?.signal).toBeInstanceOf(AbortSignal);
		}
		await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
	},
);

it.each([
	[200, { inserted: 1, skipped: 0 }, true],
	[200, { inserted: 0, skipped: 1 }, false],
	[200, { inserted: 1, skipped: 1 }, false],
	[202, { accepted: 0, queued: 1 }, false],
	[202, { accepted: 1, queued: 0 }, false],
	[202, { accepted: "1", queued: 1 }, false],
	[202, { accepted: 1, queued: 1, error: "private error" }, false],
	[500, { inserted: 1, skipped: 0 }, false],
] as const)("requires an unambiguous native ACK (%i, %j)", async (status, body, accepted) => {
	// Arrange
	response = () => Response.json(body, { status });
	// Act
	const result = await retry();
	// Assert
	expect(result.ok).toBe(accepted);
	expect(posts()).toHaveLength(1);
	if (accepted) await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
	else {
		expect(result).toMatchObject({
			recovery: { delivery: "unacknowledged", reason: "delivery_rejected" },
		});
		expect(await readFile(path, "utf8")).toBe(serialized);
	}
});

it.each(["session_before_compact", "session_shutdown"])(
	"retains synchronous Pi boundary %s even when inserted is one",
	async (event) => {
		// Arrange
		const bytes = JSON.stringify({ piEvent: event, sessionId: "private-session" });
		await writeFile(path, bytes);
		response = () => Response.json({ inserted: 1, skipped: 0 });
		// Act
		const result = await retry("pi");
		// Assert
		expect(result.ok).toBe(false);
		expect(posts()).toHaveLength(1);
		expect(await readFile(path, "utf8")).toBe(bytes);
	},
);

it.each(["piEvent", "pi_event", "event", "type"])(
	"accepts queued Pi flush-only boundary via %s",
	async (key) => {
		// Arrange
		await writeFile(
			path,
			JSON.stringify({ [key]: " session_before_compact ", sessionId: "private-session" }),
		);
		// Act
		const result = await retry("pi");
		// Assert
		expect(result).toMatchObject({
			ok: true,
			recovery: { acknowledgement: "queued", cleanup: "removed" },
		});
		expect(posts()).toHaveLength(1);
	},
);

it.each([null, 0, "malformed", 17])(
	"blocks any saved Pi cutoff presence before network (%j)",
	async (cutoff) => {
		// Arrange
		const bytes = JSON.stringify({
			piEvent: "session_shutdown",
			_codememBoundaryThroughEventSeq: cutoff,
		});
		await writeFile(path, bytes);
		// Act
		const result = await retry("pi");
		// Assert
		expect(result).toMatchObject({ ok: false, error: "pi_boundary_snapshot_unsupported" });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await readFile(path, "utf8")).toBe(bytes);
	},
);

it("rechecks a Pi cutoff introduced after the initial read before POST", async () => {
	// Arrange
	const bytes = JSON.stringify({
		piEvent: "session_shutdown",
		_codememBoundaryThroughEventSeq: null,
	});
	beforeProfile = async () => {
		await writeFile(path, bytes);
	};
	// Act
	const result = await retry("pi");
	// Assert
	expect(result).toMatchObject({
		ok: false,
		error: "pi_boundary_snapshot_unsupported",
		recovery: { delivery: "unacknowledged", reason: "delivery_failed" },
	});
	expect(posts()).toHaveLength(0);
	expect(await readFile(path, "utf8")).toBe(bytes);
});

it("rechecks a body grown after preflight without POST or loss of retained bytes", async () => {
	// Arrange
	limit = 1024;
	const bytes = JSON.stringify({ ...payload, prompt: "private-payload".repeat(1024) });
	beforeProfile = async () => {
		await writeFile(path, bytes);
	};
	// Act
	const result = await retry();
	// Assert
	expect(result).toMatchObject({
		ok: false,
		error: "payload_too_large",
		recovery: {
			delivery: "unacknowledged",
			reason: "delivery_failed",
			cleanup: "not_attempted",
			lock: "released",
		},
	});
	expect(posts()).toHaveLength(0);
	expect(await readFile(path, "utf8")).toBe(bytes);
});

it.each(["SessionEnd", "PreCompact", "UserPromptSubmit"])(
	"uses existing Claude boundary header policy for %s without treating a skip as ACK",
	async (event) => {
		// Arrange
		const bytes = JSON.stringify({ hook_event_name: event, session_id: "private-session" });
		await writeFile(path, bytes);
		response = () => Response.json({ inserted: 0, skipped: 1 });
		// Act
		const result = await retry();
		// Assert
		expect(result.ok).toBe(false);
		expect(new Headers(posts()[0]?.[1]?.headers).get("X-Codemem-Boundary-Flush")).toBe(
			event === "SessionEnd" ? "1" : null,
		);
		expect(await readFile(path, "utf8")).toBe(bytes);
	},
);

it.each(["database", "identity", "service", "loopback"])(
	"denies %s preflight before POST",
	async (kind) => {
		// Arrange
		if (kind === "database") profile.db_path = "other.sqlite";
		if (kind === "identity") profile.identity_target = { ...services.identity, device_id: "other" };
		if (kind === "service") profile.service = "other";
		if (kind === "loopback") vi.stubEnv("CODEMEM_VIEWER_HOST", "example.com");
		// Act
		const result = await retry();
		// Assert
		expect(result.ok).toBe(false);
		expect(posts()).toHaveLength(0);
		expect(await readFile(path, "utf8")).toBe(serialized);
		expect(JSON.stringify(result)).not.toContain("private-payload");
	},
);

it.each(["exact", "unicode", "target-overhead"])(
	"checks the full targeted UTF-8 body size (%s)",
	async (kind) => {
		// Arrange
		const body = JSON.stringify({
			...payload,
			db_path: dbPath,
			identity_target: services.identity,
		});
		limit = Buffer.byteLength(body);
		if (kind === "unicode") limit = body.length;
		if (kind === "target-overhead") limit = Buffer.byteLength(JSON.stringify(payload));
		// Act
		const result = await retry();
		// Assert
		expect(result.ok).toBe(kind === "exact");
		expect(posts()).toHaveLength(kind === "exact" ? 1 : 0);
		if (kind !== "exact") expect(await readFile(path, "utf8")).toBe(serialized);
	},
);

it.each(["timeout", "malformed", "redirect"])(
	"keeps bytes after %s without fallback or private errors",
	async (kind) => {
		// Arrange
		response = () => {
			if (kind === "timeout") throw new DOMException("private-payload", "TimeoutError");
			if (kind === "malformed") return new Response("private-payload", { status: 202 });
			return Object.defineProperty(
				Response.json({ accepted: 1, queued: 1 }, { status: 202 }),
				"redirected",
				{ value: true },
			);
		};
		// Act
		const result = await retry();
		// Assert
		expect(result).toMatchObject({
			ok: false,
			recovery: {
				delivery: "unacknowledged",
				reason: "delivery_failed",
				cleanup: "not_attempted",
				lock: "released",
			},
		});
		expect(posts()).toHaveLength(1);
		expect(JSON.stringify(result)).not.toContain("private-payload");
		expect(await readFile(path, "utf8")).toBe(serialized);
	},
);

it.each([true, false])("CLI keeps acknowledged bytes with safe output (json=%s)", async (json) => {
	// Arrange
	const before = await stat(path);
	// Act
	const code = await run(["--keep-receipt"], json);
	// Assert
	expect(code).toBe(0);
	if (json)
		expect(JSON.parse(output())).toMatchObject({
			ok: true,
			recovery: { cleanup: "kept", lock: "released" },
		});
	else expect(output()).toMatch(/retain.*request|kept.*request/i);
	expect(output()).not.toContain(home);
	expect(output()).not.toMatch(/private-session|private-payload/);
	expect(await stat(path)).toMatchObject({ ino: before.ino, mode: before.mode });
	expect(await readFile(path, "utf8")).toBe(serialized);
});

it.each([
	["--provider", "other"],
	["--format", "other"],
	["--format", "opencode-raw-event-v1", "--provider", "pi"],
])("CLI rejects incompatible options %j before HTTP", async (...extra) => {
	// Arrange
	const args = extra.flat();
	// Act
	const code = await run(args);
	// Assert
	expect(code).toBe(2);
	expect(JSON.parse(output())).toMatchObject({ ok: false, exitCode: 2 });
	expect(fetchMock).not.toHaveBeenCalled();
	expect(await readFile(path, "utf8")).toBe(serialized);
});

it.each(["confirmation", "database"])("requires explicit %s before HTTP", async (missing) => {
	// Arrange
	const options = {
		provider: "claude" as const,
		dbPath: missing === "database" ? undefined : dbPath,
		yes: missing !== "confirmation",
	};
	// Act
	const result = await retryNativeHookReceipt(receipt, options, { fetchImpl: fetchMock });
	// Assert
	expect(result).toMatchObject({ ok: false, error: "usage_error", exitCode: 2 });
	expect(fetchMock).not.toHaveBeenCalled();
	expect(await readFile(path, "utf8")).toBe(serialized);
});

it("expands the explicitly selected tilde database instead of using the environment", async () => {
	// Arrange
	profile.db_path = join(home, "selected.sqlite");
	// Act
	const result = await retryNativeHookReceipt(
		receipt,
		{ provider: "claude", dbPath: "~/selected.sqlite", yes: true },
		{ fetchImpl: fetchMock },
	);
	// Assert
	expect(result.ok).toBe(true);
	expect(JSON.parse(String(posts()[0]?.[1]?.body)).db_path).toBe(profile.db_path);
});
