import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scriptUrl = new URL("../../../../plugins/claude/scripts/pre-read-hook.mjs", import.meta.url);
const promptUrl = new URL(
	"../../../../plugins/claude/scripts/user-prompt-hook.mjs",
	import.meta.url,
);
const hook = await import(scriptUrl.href);
const promptHook = await import(promptUrl.href);
type Body = Record<string, unknown>;
const capability = {
	file_context_transport: 1,
	visibility_enforced: true,
	deferred_delivery: true,
};
const contextOutput = {
	hookSpecificOutput: {
		hookEventName: "PreToolUse",
		permissionDecision: "allow",
		additionalContext: "Selected file context",
	},
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status });
}

function selected(body: Body, result: Body = contextOutput): Body {
	return {
		ok: true,
		attempt_id: body.attempt_id,
		request_id: body.request_id,
		delivery_pending: result.hookSpecificOutput !== undefined,
		result,
	};
}

let root: string;
let env: Record<string, string>;
let payload: Body;
let httpBodies: Body[];
let output: ReturnType<typeof vi.fn>;
let fetchImpl: ReturnType<typeof vi.fn>;
let runChild: ReturnType<typeof vi.fn>;
let statFile: ReturnType<typeof vi.fn>;
let uuid: ReturnType<typeof vi.fn>;

function profile(extra: Body = {}): Body {
	return {
		service: "codemem-viewer",
		protocol_version: 1,
		min_supported_protocol_version: 1,
		db_path: env.CODEMEM_DB,
		identity_target: promptHook.identityTarget(root, env),
		...extra,
	};
}

function run(extra: Body = {}, raw = JSON.stringify(payload)) {
	return hook.runClaudePreReadHook(raw, {
		env,
		fetchImpl,
		runChild,
		statFile,
		uuid,
		writeOutput: output,
		...extra,
	});
}

function installFallback() {
	runChild.mockImplementation(async (_command: string, args: string[], raw: string) => {
		if (args.includes("--transport-profile")) return JSON.stringify(capability);
		const body = JSON.parse(raw) as Body;
		if (body.action === "delivery") return JSON.stringify({ ok: true });
		return JSON.stringify(selected(body));
	});
}

function writeManifest(version: unknown) {
	mkdirSync(join(root, ".claude-plugin"), { recursive: true });
	writeFileSync(join(root, ".claude-plugin/plugin.json"), JSON.stringify({ version }));
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "codemem-pre-read-"));
	env = {
		HOME: root,
		CODEMEM_DB: join(root, "never-open.sqlite"),
		CODEMEM_CONFIG: join(root, "never-read.json"),
		CLAUDE_PLUGIN_ROOT: root,
	};
	payload = {
		cwd: root,
		session_id: " client-session ",
		tool_input: { file_path: "src/feature.ts" },
	};
	httpBodies = [];
	output = vi.fn(async () => {});
	statFile = vi.fn(() => ({ size: 1500, mtimeMs: 1234 }));
	let nextId = 0;
	uuid = vi.fn(() => `uuid-${++nextId}`);
	runChild = vi.fn(async () => null);
	fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
		if (init.method === "GET") return jsonResponse(profile());
		const body = JSON.parse(String(init.body)) as Body;
		httpBodies.push(body);
		if (body.action === "delivery") return jsonResponse({ ok: true });
		return jsonResponse(selected(body));
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

describe("packaged pre-read HTTP delivery", () => {
	it("emits HTTP context before acknowledging it, without starting a CLI or touching a database", async () => {
		// Arrange: delivery is deferred until the host accepts stdout.
		output.mockImplementation(async () => {
			expect(httpBodies).toHaveLength(1);
		});
		// Act
		await run();
		// Assert
		expect(output).toHaveBeenCalledExactlyOnceWith(JSON.stringify(contextOutput));
		expect(httpBodies).toEqual([
			expect.objectContaining({
				action: "lookup",
				relative_path: "src/feature.ts",
				file_mtime_ms: 1234,
				source_session_id: "client-session",
				attempt_id: "uuid-2",
				request_id: "claude-file-context/http/uuid-1",
				db_path: env.CODEMEM_DB,
			}),
			expect.objectContaining({
				action: "delivery",
				attempt_id: "uuid-2",
				delivery_status: "handed_off",
			}),
		]);
		expect(runChild).not.toHaveBeenCalled();
		expect(existsSync(String(env.CODEMEM_DB))).toBe(false);
		expect(existsSync(String(env.CODEMEM_CONFIG))).toBe(false);
		for (const [, init] of fetchImpl.mock.calls) expect(init.redirect).toBe("manual");
	});

	it("accepts valid empty HTTP results without CLI fallback or a delivery acknowledgment", async () => {
		// Arrange
		fetchImpl.mockImplementation(async (_url: string, init: RequestInit) => {
			if (init.method === "GET") return jsonResponse(profile());
			return jsonResponse(selected(JSON.parse(String(init.body)), { continue: true }));
		});
		// Act
		await run();
		// Assert
		expect(output).toHaveBeenCalledExactlyOnceWith('{"continue":true}');
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(runChild).not.toHaveBeenCalled();
	});

	it("uses the current client's project and session rather than fields supplied by the Viewer", async () => {
		// Arrange
		env.CODEMEM_PROJECT = "current-client";
		fetchImpl.mockResolvedValueOnce(
			jsonResponse(profile({ project: "viewer-project", source_session_id: "viewer-session" })),
		);
		// Act
		await run();
		// Assert
		expect(httpBodies[0]).toMatchObject({
			project: "current-client",
			source_session_id: "client-session",
			identity_target: promptHook.identityTarget(root, env),
		});
	});

	it("infers the project from the hook cwd without requiring client environment configuration", async () => {
		// Arrange
		payload.project = "stale-payload-project";
		payload.session_id = "   ";
		const expectedProject = promptHook.resolveProject(payload, env);
		// Act
		await run();
		// Assert
		expect(httpBodies[0]).toMatchObject({ project: expectedProject, source_session_id: null });
		expect(expectedProject).not.toBe("stale-payload-project");
	});
});

