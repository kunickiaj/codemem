import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = process.cwd();
const workspaceRoot = resolve(packageRoot, "..", "..");
const pinnedVersion = "2.0.2";
const packedPluginTarget = "./node_modules/@codemem/opencode-plugin";
const packedFixtureTarget = "./node_modules/@codemem/opencode-plugin/v2-contract-fixture";
const tempDir = mkdtempSync(join(tmpdir(), "codemem-opencode-v2-contract-"));
let providerServer;
let hostProcess;

function fail(message, result) {
	if (result?.stdout) process.stderr.write(result.stdout);
	if (result?.stderr) process.stderr.write(result.stderr);
	throw new Error(message);
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? packageRoot,
		encoding: "utf8",
		env: options.env ?? process.env,
		timeout: options.timeoutMs ?? 300_000,
	});
	if (result.error) fail(`Command failed: ${command} ${args.join(" ")}`, result);
	if (result.status !== 0) fail(`Command failed: ${command} ${args.join(" ")}`, result);
	return result;
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function isExpectedProjectPath(value, expectedPath) {
	return (
		typeof value === "string" &&
		existsSync(value) &&
		realpathSync(value) === realpathSync(expectedPath)
	);
}

function runAsync(command, args, options = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd ?? packageRoot,
			env: options.env ?? process.env,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		let timedOut = false;
		const timeoutMs = options.timeoutMs ?? 300_000;
		let forceKill;
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill();
			forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
		}, timeoutMs);
		child.on("error", (error) => {
			clearTimeout(timeout);
			clearTimeout(forceKill);
			reject(error);
		});
		child.on("close", (status) => {
			clearTimeout(timeout);
			clearTimeout(forceKill);
			const result = { status, stdout, stderr };
			if (timedOut) {
				reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`));
				return;
			}
			if (status !== 0) {
				reject(new Error(`Command failed: ${command} ${args.join(" ")}\n${stdout}${stderr}`));
				return;
			}
			resolvePromise(result);
		});
	});
}

async function startProvider(projectDir) {
	let attempts = 0;
	let primaryAttempts = 0;
	const observations = [];
	const server = createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		if (!request.url?.endsWith("/chat/completions")) {
			response.writeHead(404).end();
			return;
		}
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		const requestKind = request.headers["x-codemem-contract-kind"];
		observations.push({
			messages: body.messages?.map((message) => ({
				role: message.role,
				mentionsFailure: JSON.stringify(message.content).includes("failure"),
			})),
			tools: body.tools
				?.filter((tool) => tool.function?.name === "read")
				.map((tool) => ({
					name: tool.function?.name,
					description: tool.function?.description,
				})),
			toolNames: body.tools?.map((tool) => tool.function?.name).filter(Boolean),
		});
		attempts += 1;
		if (requestKind === "primary") primaryAttempts += 1;
		if (requestKind === "primary" && primaryAttempts === 1) {
			response.writeHead(429, {
				"content-type": "application/json",
				"retry-after-ms": "1",
			});
			response.end(
				JSON.stringify({ error: { message: "contract retry", type: "rate_limit_error" } }),
			);
			return;
		}
		response.writeHead(200, { "content-type": "text/event-stream" });
		const messages = Array.isArray(body.messages) ? body.messages : [];
		const latestUserIndex = messages.findLastIndex((message) => message.role === "user");
		const messagesAfterPrompt = messages.slice(latestUserIndex + 1);
		const hasToolResult = messagesAfterPrompt.some((message) => message.role === "tool");
		const requestFailure = JSON.stringify(messages.at(latestUserIndex)).includes("failure");
		const selectedTool =
			requestKind === "primary"
				? body.tools?.find((tool) => tool.function?.name === "read")?.function?.name
				: undefined;
		if (!hasToolResult && selectedTool) {
			response.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-contract-tool",
					object: "chat.completion.chunk",
					created: 0,
					model: "contract-model",
					choices: [
						{
							index: 0,
							delta: {
								role: "assistant",
								tool_calls: [
									{
										index: 0,
										id: requestFailure ? "call-contract-error" : "call-contract-completed",
										type: "function",
										function: {
											name: selectedTool,
											arguments: JSON.stringify({
												path: requestFailure
													? join(projectDir, "missing-contract-file")
													: join(projectDir, "package.json"),
											}),
										},
									},
								],
							},
							finish_reason: null,
						},
					],
				})}\n\n`,
			);
			response.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-contract-tool",
					object: "chat.completion.chunk",
					created: 0,
					model: "contract-model",
					choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
				})}\n\n`,
			);
			response.end("data: [DONE]\n\n");
			return;
		}
		const responseText =
			requestKind === "compaction"
				? "## Objective\n- Verify the OpenCode 2 contract\n\n## Next Move\n1. Continue"
				: "contract-ok";
		response.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-contract",
				object: "chat.completion.chunk",
				created: 0,
				model: "contract-model",
				choices: [
					{
						index: 0,
						delta: { role: "assistant", content: responseText },
						finish_reason: null,
					},
				],
			})}\n\n`,
		);
		response.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-contract",
				object: "chat.completion.chunk",
				created: 0,
				model: "contract-model",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			})}\n\n`,
		);
		response.end("data: [DONE]\n\n");
	});
	await new Promise((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolvePromise);
	});
	const address = server.address();
	assert(address && typeof address === "object", "Local provider did not bind a TCP port");
	return {
		attempts: () => attempts,
		baseURL: `http://127.0.0.1:${address.port}/v1`,
		observations: () => observations,
		primaryAttempts: () => primaryAttempts,
		server,
	};
}

