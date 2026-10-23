import { execFile } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import {
	createCachedCliRunner,
	isCachedCliCurrent,
	probeCliCandidate,
} from "../.opencode/lib/cached-cli-runner.js";

const executeFile = promisify(execFile);
const roots = [];
const PIN = "1.2.3-beta.2";
const fixture = ({ version = PIN, output = version, body } = {}) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "codemem-runner-")));
	roots.push(root);
	const pkg = join(root, "node_modules", "codemem");
	const bin = join(root, "bin");
	mkdirSync(pkg, { recursive: true });
	mkdirSync(bin);
	const manifest = join(pkg, "package.json");
	writeFileSync(
		manifest,
		JSON.stringify({ name: "codemem", version, type: "module", bin: { codemem: "cli.js" } }),
	);
	const entry = join(pkg, "cli.js");
	writeFileSync(entry, body ?? `process.stdout.write(${JSON.stringify(output)});`);
	symlinkSync(entry, join(bin, "codemem"));
	symlinkSync(process.execPath, join(bin, "node"));
	const embeddings = join(root, "node_modules", "@codemem", "embeddings");
	mkdirSync(embeddings, { recursive: true });
	writeFileSync(
		join(embeddings, "package.json"),
		JSON.stringify({
			name: "@codemem/embeddings",
			version,
			exports: { ".": { import: "./index.js" } },
		}),
	);
	writeFileSync(join(embeddings, "index.js"), "export {};\n");
	return { root, pkg, bin, manifest, entry, embeddings };
};
const editManifest = (path, patch) =>
	writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...patch }));
const probe = (f, options = {}) =>
	probeCliCandidate({ path: f.bin, nodePath: process.execPath, bootstrap: true, ...options });
const runner = (options = {}) =>
	createCachedCliRunner({
		runner: "npx",
		runnerArgs: ["-y", `codemem@${PIN}`],
		pin: PIN,
		isCompatibleVersion: (version) => [PIN, "1.2.3-beta.3"].includes(version),
		...options,
	});
const harness = ({ installed = null, bootstrap = null } = {}) => {
	const execute = vi.fn(async (command, args, options) => {
		// Replace npm itself; execute only the shipped probe with isolated child PATH.
		const selected = command === "node" ? installed : bootstrap;
		if (!selected) throw new Error("fixture unavailable");
		const probeArgs = command === "node" ? args : args.slice(args.indexOf("node") + 1);
		return executeFile("node", probeArgs, { ...options, env: { PATH: selected.bin } });
	});
	return { execute, resolver: runner({ execute }) };
};

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.each([PIN, "1.2.3-beta.3"])(
	"reuses a verified installed CLI on the same channel (%s)",
	async (version) => {
		// Arrange: no embeddings requirement for an already-installed CLI.
		const f = fixture({ version });
		rmSync(f.embeddings, { recursive: true });
		const { execute, resolver } = harness({ installed: f });
		// Act
		const first = await resolver.command(["stats"]);
		const second = await resolver.command(["recent"]);
		// Assert: actual probe execution confirms package version and Node executable.
		expect(first).toEqual([realpathSync(process.execPath), f.entry, "stats"]);
		expect(second).toEqual([realpathSync(process.execPath), f.entry, "recent"]);
		expect(execute).toHaveBeenCalledTimes(1);
	},
);

test.each(["1.2.3-beta.1", "1.2.3-alpha.9", "1.2.3"])(
	"bootstraps the exact pin instead of incompatible installed %s",
	async (version) => {
		// Arrange
		const installed = fixture({ version });
		const pinned = fixture();
		const { execute, resolver } = harness({ installed, bootstrap: pinned });
		// Act
		const commands = await Promise.all([resolver.command(["stats"]), resolver.command(["recent"])]);
		// Assert: bootstrap discovery reads child PATH, regardless of package directory layout.
		expect(commands.map((command) => command[1])).toEqual([pinned.entry, pinned.entry]);
		expect(execute.mock.calls.map(([command]) => command)).toEqual(["node", "npx"]);
		expect(execute.mock.calls[1][1]).toEqual([
			"-y",
			"--package",
			`codemem@${PIN}`,
			"--package",
			`@codemem/embeddings@${PIN}`,
			"node",
			expect.stringContaining("cli-runner-probe.js"),
			PIN,
		]);
	},
);

