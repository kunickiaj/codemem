import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildAdapterNormalizers } from "../../../scripts/build-adapter-normalizers.mjs";

const packageRoot = process.cwd();
const workspaceRoot = resolve(packageRoot, "..", "..");
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
const packageVersion = String(packageJson.version);
const tempDir = mkdtempSync(join(tmpdir(), "codemem-packed-artifact-"));

function fail(message, result) {
	if (result) {
		if (result.stdout) process.stderr.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
	}
	throw new Error(message);
}

function run(command, args, cwd = packageRoot) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		env: process.env,
	});
	if (result.status !== 0) {
		fail(`Command failed: ${command} ${args.join(" ")}`, result);
	}
	return result;
}

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

function runAsync(command, args, options, input) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, options);
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});
		child.stdin?.end(input);
		child.once("error", reject);
		child.once("close", (status) => resolvePromise({ status, stdout, stderr }));
	});
}

async function smokeAdapterWrapper(source, isolatedRoot) {
	const relativeRoot = join("plugins", source);
	const scriptsDirectory = join(isolatedRoot, relativeRoot, "scripts");
	const wrapperPath = join(scriptsDirectory, "ingest-hook.mjs");
	cpSync(resolve(workspaceRoot, relativeRoot, "scripts", "ingest-hook.mjs"), wrapperPath);
	if (source === "claude") {
		cpSync(
			resolve(workspaceRoot, relativeRoot, "scripts", "user-prompt-hook.mjs"),
			join(scriptsDirectory, "user-prompt-hook.mjs"),
		);
	}
	cpSync(
		resolve(workspaceRoot, relativeRoot, source === "claude" ? ".claude-plugin" : ".codex-plugin"),
		join(isolatedRoot, relativeRoot, source === "claude" ? ".claude-plugin" : ".codex-plugin"),
		{ recursive: true },
	);

	const normalizerPath = join(scriptsDirectory, "codemem-normalizer.mjs");
	const normalizer = await import(pathToFileURL(normalizerPath).href);
	const nativePayload =
		source === "claude"
			? {
					hook_event_name: "PostToolUseFailure",
					session_id: "packed-claude",
					timestamp: "2026-08-15T14:00:00Z",
					tool_name: "Bash",
					tool_input: { command: "exit 1" },
					error: "failed",
				}
			: {
					hook_event_name: "PostToolUse",
					session_id: "packed-codex",
					timestamp: "2026-08-15T14:00:00Z",
					tool_name: "Read",
					tool_input: { filePath: "README.md" },
					tool_response: { content: "ok" },
				};
	const buildEnvelope =
		source === "claude"
			? normalizer.buildRawEventEnvelopeFromHook
			: normalizer.buildRawEventEnvelopeFromCodexHook;
	const expected = buildEnvelope(nativePayload, normalizer.TRUSTED_HOOK_MAPPER_OPTIONS);
	assert(expected, `${source} generated normalizer skipped packed smoke payload`);

	let receivedBody = "";
	const server = createServer((request, response) => {
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			receivedBody += chunk;
		});
		request.on("end", () => {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end('{"inserted":1,"skipped":0,"received":1}');
		});
	});
	await new Promise((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolvePromise);
	});
	try {
		const address = server.address();
		assert(address && typeof address === "object", "adapter smoke server did not bind");
		const result = await runAsync(
			process.execPath,
			[wrapperPath],
			{
				cwd: isolatedRoot,
				env: {
					...process.env,
					PATH: join(isolatedRoot, "no-cli-on-path"),
					CODEMEM_VIEWER_HOST: "127.0.0.1",
					CODEMEM_VIEWER_PORT: String(address.port),
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
			JSON.stringify(nativePayload),
		);
		const child = result;
		assert(
			child.status === 0,
			`${source} wrapper failed without workspace dependencies: ${child.stderr}`,
		);
		const received = JSON.parse(receivedBody);
		assert(received.event_id === expected.event_id, `${source} transport changed event_id`);
		assert(
			received.payload._adapter.meta.event_id_algo === `${source}/1`,
			`${source} algorithm discriminator missing`,
		);
	} finally {
		server.close();
	}
}

async function smokeClaudePromptWrapper(isolatedRoot) {
	const pluginRoot = join(isolatedRoot, "plugins", "claude");
	const wrapperPath = join(pluginRoot, "scripts", "user-prompt-hook.mjs");
	const home = join(isolatedRoot, "claude-home");
	const dbPath = join(home, ".codemem", "mem.sqlite");
	mkdirSync(home, { recursive: true });
	const identityTarget = {
		device_id: null,
		actor_id_present: false,
		actor_id: null,
		config_path: null,
		runtime_root: null,
		workspace_id: null,
		home_dir: home,
		pack_compression: null,
		embedding_disabled: false,
		embedding_model: "Xenova/bge-small-en-v1.5",
	};
	const requestPaths = [];
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			requestPaths.push(request.url);
			response.setHeader("Content-Type", "application/json");
			if (request.url === "/api/prompt-pack-profile") {
				response.end(
					JSON.stringify({
						service: "codemem-viewer",
						protocol_version: 1,
						min_supported_protocol_version: 1,
						db_path: dbPath,
						identity_target: identityTarget,
					}),
				);
				return;
			}
			if (request.url === "/api/pack") {
				const payload = JSON.parse(body);
				assert(
					payload.attempt?.source === "claude",
					"Claude prompt request omitted attempt metadata",
				);
				response.end('{"pack_text":"PACKED_CLAUDE_CONTEXT","metrics":{"total_items":1}}');
				return;
			}
			if (request.url === "/api/prompt-pack-ledger") {
				const payload = JSON.parse(body);
				assert(
					payload.delivery_status === "handed_off",
					"Claude prompt delivery was not recorded",
				);
				response.end('{"ok":true}');
				return;
			}
			response.end('{"inserted":1,"skipped":0,"received":1}');
		});
	});
	await new Promise((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolvePromise);
	});
	try {
		const address = server.address();
		assert(
			address && typeof address === "object",
			"Claude prompt smoke server did not bind",
		);
		const result = await runAsync(
			process.execPath,
			[wrapperPath],
			{
				cwd: isolatedRoot,
				env: {
					...process.env,
					PATH: join(isolatedRoot, "no-cli-on-path"),
					HOME: home,
					CLAUDE_PLUGIN_ROOT: pluginRoot,
					CODEMEM_DB: dbPath,
					CODEMEM_PROJECT: "codemem",
					CODEMEM_VIEWER_HOST: "127.0.0.1",
					CODEMEM_VIEWER_PORT: String(address.port),
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
			JSON.stringify({
				hook_event_name: "UserPromptSubmit",
				session_id: "packed-claude-prompt",
				prompt: "recall the packed hook contract",
				cwd: isolatedRoot,
			}),
		);
		assert(result.status === 0, `Claude prompt wrapper failed: ${result.stderr}`);
		assert(
			result.stdout ===
				'{"continue":true,"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"PACKED_CLAUDE_CONTEXT"}}',
			`Claude packed prompt output bytes changed: ${JSON.stringify(result.stdout)}`,
		);
		assert(
			requestPaths.includes("/api/pack"),
			"Claude packed prompt wrapper skipped direct pack HTTP",
		);
		assert(
			requestPaths.includes("/api/prompt-pack-ledger"),
			"Claude packed prompt wrapper skipped direct ledger HTTP",
		);
	} finally {
		await new Promise((resolvePromise) => server.close(resolvePromise));
	}
}

async function smokeCodexSpoolIsolation(isolatedRoot) {
	const scriptsDirectory = join(isolatedRoot, "plugins", "codex", "scripts");
	const wrapperPath = join(scriptsDirectory, "ingest-hook.mjs");
	const normalizer = await import(pathToFileURL(join(scriptsDirectory, "codemem-normalizer.mjs")).href);
	const nativePayload = {
		hook_event_name: "PostToolUse",
		session_id: "packed-codex-spool",
		timestamp: "2026-08-15T14:00:01Z",
		tool_name: "Read",
		tool_input: { filePath: "README.md" },
		tool_response: { content: "spooled" },
	};
	const expected = normalizer.buildRawEventEnvelopeFromCodexHook(
		nativePayload,
		normalizer.TRUSTED_HOOK_MAPPER_OPTIONS,
	);
	assert(expected, "codex generated normalizer skipped spool smoke payload");
	const expectedBody = JSON.stringify(expected);

	const normalizedSpool = join(isolatedRoot, "normalized-spool");
	const legacySpool = join(isolatedRoot, "legacy-native-spool");
	const fakeBin = join(isolatedRoot, "failing-fallbacks");
	mkdirSync(normalizedSpool, { recursive: true });
	mkdirSync(legacySpool, { recursive: true });
	mkdirSync(fakeBin, { recursive: true });
	const legacyBody = '{"native":"payload"}';
	const legacyPath = join(legacySpool, "native-hook.json");
	writeFileSync(legacyPath, legacyBody, "utf8");
	for (const command of ["codemem", "npx"]) {
		const commandPath = join(fakeBin, command);
		writeFileSync(commandPath, "#!/bin/sh\nexit 1\n", "utf8");
		chmodSync(commandPath, 0o755);
	}

	const baseEnv = {
		...process.env,
		PATH: fakeBin,
		CODEMEM_CODEX_HOOK_HTTP_TIMEOUT_MS: "50",
		CODEMEM_CODEX_RAW_EVENT_SPOOL_DIR: normalizedSpool,
		CODEMEM_CODEX_HOOK_SPOOL_DIR: legacySpool,
		CODEMEM_VIEWER_HOST: "127.0.0.1",
	};
	const failingServer = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			response.writeHead(503);
			response.end();
		});
	});
	await new Promise((resolvePromise, reject) => {
		failingServer.once("error", reject);
		failingServer.listen(0, "127.0.0.1", resolvePromise);
	});
	const failingAddress = failingServer.address();
	assert(failingAddress && typeof failingAddress === "object", "codex failure smoke server did not bind");
	let failedDelivery;
	try {
		failedDelivery = await runAsync(
			process.execPath,
			[wrapperPath],
			{
				cwd: isolatedRoot,
				env: { ...baseEnv, CODEMEM_VIEWER_PORT: String(failingAddress.port) },
				stdio: ["pipe", "pipe", "pipe"],
			},
			JSON.stringify(nativePayload),
		);
	} finally {
		await new Promise((resolvePromise) => failingServer.close(resolvePromise));
	}
	assert(failedDelivery.status === 0, `codex spool fallback failed: ${failedDelivery.stderr}`);
	assert(failedDelivery.stdout === '{"continue":true}\n', "codex spool fallback did not safely continue");
	const normalizedFiles = readdirSync(normalizedSpool).filter((name) => name.endsWith(".json"));
	assert(normalizedFiles.length === 1, "codex fallback did not write exactly one normalized envelope");
	assert(
		readFileSync(join(normalizedSpool, normalizedFiles[0]), "utf8") === expectedBody,
		"codex fallback changed serialized normalized-envelope bytes",
	);
	assert(readFileSync(legacyPath, "utf8") === legacyBody, "codex fallback modified the legacy native spool");

	const seededPayload = { ...nativePayload, session_id: "packed-codex-seeded-backlog" };
	const seededEnvelope = normalizer.buildRawEventEnvelopeFromCodexHook(
		seededPayload,
		normalizer.TRUSTED_HOOK_MAPPER_OPTIONS,
	);
	assert(seededEnvelope, "codex generated normalizer skipped seeded backlog payload");
	const seededBody = JSON.stringify(seededEnvelope);
	const seededPath = join(normalizedSpool, "raw-event-z-seeded.json");
	writeFileSync(seededPath, seededBody, "utf8");

	const deliveredBodies = [];
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			deliveredBodies.push(body);
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end('{"inserted":1,"skipped":0,"received":1}');
		});
	});
	await new Promise((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolvePromise);
	});
	try {
		const address = server.address();
		assert(address && typeof address === "object", "codex spool smoke server did not bind");
		const currentPayload = { ...nativePayload, session_id: "packed-codex-current" };
		const currentEnvelope = normalizer.buildRawEventEnvelopeFromCodexHook(
			currentPayload,
			normalizer.TRUSTED_HOOK_MAPPER_OPTIONS,
		);
		assert(currentEnvelope, "codex generated normalizer skipped current drain payload");
		const drained = await runAsync(
			process.execPath,
			[wrapperPath],
			{
				cwd: isolatedRoot,
				env: { ...baseEnv, CODEMEM_VIEWER_PORT: String(address.port) },
				stdio: ["pipe", "pipe", "pipe"],
			},
			JSON.stringify(currentPayload),
		);
		assert(drained.status === 0, `codex bounded spool drain failed: ${drained.stderr}`);
		assert(deliveredBodies.length === 2, "codex wrapper must drain at most one queued envelope per invocation");
		assert(deliveredBodies[0] === JSON.stringify(currentEnvelope), "codex current delivery bytes changed");
		assert(deliveredBodies[1] === expectedBody, "codex queued delivery bytes changed");
		assert(readdirSync(normalizedSpool).filter((name) => name.endsWith(".json")).length === 1, "codex drain was not bounded to one queued envelope");
		assert(readFileSync(seededPath, "utf8") === seededBody, "codex bounded drain removed the second queued envelope");
		assert(readFileSync(legacyPath, "utf8") === legacyBody, "codex drain modified the legacy native spool");
	} finally {
		await new Promise((resolvePromise) => server.close(resolvePromise));
	}
}