function closeServer(server) {
	return new Promise((resolvePromise, reject) => {
		server.close((error) => {
			if (error) reject(error);
			else resolvePromise();
		});
	});
}

async function startHost(opencode2, projectDir, env) {
	const child = spawn(opencode2, ["serve", "--hostname", "127.0.0.1"], {
		cwd: projectDir,
		env,
	});
	hostProcess = child;
	let output = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		output += chunk;
	});
	child.stderr.on("data", (chunk) => {
		output += chunk;
	});
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (child.exitCode !== null) throw new Error(`Pinned host exited during startup\n${output}`);
		const match = output.match(/server listening on (http:\/\/\S+)/);
		if (!match) {
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
			continue;
		}
		const baseURL = match[1];
		try {
			const response = await fetch(`${baseURL}/api/health`, {
				headers: {
					Authorization: `Basic ${Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`,
				},
			});
			if (response.ok) return { baseURL, child, output: () => output };
		} catch {
			// The server has not bound the port yet.
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
	}
	try {
		await stopHost(child);
	} catch {
		process.stderr.write("Warning: unable to stop the pinned host after failed startup\n");
	}
	throw new Error(`Pinned host did not start\n${output}`);
}

async function promptHost(opencode2, host, sessionID, text, options) {
	await runAsync(
		opencode2,
		[
			"api",
			"--server",
			host.baseURL,
			"POST",
			`/api/session/${sessionID}/prompt`,
			"--data",
			JSON.stringify({ text }),
		],
		options,
	);
	await runAsync(
		opencode2,
		["api", "--server", host.baseURL, "POST", `/api/session/${sessionID}/wait`],
		options,
	);
}

async function generateHost(opencode2, host, sessionID, options) {
	await runAsync(
		opencode2,
		[
			"api",
			"--server",
			host.baseURL,
			"POST",
			`/api/session/${sessionID}/generate`,
			"--data",
			JSON.stringify({ prompt: "contract generation probe" }),
		],
		options,
	);
}

async function compactHost(opencode2, host, sessionID, options) {
	await runAsync(
		opencode2,
		[
			"api",
			"--server",
			host.baseURL,
			"POST",
			`/api/session/${sessionID}/compact`,
			"--data",
			JSON.stringify({}),
		],
		options,
	);
	await runAsync(
		opencode2,
		["api", "--server", host.baseURL, "POST", `/api/session/${sessionID}/wait`],
		options,
	);
}

async function stopHost(child) {
	if (child.exitCode !== null) return;
	const closed = once(child, "close");
	child.kill();
	const forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
	let stopTimeoutID;
	const stopTimeout = new Promise((_, reject) => {
		stopTimeoutID = setTimeout(() => reject(new Error("Pinned host did not stop")), 10_000);
	});
	try {
		await Promise.race([closed, stopTimeout]);
	} finally {
		clearTimeout(forceKill);
		clearTimeout(stopTimeoutID);
	}
}