describe("packaged pre-read input guards", () => {
	it.each(["", "{", "null", "[]", "x".repeat(65_537)])(
		"continues without any dependency calls for invalid input %j",
		async (raw) => {
			// Arrange / Act
			await run({}, raw);
			// Assert
			expect(output).toHaveBeenCalledExactlyOnceWith('{"continue":true}');
			expect(fetchImpl).not.toHaveBeenCalled();
			expect(statFile).not.toHaveBeenCalled();
			expect(runChild).not.toHaveBeenCalled();
		},
	);

	it.each(["ignore", "missing", "blank"])("short-circuits %s before I/O", async (mode) => {
		// Arrange
		if (mode === "ignore") env.CODEMEM_PLUGIN_IGNORE = "true";
		if (mode === "missing") delete payload.tool_input;
		if (mode === "blank") payload.tool_input = { file_path: " " };
		// Act
		await run();
		// Assert
		expect(output).toHaveBeenCalledExactlyOnceWith('{"continue":true}');
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(statFile).not.toHaveBeenCalled();
		expect(runChild).not.toHaveBeenCalled();
	});
});

describe("packaged pre-read skip reporting", () => {
	it.each([
		["disabled", "file_context_disabled"],
		["outside", "outside_cwd"],
		["sibling", "outside_cwd"],
		["cwd", "outside_cwd"],
		["stat", "stat_failed"],
		["small", "below_size_gate"],
	])("records a %s skip over HTTP but never falls back to a database/CLI", async (mode, reason) => {
		// Arrange
		if (mode === "disabled") env.CODEMEM_FILE_CONTEXT = "0";
		if (mode === "outside") payload.tool_input = { file_path: "../outside.ts" };
		if (mode === "sibling") payload.tool_input = { file_path: `${root}-sibling/file.ts` };
		if (mode === "cwd") payload.tool_input = { file_path: root };
		if (mode === "stat")
			statFile.mockImplementation(() => {
				throw new Error("ENOENT");
			});
		if (mode === "small") statFile.mockReturnValue({ size: 1499, mtimeMs: 0 });
		fetchImpl.mockImplementation(async (_url: string, init: RequestInit) => {
			if (init.method === "GET") return jsonResponse(profile());
			httpBodies.push(JSON.parse(String(init.body)));
			return new Response("malformed");
		});
		// Act
		await run();
		// Assert
		expect(httpBodies).toEqual([expect.objectContaining({ action: "skip", reason })]);
		expect(output).toHaveBeenCalledExactlyOnceWith('{"continue":true}');
		expect(runChild).not.toHaveBeenCalled();
		expect(existsSync(String(env.CODEMEM_DB))).toBe(false);
	});

	it("does not contact HTTP for skips when the retrieval ledger is disabled", async () => {
		// Arrange
		env.CODEMEM_FILE_CONTEXT = "off";
		env.CODEMEM_RETRIEVAL_LEDGER = "0";
		// Act
		await run();
		// Assert
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(runChild).not.toHaveBeenCalled();
		expect(output).toHaveBeenCalledExactlyOnceWith('{"continue":true}');
	});
});

describe("packaged pre-read path and size checks", () => {
	it.each([
		"package.json",
		"settings.jsonc",
		"config.toml",
		"a.yml",
		"a.yaml",
		".env.local",
		"Dockerfile.dev",
		"vite.config.ts",
	])("bypasses the size gate for config file %s without local fallback", async (file) => {
		// Arrange
		payload.tool_input = { file_path: file };
		statFile.mockReturnValue({ size: 1, mtimeMs: 5 });
		// Act
		await run();
		// Assert
		expect(httpBodies[0]).toMatchObject({ action: "lookup", relative_path: file });
		expect(runChild).not.toHaveBeenCalled();
	});

	it("accepts a same-project path whose segment contains two dots", async () => {
		// Arrange
		payload.tool_input = { file_path: "src/..generated/feature.ts" };
		// Act
		await run();
		// Assert
		expect(httpBodies[0]).toMatchObject({
			action: "lookup",
			relative_path: "src/..generated/feature.ts",
		});
	});
});