test("bootstraps once for concurrent calls when no installed CLI exists", async () => {
	// Arrange
	const f = fixture();
	const { resolver, execute } = harness({ bootstrap: f });
	// Act
	const commands = await Promise.all(Array.from({ length: 8 }, () => resolver.command(["stats"])));
	// Assert
	expect(commands.every((command) => command[1] === f.entry)).toBe(true);
	expect(execute.mock.calls.map(([command]) => command)).toEqual(["node", "npx"]);
});

test.each([
	["name", { name: "other" }],
	["missing bin", { bin: {} }],
	["escaping bin", { bin: { codemem: "../../outside.js" } }],
	["non-string version", { version: 42 }],
	["exact pin mismatch", { version: "1.2.3-beta.3" }],
])("rejects invalid package metadata: %s", async (_label, patch) => {
	// Arrange
	const f = fixture();
	editManifest(f.manifest, patch);
	writeFileSync(join(f.root, "outside.js"), `process.stdout.write('${PIN}')`);
	// Act
	const result = await probe(f, { expectedVersion: PIN });
	// Assert
	expect(result).toBeNull();
});

test.each(["wrong", `${PIN}\nextra`, ""])(
	"rejects package/CLI version disagreement (%s)",
	async (output) => {
		// Arrange
		const f = fixture({ output });
		// Act
		const result = await probe(f);
		// Assert
		expect(result).toBeNull();
	},
);

test.each(["symlink escape", "bin mismatch"])(
	"rejects realpath containment and executable mismatch: %s",
	async (kind) => {
		// Arrange
		const f = fixture();
		const outside = join(f.root, "outside.js");
		writeFileSync(outside, `process.stdout.write('${PIN}')`);
		if (kind === "symlink escape") {
			rmSync(f.entry);
			symlinkSync(outside, f.entry);
		} else {
			rmSync(join(f.bin, "codemem"));
			symlinkSync(outside, join(f.bin, "codemem"));
		}
		// Act
		const result = await probe(f);
		// Assert
		expect(result).toBeNull();
	},
);

test.each(["missing", "wrong version", "wrong name", "escaping export", "missing export"])(
	"requires paired bootstrap embeddings: %s",
	async (kind) => {
		// Arrange
		const f = fixture();
		const manifest = join(f.embeddings, "package.json");
		if (kind === "missing") rmSync(f.embeddings, { recursive: true });
		if (kind === "wrong version") editManifest(manifest, { version: "0.0.0" });
		if (kind === "wrong name") editManifest(manifest, { name: "other" });
		if (kind === "escaping export")
			editManifest(manifest, { exports: { ".": { import: "../../codemem/cli.js" } } });
		if (kind === "missing export") editManifest(manifest, { exports: {} });
		// Act
		const result = await probe(f, { expectedVersion: PIN });
		// Assert
		expect(result).toBeNull();
	},
);

test.each(["entry", "manifest", "node", "embeddings", "removed", "replaced"])(
	"invalidates cached file stamps after %s changes",
	async (kind) => {
		// Arrange
		const f = fixture();
		// Retarget only a fixture symlink, never modify the host executable.
		const node = join(f.bin, "node");
		const candidate = await probe(f, {
			expectedVersion: PIN,
			nodePath: kind === "node" ? node : process.execPath,
		});
		expect(isCachedCliCurrent(candidate)).toBe(true);
		const files = {
			entry: f.entry,
			manifest: f.manifest,
			embeddings: join(f.embeddings, "index.js"),
		};
		// Act
		if (kind === "removed") rmSync(f.entry);
		else if (kind === "replaced") {
			renameSync(f.entry, `${f.entry}.old`);
			writeFileSync(f.entry, "replacement");
		} else if (kind === "node") {
			rmSync(node);
			symlinkSync(f.entry, node);
		} else writeFileSync(files[kind], "changed fixture content");
		// Assert
		expect(isCachedCliCurrent(candidate)).toBe(false);
	},
);