function readContractRecords(reportPath, hostResult) {
	if (!existsSync(reportPath)) {
		fail("Pinned OpenCode 2 host did not activate the contract plugin", hostResult);
	}
	return readFileSync(reportPath, "utf8")
		.split(/\r?\n/u)
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

async function waitForContractPhase(reportPath, phase, hostResult, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const records = readContractRecords(reportPath, hostResult);
			if (records.some((record) => record.phase === phase)) return;
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
	}
	throw new Error(`Pinned host did not dispatch the ${phase} hook within ${timeoutMs}ms`);
}

try {
	run("pnpm", ["pack", "--pack-destination", tempDir]);
	const tarballs = readdirSync(tempDir).filter((name) => name.endsWith(".tgz"));
	assert(tarballs.length === 1, `pnpm pack produced ${tarballs.length} plugin tarballs`);
	const tarball = join(tempDir, tarballs[0]);

	const installDir = join(tempDir, "install");
	mkdirSync(installDir, { recursive: true });
	writeFileSync(join(installDir, "package.json"), JSON.stringify({ private: true }), "utf8");
	run("npm", ["install", tarball, `@opencode/plugin@${pinnedVersion}`], { cwd: installDir });

	const installedFixture = join(
		installDir,
		"node_modules",
		"@codemem",
		"opencode-plugin",
		"src",
		"opencode-v2-contract-fixture.ts",
	);
	assert(existsSync(installedFixture), "Packed plugin is missing the OpenCode 2 contract fixture");

	const projectDir = installDir;
	const homeDir = join(tempDir, "home");
	mkdirSync(homeDir, { recursive: true });
	const reportPath = join(tempDir, "contract-report.jsonl");
	const env = {
		PATH: process.env.PATH ?? "",
		HOME: homeDir,
		XDG_CONFIG_HOME: join(homeDir, ".config"),
		CODEMEM_BACKEND_UPDATE_POLICY: "off",
		CODEMEM_RAW_EVENTS: "0",
		CODEMEM_VIEWER: "0",
		CODEMEM_OPENCODE_V2_CONTRACT_REPORT: reportPath,
		OPENCODE_DISABLE_AUTOUPDATE: "true",
		OPENCODE_DISABLE_MODELS_FETCH: "true",
		OPENCODE_SERVER_PASSWORD: randomBytes(32).toString("base64url"),
	};
	for (const name of ["TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT", "COMSPEC", "PATHEXT"]) {
		if (process.env[name]) env[name] = process.env[name];
	}
	const provider = await startProvider(projectDir);
	providerServer = provider.server;
	writeFileSync(
		join(projectDir, "opencode.json"),
		JSON.stringify({
			model: { providerID: "contract", model: "contract-model" },
			plugins: [
				{ package: packedPluginTarget },
				{
					package: packedFixtureTarget,
					options: { contract: true },
				},
			],
			providers: {
				contract: {
					package: "@opencode/ai/providers/openai-compatible",
					settings: {
						apiKey: provider.baseURL,
						baseURL: provider.baseURL,
						provider: "contract",
					},
					models: {
						"contract-model": {
							modelID: "contract-model",
							limit: { context: 200000, output: 8192 },
						},
					},
				},
			},
		}),
		"utf8",
	);

	const opencode2 = resolve(
		workspaceRoot,
		"packages/opencode-plugin/node_modules/@opencode/cli/bin/opencode.exe",
	);
	assert(existsSync(opencode2), "Pinned @opencode/cli did not install the opencode binary");
	const version = run(opencode2, ["--version"], { cwd: projectDir, env }).stdout.trim();
	assert(
		version === `opencode v${pinnedVersion}`,
		`Pinned host reported ${JSON.stringify(version)}, expected opencode v${pinnedVersion}`,
	);
	const repositoryDir = join(installDir, "repository");
	const worktreeDir = join(installDir, "worktree");
	const worktreeActiveDirectory = join(worktreeDir, "nested");
	mkdirSync(repositoryDir, { recursive: true });
	const gitEnv = {
		...process.env,
		GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
	};
	delete gitEnv.GIT_DIR;
	delete gitEnv.GIT_WORK_TREE;
	run("git", ["init", "--initial-branch=main"], { cwd: repositoryDir, env: gitEnv });
	run("git", ["config", "user.email", "contract@example.invalid"], {
		cwd: repositoryDir,
		env: gitEnv,
	});
	run("git", ["config", "user.name", "Codemem Contract"], {
		cwd: repositoryDir,
		env: gitEnv,
	});
	writeFileSync(join(repositoryDir, "package.json"), JSON.stringify({ private: true }), "utf8");
	writeFileSync(
		join(repositoryDir, "opencode.json"),
		JSON.stringify({
			plugins: [
				{
					package: "../node_modules/@codemem/opencode-plugin/v2-contract-fixture",
					options: { contract: true },
				},
			],
		}),
		"utf8",
	);
	run("git", ["add", "package.json", "opencode.json"], { cwd: repositoryDir, env: gitEnv });
	run("git", ["commit", "-m", "contract fixture"], { cwd: repositoryDir, env: gitEnv });
	run("git", ["worktree", "add", "-b", "contract-worktree", worktreeDir], {
		cwd: repositoryDir,
		env: gitEnv,
	});
	mkdirSync(worktreeActiveDirectory, { recursive: true });
	const worktreeResult = run(
		opencode2,
		[
			"api",
			"--standalone",
			"POST",
			"/api/plugin/await-activation",
			"--param",
			`location=${worktreeActiveDirectory}`,
			"--print-logs",
		],
		{ cwd: worktreeActiveDirectory, env },
	);
	const worktreeRecords = readContractRecords(reportPath, worktreeResult);
	assert(
		worktreeRecords.some(
			(record) =>
				record.phase === "setup" &&
				isExpectedProjectPath(record.directory, worktreeActiveDirectory) &&
				isExpectedProjectPath(record.projectDirectory, worktreeDir) &&
				isExpectedProjectPath(record.projectCanonical, repositoryDir),
		),
		"Pinned host collapsed or swapped the active, worktree, and canonical project paths",
	);
	writeFileSync(reportPath, "", "utf8");
	const configResult = run(opencode2, [
		"api",
		"--standalone",
		"GET",
		"/api/config",
		"--param",
		`location=${projectDir}`,
		"--print-logs",
	], {
		cwd: projectDir,
		env,
	});
	assert(
		configResult.stdout.includes(JSON.stringify(packedPluginTarget)),
		"Pinned host did not report the installed package plugin target",
	);
	assert(
		configResult.stdout.includes(JSON.stringify(packedFixtureTarget)),
		"Pinned host did not report the configured project plugin target",
	);
	const hostResult = run(opencode2, [
		"api",
		"--standalone",
		"POST",
		"/api/plugin/await-activation",
		"--param",
		`location=${projectDir}`,
		"--print-logs",
	], {
		cwd: projectDir,
		env,
	});
	const hostLogLines = `${hostResult.stdout}\n${hostResult.stderr}`.split(/\r?\n/u);
	const installedPluginPath = "node_modules/@codemem/opencode-plugin";
	assert(
		hostLogLines.some(
			(line) =>
				line.includes("loading plugin") && line.includes(`${installedPluginPath}/index.js`),
		),
		"Pinned host did not attempt to load the installed dual plugin",
	);
	assert(
		!hostLogLines.some(
			(line) =>
				line.includes("failed to load plugin") &&
				line.includes(installedPluginPath) &&
				!line.includes("v2-contract-fixture"),
		),
		"Pinned host rejected the installed dual plugin",
	);
	const sessionResult = run(
		opencode2,
		[
			"api",
			"--standalone",
			"POST",
			"/api/session",
			"--param",
			`location=${projectDir}`,
			"--data",
			JSON.stringify({
				agent: "build",
				model: { providerID: "contract", id: "contract-model" },
				location: { directory: projectDir },
			}),
		],
		{ cwd: projectDir, env },
	);
	const sessionResponse = JSON.parse(sessionResult.stdout);
	const sessionID = sessionResponse.id ?? sessionResponse.data?.id;
	assert(typeof sessionID === "string", "Pinned host did not create a contract session");
	writeFileSync(reportPath, "", "utf8");
	const host = await startHost(opencode2, projectDir, env);
	await promptHost(opencode2, host, sessionID, "contract success probe", {
		cwd: projectDir,
		env,
	});
	await promptHost(opencode2, host, sessionID, "contract failure probe", {
		cwd: projectDir,
		env,
	});
	await generateHost(opencode2, host, sessionID, { cwd: projectDir, env });
	await waitForContractPhase(reportPath, "generate", {
		stdout: host.output(),
		stderr: "",
	});
	await compactHost(opencode2, host, sessionID, { cwd: projectDir, env });
	await waitForContractPhase(reportPath, "title", {
		stdout: host.output(),
		stderr: "",
	});
	const expectedEventTypes = [
		"session.inbox.enqueued",
		"session.step.ended",
		"session.execution.succeeded",
		"session.text.ended",
	];
	const eventDeadline = Date.now() + 10_000;
	let deliveredEventTypes = new Set();
	while (Date.now() < eventDeadline) {
		let currentRecords;
		try {
			currentRecords = readContractRecords(reportPath, {
				stdout: host.output(),
				stderr: "",
			});
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
			continue;
		}
		deliveredEventTypes = new Set(
			currentRecords.filter((record) => record.phase === "event").map((record) => record.type),
		);
		if (expectedEventTypes.every((eventType) => deliveredEventTypes.has(eventType))) break;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
	}
	assert(
		expectedEventTypes.every((eventType) => deliveredEventTypes.has(eventType)),
		`Pinned host did not deliver expected events before shutdown; observed ${JSON.stringify([...deliveredEventTypes])}`,
	);
	await stopHost(hostProcess);
	hostProcess = undefined;

	const records = readContractRecords(reportPath, { stdout: host.output(), stderr: "" });
	const observedHooks = records
		.filter((record) => typeof record.phase === "string")
		.map((record) => `${record.phase}:${record.kind ?? "none"}`)
		.join(", ");
	assert(
		records.some(
			(record) =>
				record.phase === "setup" &&
				isExpectedProjectPath(record.directory, projectDir) &&
				isExpectedProjectPath(record.projectDirectory, projectDir) &&
				isExpectedProjectPath(record.projectCanonical, projectDir) &&
				JSON.stringify(record.optionKeys) === JSON.stringify(["contract"]),
		),
		"Persistent host setup omitted the expected location or plugin options",
	);
	assert(
		records.some(
			(record) => record.phase === "storage" && record.valueMatches && record.removed,
		),
		"Persistent host storage did not preserve the exact value or remove the probe",
	);
	assert(
		records.some((record) => record.phase === "event.end" && record.aborted === true),
		"Host event subscription did not end cleanly after abort",
	);
	assert(
		records.some(
			(record) =>
				record.phase === "event" &&
				record.type === "session.inbox.enqueued" &&
				record.hasInboxID &&
				record.hasSessionID &&
				record.hasTextPayload &&
				record.isUserItem,
		),
		"Pinned host inbox event omitted the expected content-free payload shape",
	);
	assert(
		records.some(
			(record) =>
				record.phase === "event" &&
				record.type === "session.step.ended" &&
				record.hasAssistantMessageID &&
				record.hasFinish &&
				record.hasSessionID &&
				record.hasTokens,
		),
		"Pinned host step-ended event omitted the expected content-free payload shape",
	);
	const observedFinishReasons = new Set(
		records
			.filter((record) => record.phase === "event" && record.type === "session.step.ended")
			.map((record) => record.finish),
	);
	assert(
		observedFinishReasons.has("tool-calls") && observedFinishReasons.has("stop"),
		`Pinned host tool continuation omitted terminal finish evidence; observed ${JSON.stringify([...observedFinishReasons])}`,
	);
	const eventRecords = records.filter((record) => record.phase === "event");
	const terminalStepIndex = eventRecords.findIndex(
		(record) => record.type === "session.step.ended" && record.finish === "stop",
	);
	const precedingTextIndex = eventRecords.findLastIndex(
		(record, index) => index < terminalStepIndex && record.type === "session.text.ended",
	);
	assert(
		precedingTextIndex >= 0 && precedingTextIndex < terminalStepIndex,
		"Pinned host did not deliver assistant text before its terminal step",
	);
	assert(
		records.some(
			(record) =>
				record.phase === "event" &&
				record.type === "session.execution.succeeded" &&
				record.hasSessionID,
		),
		"Pinned host execution terminal event omitted session identity",
	);
	assert(
		records.some(
			(record) =>
				record.phase === "tool.transform" &&
				record.declaredName === "contract-probe" &&
				record.effectiveID === null,
		),
		"Host unexpectedly exposed an effective ID while adding the hyphenated tool name",
	);
	assert(
		records.some(
			(record) =>
				record.phase === "context" &&
				record.alreadyMarked === false &&
				record.hasAgent &&
				record.messagesMutable &&
				record.hasModel &&
				record.hasSessionID &&
				record.optionsMutable &&
				record.systemMutable &&
				record.toolsMutable &&
				record.sessionID === sessionID &&
				typeof record.latestUserMessageID === "string" &&
				typeof record.agent === "string" &&
				record.agent.length > 0 &&
				typeof record.model === "object" &&
				record.model != null,
		),
		"Pinned host context hook did not expose fresh mutable fields and durable message identity",
	);
	for (const phase of ["compaction", "generate", "title"]) {
		assert(
			records.some(
				(record) =>
					record.phase === phase &&
					record.messagesMutable &&
					record.optionsMutable &&
					record.systemMutable,
			),
			`Pinned host did not dispatch a mutable ${phase} hook; observed ${observedHooks}`,
		);
	}
	assert(
		records.some(
			(record) =>
				record.phase === "prompt" &&
				record.sessionID === sessionID &&
				typeof record.messageID === "string" &&
				record.messageID.length > 0,
		),
		`Pinned host did not dispatch the prompt hook with session and message identity; observed ${observedHooks}`,
	);
	const promptMessageIDs = records
		.filter((record) => record.phase === "prompt" && typeof record.messageID === "string")
		.map((record) => record.messageID);
	assert(promptMessageIDs.length >= 2, "Pinned host did not report both contract prompt IDs");
	for (const messageID of promptMessageIDs.slice(0, 2)) {
		const matchingContexts = records.filter(
			(record) => record.phase === "context" && record.latestUserMessageID === messageID,
		);
		assert(
			matchingContexts.length >= 2,
			`Pinned host did not repeat latest user message ID ${messageID} across the turn`,
		);
		assert(
			matchingContexts.every((record) => record.alreadyMarked === false),
			`Pinned host reused mutable context input for user message ID ${messageID}`,
		);
	}
	for (const kind of ["primary", "compaction", "generate", "title"]) {
		assert(
			records.some((record) => record.phase === "model.request" && record.kind === kind),
			`Pinned host did not dispatch the ${kind} model-request hook; observed ${observedHooks}`,
		);
	}
	assert(
		records.some(
			(record) =>
				record.phase === "http.request" &&
				record.kind === "primary" &&
				record.kindHeader === "primary",
		),
		"Pinned host did not preserve the primary kind header on the HTTP request",
	);
	assert(
		records.some(
			(record) =>
				record.phase === "http.response" &&
				record.kind === "primary" &&
				record.kindHeader === "primary",
		),
		"Pinned host did not preserve the primary kind header on the HTTP response",
	);
	assert(
		records.some(
			(record) =>
				record.phase === "retry" &&
				record.retry === true &&
				Number.isInteger(record.attempt) &&
				record.attempt >= 0 &&
				record.hasKind === false &&
				record.hasRequestID === false,
		),
		`Pinned host did not dispatch an accepted retry; observed ${observedHooks}`,
	);
	for (const status of ["completed", "error"]) {
		assert(
			records.some(
				(record) =>
					record.phase === "tool.execute.after" &&
					record.status === status &&
					record.hasAgent &&
					record.hasCallID &&
					record.hasInput &&
					record.hasMessageID &&
					record.hasSessionID &&
					record.hasTool,
			),
			`Pinned host did not dispatch the ${status} tool hook with full identity; provider observed ${JSON.stringify(provider.observations())}; tool records ${JSON.stringify(records.filter((record) => record.phase === "tool.execute.after"))}`,
		);
	}
	assert(
		provider.primaryAttempts() >= 2,
		`Local provider received ${provider.primaryAttempts()} primary requests across ${provider.attempts()} requests`,
	);
	assert(
		provider.observations().some((observation) =>
			["mem-status", "mem-recent", "mem-stats"].every((name) =>
				observation.toolNames?.includes(name),
			),
		),
		`Pinned host did not expose V2 memory-tool IDs; observed ${JSON.stringify(provider.observations().map((observation) => observation.toolNames))}`,
	);
	assert(records.some((record) => record.phase === "cleanup"), "Host omitted plugin cleanup on unload");
	process.stdout.write(`OpenCode ${version}: packed contract passed (${records.length} records)\n`);
} finally {
	if (hostProcess) {
		try {
			await stopHost(hostProcess);
		} catch {
			process.stderr.write("Warning: unable to stop the pinned OpenCode 2 host\n");
		}
	}
	if (providerServer) {
		try {
			await closeServer(providerServer);
		} catch {
			process.stderr.write("Warning: unable to stop the OpenCode 2 contract provider\n");
		}
	}
	try {
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	} catch {
		process.stderr.write("Warning: unable to remove the OpenCode 2 smoke-test directory\n");
	}
}