describe("packaged pre-read terminal HTTP failures", () => {
	it.each(
		["profile", "lookup"].flatMap((stage) =>
			["viewer_db_mismatch", "viewer_identity_mismatch"].map((code) => ({ stage, code })),
		),
	)(
		"never falls back after a $stage denial or redirect with misleading $code",
		async ({ stage, code }) => {
			// Arrange: misleading mismatch errors must not override terminal status codes.
			const statuses = [301, 302, 307, 308, 401, 403];
			for (const status of statuses) {
				fetchImpl.mockClear();
				output.mockClear();
				fetchImpl.mockImplementation(async (_url: string, init: RequestInit) => {
					if (stage === "lookup" && init.method === "GET") return jsonResponse(profile());
					return jsonResponse({ error: { code } }, status);
				});
				// Act
				await run();
				// Assert
				expect(output).toHaveBeenCalledExactlyOnceWith('{"continue":true}');
				expect(runChild).not.toHaveBeenCalled();
				expect(fetchImpl).toHaveBeenCalledTimes(stage === "profile" ? 1 : 2);
				for (const [, init] of fetchImpl.mock.calls) expect(init.redirect).toBe("manual");
			}
		},
	);

	it.each([
		"policy_denied",
		"policy_disabled",
		"invalid_request",
		"viewer_contract_unsupported",
		"unauthorized",
		"forbidden",
	])("never falls back for a compatible HTTP 400 %s rejection", async (code) => {
		// Arrange
		fetchImpl
			.mockResolvedValueOnce(jsonResponse(profile()))
			.mockResolvedValueOnce(jsonResponse({ error: { code } }, 400));
		// Act
		await run();
		// Assert
		expect(output).toHaveBeenCalledExactlyOnceWith('{"continue":true}');
		expect(runChild).not.toHaveBeenCalled();
	});

	it("rejects non-loopback Viewer policy without HTTP or CLI calls", async () => {
		// Arrange
		env.CODEMEM_VIEWER_HOST = "viewer.example.test";
		// Act
		await run();
		// Assert
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(runChild).not.toHaveBeenCalled();
		expect(output).toHaveBeenCalledExactlyOnceWith('{"continue":true}');
	});
});

describe("packaged pre-read CLI capabilities and pins", () => {
	it.each(["visibility_enforced", "deferred_delivery", "file_context_transport"])(
		"requires %s capability before sending file context to the installed CLI",
		async (field) => {
			// Arrange
			fetchImpl.mockRejectedValue(new Error("offline"));
			runChild.mockResolvedValue(JSON.stringify({ ...capability, [field]: false }));
			// Act
			await run();
			// Assert
			expect(runChild).toHaveBeenCalledTimes(1);
			expect(runChild.mock.calls[0]?.slice(0, 3)).toEqual([
				"codemem",
				["claude-hook-file-context", "--transport-profile"],
				"",
			]);
			expect(output).toHaveBeenCalledExactlyOnceWith('{"continue":true}');
		},
	);

	it.each([
		"latest",
		"^1.2.3",
		"~1.2.3",
		"1.2",
		"01.2.3",
		"1.2.3-01",
		"1.2.3-beta.01",
		"1.2.3;echo unsafe",
		"",
		123,
		null,
	])("never bootstraps npx for a non-exact manifest version %j", async (version) => {
		// Arrange
		writeManifest(version);
		fetchImpl.mockRejectedValue(new Error("offline"));
		// Act
		await run();
		// Assert
		expect(runChild).toHaveBeenCalledTimes(1);
		expect(runChild.mock.calls[0]?.[0]).toBe("codemem");
		expect(output).toHaveBeenCalledExactlyOnceWith('{"continue":true}');
	});

	it.each(["1.2.3", "1.2.3-beta.0+build.7"])(
		"probes then uses only the exact npx pin %s",
		async (version) => {
			// Arrange
			writeManifest(version);
			installFallback();
			runChild.mockResolvedValueOnce(null);
			fetchImpl.mockRejectedValue(new Error("offline"));
			// Act
			await run();
			// Assert
			expect(runChild.mock.calls.map(([command, args]) => [command, args])).toEqual([
				["codemem", ["claude-hook-file-context", "--transport-profile"]],
				["npx", ["-y", `codemem@${version}`, "claude-hook-file-context", "--transport-profile"]],
				["npx", ["-y", `codemem@${version}`, "claude-hook-file-context", "--transport"]],
				["npx", ["-y", `codemem@${version}`, "claude-hook-file-context", "--transport"]],
			]);
			expect(output).toHaveBeenCalledExactlyOnceWith(JSON.stringify(contextOutput));
		},
	);
});