test("rediscovers after replacement and explicit update invalidation", async () => {
	// Arrange
	const f = fixture();
	const { execute, resolver } = harness({ installed: f });
	await resolver.command(["stats"]);
	// Act
	writeFileSync(f.entry, `process.stdout.write('${PIN}\\n');`);
	await resolver.command(["recent"]);
	resolver.invalidate();
	await resolver.command(["version"]);
	// Assert
	expect(execute).toHaveBeenCalledTimes(3);
});

test("does not reuse a removed CLI entrypoint", async () => {
	// Arrange
	const f = fixture();
	const { execute, resolver } = harness({ installed: f });
	await resolver.command(["stats"]);
	// Act
	rmSync(f.entry);
	const command = await resolver.command(["recent"]);
	// Assert
	expect(command).toBeNull();
	expect(execute.mock.calls.map(([command]) => command)).toEqual(["node", "node", "npx"]);
});

test("uses a fixed failure cooldown without extending it on repeated requests", async () => {
	// Arrange
	const f = fixture();
	const candidate = await probe(f);
	let now = 1_000;
	const execute = vi.fn().mockRejectedValue(new Error("offline"));
	const warn = vi.fn();
	const resolver = runner({ execute, now: () => now, warn });
	// Act
	expect(await resolver.command(["stats"])).toBeNull();
	now = 30_999;
	expect(await resolver.command(["recent"])).toBeNull();
	expect(execute).toHaveBeenCalledTimes(2);
	now = 31_000;
	execute.mockResolvedValue({ stdout: JSON.stringify(candidate) });
	const recovered = await resolver.command(["recent"]);
	// Assert
	expect(recovered).toEqual([candidate.command, f.entry, "recent"]);
	expect(execute).toHaveBeenCalledTimes(3);
	expect(warn).toHaveBeenCalledTimes(1);
});

test.each(["malformed", "timeout", "output overflow"])(
	"contains probe failures and enforces limits: %s",
	async (kind) => {
		// Arrange
		const execute = vi.fn(async () => {
			if (kind === "malformed") return { stdout: "not JSON" };
			throw Object.assign(new Error(kind), {
				code: kind === "timeout" ? "ETIMEDOUT" : "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
			});
		});
		const resolver = runner({ execute });
		// Act
		const result = await resolver.command(["stats"]);
		// Assert
		expect(result).toBeNull();
		expect(
			execute.mock.calls.map(([, , options]) => ({
				timeout: options.timeout,
				maxBuffer: options.maxBuffer,
				killSignal: options.killSignal,
			})),
		).toEqual([
			{ timeout: 5_000, maxBuffer: 16_384, killSignal: "SIGKILL" },
			{ timeout: 60_000, maxBuffer: 16_384, killSignal: "SIGKILL" },
		]);
	},
);

test("rejects excessive real CLI version output", async () => {
	// Arrange
	const f = fixture({ body: "process.stdout.write('x'.repeat(17000));" });
	// Act
	const result = await probe(f);
	// Assert
	expect(result).toBeNull();
});

test.each(["command", "args", "files", "stamp", "version"])(
	"rejects inconsistent child probe descriptors: %s",
	async (field) => {
		// Arrange
		const f = fixture();
		const valid = await probe(f);
		const replacements = {
			command: "node",
			args: [f.entry, "--unsafe"],
			files: Array(7).fill(f.entry),
			stamp: "forged",
			version: "0.0.0",
		};
		const execute = vi
			.fn()
			.mockResolvedValue({ stdout: JSON.stringify({ ...valid, [field]: replacements[field] }) });
		// Act
		const result = await runner({ execute }).command(["stats"]);
		// Assert
		expect(result).toBeNull();
	},
);

test.each(["23.9.0", "24.14.9", "bun"])(
	"child probe refuses unsupported runtime %s",
	async (version) => {
		// Arrange
		const f = fixture();
		const overrides = version === "bun" ? { bun: "1.0.0" } : { node: version };
		const script = `Object.defineProperty(process, 'versions', { value: { ...process.versions, ...${JSON.stringify(overrides)} } }); await import(${JSON.stringify(new URL("../.opencode/lib/cli-runner-probe.js", import.meta.url).href)});`;
		// Act
		const result = await executeFile(process.execPath, ["--input-type=module", "-e", script], {
			env: { PATH: f.bin },
		});
		// Assert
		expect(result.stdout).toBe("");
	},
);