try {
	const coreTarball = run("pnpm", ["pack", "--pack-destination", tempDir], resolve(workspaceRoot, "packages/core"))
		.stdout.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.at(-1);
	const mcpTarball = run("pnpm", ["pack", "--pack-destination", tempDir], resolve(workspaceRoot, "packages/mcp-server"))
		.stdout.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.at(-1);
	const serverTarball = run("pnpm", ["pack", "--pack-destination", tempDir], resolve(workspaceRoot, "packages/viewer-server"))
		.stdout.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.at(-1);
	const packResult = run("pnpm", ["pack", "--pack-destination", tempDir]);
	const packedTarball = packResult.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.at(-1);

	assert(Boolean(coreTarball), "pnpm pack did not report a core tarball path");
	assert(Boolean(mcpTarball), "pnpm pack did not report an mcp tarball path");
	assert(Boolean(serverTarball), "pnpm pack did not report a server tarball path");
	assert(Boolean(packedTarball), "pnpm pack did not report a tarball path");
	assert(existsSync(coreTarball), `Packed core tarball not found: ${coreTarball}`);
	assert(existsSync(mcpTarball), `Packed mcp tarball not found: ${mcpTarball}`);
	assert(existsSync(serverTarball), `Packed server tarball not found: ${serverTarball}`);
	assert(existsSync(packedTarball), `Packed tarball not found: ${packedTarball}`);

	const tarListing = run("tar", ["-tf", packedTarball]).stdout;
	assert(tarListing.includes("package/dist/index.js"), "Packed artifact is missing dist/index.js");
	assert(tarListing.includes("package/README.md"), "Packed artifact is missing README.md");

	const installDir = join(tempDir, "install");
	run("npm", ["install", "--prefix", installDir, coreTarball, mcpTarball, serverTarball, packedTarball]);

	const installedPackageRoot = join(installDir, "node_modules", "codemem");
	const cliBin = join(installDir, "node_modules", ".bin", process.platform === "win32" ? "codemem.cmd" : "codemem");

	assert(existsSync(cliBin), "Installed artifact is missing the codemem binary");
	assert(existsSync(join(installedPackageRoot, "dist", "index.js")), "Installed artifact is missing dist/index.js");
	assert(
		existsSync(join(installedPackageRoot, "README.md")),
		"Installed artifact is missing README.md",
	);

	const helpOutput = run(cliBin, ["--help"]).stdout;
	assert(helpOutput.includes("persistent memory for AI coding agents"), "Installed CLI help output is missing expected text");

	const versionOutput = run(cliBin, ["version"]).stdout.trim();
	assert(versionOutput === packageVersion, `Installed CLI reported ${versionOutput}, expected ${packageVersion}`);

	const isolatedAdapters = join(tempDir, "isolated-adapters");
	await buildAdapterNormalizers(isolatedAdapters);
	for (const source of ["claude", "codex"]) {
		const checkedInArtifact = resolve(
			workspaceRoot,
			"plugins",
			source,
			"scripts",
			"codemem-normalizer.mjs",
		);
		assert(existsSync(checkedInArtifact), `${source} plugin is missing its generated normalizer`);
		await smokeAdapterWrapper(source, isolatedAdapters);
		if (source === "claude") await smokeClaudePromptWrapper(isolatedAdapters);
	}
	await smokeCodexSpoolIsolation(isolatedAdapters);
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}
