import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
	HistoricalInjectionFailureV1,
	HistoricalInjectionRequestV1,
	HistoricalInjectionResponseV1,
	JsonValue,
} from "./types.js";

function failure(
	code: HistoricalInjectionFailureV1["error"]["code"],
	message: string,
): HistoricalInjectionFailureV1 {
	return { schema_version: 1, ok: false, error: { code, message } };
}
function object(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new TypeError(`${path} must be an object`);
	return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[], path: string): void {
	if (Object.keys(value).toSorted().join("\0") !== keys.toSorted().join("\0"))
		throw new TypeError(`${path} contains unsupported fields`);
}

export function parseHistoricalInjectionRequest(value: unknown): HistoricalInjectionRequestV1 {
	const root = object(value, "request");
	exact(root, ["schema_version", "operation", "case"], "request");
	if (root.schema_version !== 1 || root.operation !== "run_plugin_injection")
		throw new TypeError("unsupported request");
	const entry = object(root.case, "request.case");
	exact(
		entry,
		["first_prompt", "latest_prompt", "project_name", "files_modified", "disabled", "pack"],
		"request.case",
	);
	if (
		[entry.first_prompt, entry.latest_prompt, entry.project_name].some(
			(item) => typeof item !== "string",
		) ||
		typeof entry.disabled !== "boolean" ||
		!Array.isArray(entry.files_modified) ||
		entry.files_modified.some((item) => typeof item !== "string")
	)
		throw new TypeError("request.case has invalid fields");
	const pack = object(entry.pack, "request.case.pack");
	exact(pack, ["outcome", "pack_text", "memory_ids"], "request.case.pack");
	if (
		!["success", "empty", "malformed", "exit_error"].includes(String(pack.outcome)) ||
		typeof pack.pack_text !== "string" ||
		!Array.isArray(pack.memory_ids) ||
		pack.memory_ids.some((item) => typeof item !== "string")
	)
		throw new TypeError("request.case.pack has invalid fields");
	return root as unknown as HistoricalInjectionRequestV1;
}

function user(messageID: string, sessionID: string, text: string): JsonValue {
	return {
		info: { id: messageID, sessionID, role: "user" },
		parts: [{ id: `${messageID}-text`, sessionID, messageID, type: "text", text }],
	};
}
async function notify(
	hooks: Record<string, unknown>,
	sessionID: string,
	messageID: string,
	text: string,
): Promise<void> {
	if (typeof hooks.event !== "function") return;
	await hooks.event({
		event: {
			type: "message.updated",
			properties: { sessionID, info: { id: messageID, role: "user" } },
		},
	});
	await hooks.event({
		event: {
			type: "message.part.updated",
			properties: { sessionID, part: { messageID, type: "text", text } },
		},
	});
}

async function main(): Promise<HistoricalInjectionResponseV1> {
	const [pluginPath, runnerPath, tracePath] = process.argv.slice(2);
	if (!pluginPath || !runnerPath || !tracePath)
		return failure("invalid_request", "plugin, runner, and trace paths are required");
	let input: HistoricalInjectionRequestV1;
	try {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
		input = parseHistoricalInjectionRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
	} catch (error) {
		return failure("invalid_request", error instanceof Error ? error.message : String(error));
	}
	Object.assign(process.env, {
		CODEMEM_RUNNER: process.execPath,
		CODEMEM_RUNNER_FROM: runnerPath,
		CODEMEM_VIEWER: "0",
		CODEMEM_RAW_EVENTS: "0",
		CODEMEM_PLUGIN_DEBUG: "0",
		CODEMEM_PLUGIN_LOG: "0",
		CODEMEM_BACKEND_UPDATE_POLICY: "off",
		CODEMEM_INJECT_CONTEXT: input.case.disabled ? "0" : "1",
		CODEMEM_FAKE_PACK_JSON: JSON.stringify(input.case.pack),
		CODEMEM_FAKE_TRACE_PATH: tracePath,
	});
	delete process.env.CODEMEM_INJECT_SURFACE;
	try {
		const module = (await import(`${pathToFileURL(pluginPath).href}?isolate=${process.pid}`)) as {
			default?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
		};
		if (typeof module.default !== "function")
			return failure("unsupported_subject", "historical plugin has no default export");
		const hooks = await module.default({
			project: { name: input.case.project_name },
			client: { app: { log: async () => {} }, tui: { showToast: async () => {} } },
			directory: process.cwd(),
			worktree: process.cwd(),
		});
		const sessionID = "release-eval-session";
		await notify(hooks, sessionID, "user-first", input.case.first_prompt);
		if (input.case.latest_prompt !== input.case.first_prompt)
			await notify(hooks, sessionID, "user-latest", input.case.latest_prompt);
		if (typeof hooks["tool.execute.after"] === "function")
			for (const filePath of input.case.files_modified)
				await hooks["tool.execute.after"](
					{ sessionID, tool: "edit", args: { filePath } },
					{ args: { filePath }, result: "fixed fake edit" },
				);
		const messages: JsonValue[] = [user("user-first", sessionID, input.case.first_prompt)];
		if (input.case.latest_prompt !== input.case.first_prompt)
			messages.push(
				{
					info: { id: "assistant-between", sessionID, role: "assistant" },
					parts: [
						{
							id: "assistant-between-text",
							sessionID,
							messageID: "assistant-between",
							type: "text",
							text: "continue",
						},
					],
				},
				user("user-latest", sessionID, input.case.latest_prompt),
			);
		const before = { system: ["base system"], messages: structuredClone(messages) };
		const output = { system: [...before.system], messages: structuredClone(messages) };
		const messageHook = hooks["experimental.chat.messages.transform"];
		const transform =
			typeof messageHook === "function" ? messageHook : hooks["experimental.chat.system.transform"];
		if (typeof transform !== "function")
			return failure(
				"unsupported_subject",
				"historical plugin exposes no injection transform hook",
			);
		let survived = true;
		try {
			await transform({ sessionID, model: {} }, output);
		} catch {
			survived = false;
		}
		const runner = (await readFile(tracePath, "utf8").catch(() => ""))
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(
				(line) =>
					JSON.parse(line) as { args: string[]; query: string | null; memory_ids: string[] },
			)
			.at(-1);
		return {
			schema_version: 1,
			ok: true,
			result: {
				hook:
					typeof messageHook === "function"
						? "experimental.chat.messages.transform"
						: "experimental.chat.system.transform",
				runner: {
					invoked: Boolean(runner),
					args: runner?.args ?? [],
					query: runner?.query ?? null,
					memory_ids: runner?.memory_ids ?? [],
				},
				before,
				after: output,
				session_survived: survived,
				process_id: process.pid,
			},
		};
	} catch (error) {
		return failure(
			"subject_execution_failed",
			error instanceof Error ? error.message : String(error),
		);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))
	process.stdout.write(`${JSON.stringify(await main())}\n`);