test("uses the PATH Node executable, not the plugin host's execPath", async () => {
	// Arrange: simulate a Bun-hosted plugin without changing the child Node.
	const f = fixture();
	const nodePath = realpathSync(process.execPath);
	vi.stubGlobal("process", { ...process, execPath: join(f.root, "bun-host") });
	const { resolver, execute } = harness({ installed: f });
	// Act
	const command = await resolver.command(["stats"]);
	// Assert
	expect(execute.mock.calls[0][0]).toBe("node");
	expect(command[0]).toBe(nodePath);
});

test.each(["custom-runner", "npx", ""])(
	"explicit runner bypasses all discovery (%s)",
	async (command) => {
		// Arrange
		const execute = vi.fn();
		const resolver = runner({ explicit: true, runner: command, runnerArgs: ["source"], execute });
		// Act
		const result = resolver.command(["stats"]);
		// Assert
		expect(result).toEqual([command, "source", "stats"]);
		expect(execute).not.toHaveBeenCalled();
	},
);

test("invalidating during resolution discards the stale result and permits retry", async () => {
	// Arrange
	const f = fixture();
	const candidate = await probe(f);
	let release;
	const execute = vi.fn(
		() =>
			new Promise((resolve) => {
				release = resolve;
			}),
	);
	const resolver = runner({ execute });
	const pending = resolver.command(["stats"]);
	// Act
	resolver.invalidate();
	release({ stdout: JSON.stringify(candidate) });
	const result = await pending;
	execute.mockResolvedValue({ stdout: JSON.stringify(candidate) });
	const retry = await resolver.command(["recent"]);
	// Assert
	expect(result).toBeNull();
	expect(retry).toEqual([candidate.command, f.entry, "recent"]);
	expect(execute).toHaveBeenCalledTimes(2);
});

test.each([
	["success", "old first"],
	["failure", "old first"],
	["success", "new first"],
	["failure", "new first"],
])("invalidation isolates generations when stale resolution is %s (%s)", async (outcome, order) => {
	// Arrange: two real descriptors distinguish stale and fresh cache contents.
	const old = await probe(fixture());
	const currentFixture = fixture({ version: "1.2.3-beta.3" });
	const current = await probe(currentFixture);
	const releases = [];
	const execute = vi.fn((command) => {
		if (command === "npx") return Promise.reject(new Error("offline"));
		return new Promise((resolve) => releases.push(resolve));
	});
	const resolver = runner({ execute });
	const stale = resolver.command(["stats"]);
	// Act: start the new request before the old promise settles.
	resolver.invalidate();
	const fresh = resolver.command(["recent"]);
	expect(releases).toHaveLength(2);
	const settleOld = () =>
		releases[0]({ stdout: JSON.stringify(outcome === "success" ? old : null) });
	if (order === "old first") {
		settleOld();
		expect(await stale).toBeNull();
		const shared = resolver.command(["version"]);
		expect(releases).toHaveLength(2);
		releases[1]({ stdout: JSON.stringify(current) });
		expect(await shared).toEqual([current.command, currentFixture.entry, "version"]);
	} else {
		releases[1]({ stdout: JSON.stringify(current) });
		await fresh;
		settleOld();
		expect(await stale).toBeNull();
	}
	// Assert: stale completion cannot clear pending state or replace the new cache.
	expect(await fresh).toEqual([current.command, currentFixture.entry, "recent"]);
	expect(await resolver.command(["stats"])).toEqual([
		current.command,
		currentFixture.entry,
		"stats",
	]);
	expect(releases).toHaveLength(2);
	// Act: force another lookup immediately; a stale failure must not add cooldown.
	writeFileSync(currentFixture.entry, `process.stdout.write('1.2.3-beta.3'); // replaced`);
	const replacement = await probe(currentFixture);
	const retry = resolver.command(["stats"]);
	// Assert
	expect(releases).toHaveLength(3);
	releases[2]({ stdout: JSON.stringify(replacement) });
	expect(await retry).toEqual([replacement.command, currentFixture.entry, "stats"]);
});
