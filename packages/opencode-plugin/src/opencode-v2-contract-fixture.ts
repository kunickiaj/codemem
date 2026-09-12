import { appendFile } from "node:fs/promises";
import { Plugin } from "@opencode/plugin";

export const OPEN_CODE_V2_CONTRACT_VERSION = "2.0.2";

export type ContractRecord = Readonly<Record<string, unknown>>;
export type ContractReporter = (record: ContractRecord) => Promise<void> | void;

type Disposable = { readonly dispose: () => Promise<void> };

function identity(input: {
	readonly sessionID: unknown;
	readonly agent: unknown;
	readonly model: unknown;
}) {
	return JSON.stringify([input.sessionID, input.agent, input.model]);
}

export function userMessageIDs(messages: readonly unknown[]) {
	return messages.flatMap((message) => {
		if (message == null || typeof message !== "object") return [];
		const candidate = message as Record<string, unknown>;
		return candidate.role === "user" && typeof candidate.id === "string" ? [candidate.id] : [];
	});
}

export function latestUserMessageID(messages: readonly unknown[]) {
	return userMessageIDs(messages).at(-1) ?? null;
}

export function summarizeEvent(event: unknown): ContractRecord {
	if (event == null || typeof event !== "object") return { family: "generic", type: "unknown" };
	const candidate = event as Record<string, unknown>;
	const type = typeof candidate.type === "string" ? candidate.type : "unknown";
	const family = ["session", "message", "tool"].find((prefix) => type.startsWith(`${prefix}.`));
	const summary: ContractRecord = {
		family: family ?? "generic",
		type,
		hasProperties: candidate.properties != null,
	};
	const data = candidate.data as Record<string, unknown> | undefined;
	if (type === "session.inbox.enqueued") {
		const item = data?.item as Record<string, unknown> | undefined;
		const payload = item?.payload as Record<string, unknown> | undefined;
		return {
			...summary,
			hasInboxID: typeof data?.inboxID === "string",
			hasSessionID: typeof data?.sessionID === "string",
			hasTextPayload: typeof payload?.text === "string",
			isUserItem: item?.type === "user",
		};
	}
	if (type === "session.step.ended") {
		return {
			...summary,
			finish: typeof data?.finish === "string" ? data.finish : null,
			hasAssistantMessageID: typeof data?.assistantMessageID === "string",
			hasFinish: typeof data?.finish === "string",
			hasSessionID: typeof data?.sessionID === "string",
			hasTokens: data?.tokens != null && typeof data.tokens === "object",
		};
	}
	if (type.startsWith("session.execution.")) {
		return { ...summary, hasSessionID: typeof data?.sessionID === "string" };
	}
	return summary;
}

function defaultReporter(record: ContractRecord) {
	const reportPath = process.env.CODEMEM_OPENCODE_V2_CONTRACT_REPORT;
	if (!reportPath) return;
	return appendFile(reportPath, `${JSON.stringify(record)}\n`, "utf8");
}

async function probeStorage(context: Plugin.Context, report: ContractReporter) {
	const key = "codemem-contract/probe";
	const expected = { version: OPEN_CODE_V2_CONTRACT_VERSION };
	await context.storage.set(key, expected);
	const value = await context.storage.get(key);
	await context.storage.remove(key);
	const removed = await context.storage.get(key);
	await report({
		phase: "storage",
		removed: removed == null,
		valueMatches: JSON.stringify(value) === JSON.stringify(expected),
	});
}

async function consumeEvents(
	context: Plugin.Context,
	signal: AbortSignal,
	report: ContractReporter,
) {
	try {
		for await (const event of context.event.subscribe({ signal })) {
			await report({ phase: "event", ...summarizeEvent(event) });
		}
		await report({ phase: "event.end", aborted: signal.aborted });
	} catch (error) {
		if (signal.aborted && error instanceof Error && error.name === "AbortError") {
			await report({ phase: "event.end", aborted: true });
			return;
		}
		throw error;
	}
}

async function registerContextHook(context: Plugin.Context, report: ContractReporter) {
	return context.session.hook("context", async (input) => {
		const alreadyMarked = input.options.codememContract === true;
		input.system = [...input.system];
		input.messages = [...input.messages];
		input.tools = { ...input.tools };
		input.options = { ...input.options, codememContract: true };
		await report({
			phase: "context",
			agent: input.agent,
			alreadyMarked,
			hasAgent: Boolean(input.agent),
			hasModel: Boolean(input.model),
			hasSessionID: Boolean(input.sessionID),
			latestUserMessageID: latestUserMessageID(input.messages),
			messagesMutable: Array.isArray(input.messages),
			model: input.model,
			optionsMutable: typeof input.options === "object",
			sessionID: input.sessionID,
			systemMutable: Array.isArray(input.system),
			toolsMutable: typeof input.tools === "object",
			userMessageIDs: userMessageIDs(input.messages),
		});
	});
}

async function registerAuxiliaryHook(
	context: Plugin.Context,
	report: ContractReporter,
	phase: "compaction" | "generate" | "title",
) {
	return context.session.hook(phase, async (input) => {
		const alreadyMarked = input.options.codememContract === true;
		input.system = [...input.system];
		input.messages = [...input.messages];
		input.options = { ...input.options, codememContract: true };
		await report({
			phase,
			alreadyMarked,
			hasAgent: "agent" in input && Boolean(input.agent),
			hasModel: Boolean(input.model),
			hasSessionID: Boolean(input.sessionID),
			latestUserMessageID: latestUserMessageID(input.messages),
			messagesMutable: Array.isArray(input.messages),
			optionsMutable: typeof input.options === "object",
			sessionID: input.sessionID,
			systemMutable: Array.isArray(input.system),
		});
	});
}

async function registerSessionHooks(
	context: Plugin.Context,
	report: ContractReporter,
	registrations: Disposable[],
) {
	registrations.push(
		await context.session.hook("prompt", async (input) => {
			await report({
				phase: "prompt",
				hasMessageID: Boolean(input.messageID),
				hasSessionID: Boolean(input.sessionID),
				messageID: input.messageID,
				sessionID: input.sessionID,
			});
		}),
	);
	registrations.push(await registerContextHook(context, report));
	registrations.push(await registerAuxiliaryHook(context, report, "compaction"));
	registrations.push(await registerAuxiliaryHook(context, report, "generate"));
	registrations.push(await registerAuxiliaryHook(context, report, "title"));
	registrations.push(
		await context.session.hook("model.request", async (input) => {
			input.headers["x-codemem-contract-kind"] = input.kind;
			await report({ phase: "model.request", kind: input.kind, identity: identity(input) });
		}),
	);
	registrations.push(
		await context.session.hook("http.request", async (input) => {
			await report({
				phase: "http.request",
				kind: input.kind,
				kindHeader: input.request.headers.get("x-codemem-contract-kind"),
			});
		}),
	);
	registrations.push(
		await context.session.hook("http.response", async (input) => {
			await report({
				phase: "http.response",
				kind: input.kind,
				kindHeader: input.request.headers.get("x-codemem-contract-kind"),
			});
		}),
	);
	registrations.push(
		await context.session.hook("retry", async (input) => {
			await report({
				phase: "retry",
				attempt: input.attempt,
				retry: input.decision.retry,
				hasKind: "kind" in input,
				hasRequestID: "requestID" in input,
			});
		}),
	);
}

async function registerToolContracts(
	context: Plugin.Context,
	report: ContractReporter,
	registrations: Disposable[],
) {
	const after = await context.tool.hook("execute.after", async (input) => {
		await report({
			phase: "tool.execute.after",
			hasAgent: Boolean(input.agent),
			status: input.status,
			hasCallID: Boolean(input.id),
			hasInput: input.input != null,
			hasMessageID: Boolean(input.messageID),
			hasSessionID: Boolean(input.sessionID),
			hasTool: Boolean(input.tool),
		});
	});
	registrations.push(after);
	let effectiveID: string | null = null;
	const declaredName = "contract-probe";
	const transform = await context.tool.transform((editor) => {
		editor.add({
			name: declaredName,
			description: "OpenCode 2 contract-only tool",
			input: { type: "object", properties: {}, additionalProperties: false },
			execute: async () => ({ content: "contract-ok" }),
		});
		const added = editor.list().find((tool) => tool.name === declaredName);
		effectiveID = added?.id ?? null;
	});
	registrations.push(transform);
	await report({ phase: "tool.transform", declaredName, effectiveID });
}

async function disposeAll(registrations: readonly Disposable[]) {
	let firstError: unknown;
	for (const registration of [...registrations].reverse()) {
		try {
			await registration.dispose();
		} catch (error) {
			firstError ??= error;
		}
	}
	if (firstError) throw firstError;
}

export function defineOpenCodeV2ContractFixture(report: ContractReporter = defaultReporter) {
	return Plugin.define({
		id: "codemem-v2-contract",
		async setup(context) {
			const abortController = new AbortController();
			const registrations: Disposable[] = [];
			try {
				await report({
					phase: "setup",
					appVersion: context.app.version,
					directory: context.location.directory,
					projectDirectory: context.location.project.directory,
					projectCanonical: context.location.project.canonical,
					hasWorkspaceID: Boolean(context.location.workspaceID),
					optionKeys: Object.keys(context.options).sort(),
					hasLog: "log" in context.app,
					hasToast: "toast" in context || "tui" in context,
				});
				await probeStorage(context, report);
				await registerSessionHooks(context, report, registrations);
				await registerToolContracts(context, report, registrations);
				let eventError: unknown;
				const eventTask = consumeEvents(context, abortController.signal, report).catch((error) => {
					eventError = error;
				});
				return async () => {
					abortController.abort();
					let disposalError: unknown;
					try {
						await disposeAll(registrations);
					} catch (error) {
						disposalError = error;
					}
					await eventTask;
					await report({ phase: "cleanup", disposed: registrations.length });
					if (disposalError) throw disposalError;
					if (eventError) throw eventError;
				};
			} catch (error) {
				abortController.abort();
				await disposeAll(registrations);
				throw error;
			}
		},
	});
}

export default defineOpenCodeV2ContractFixture();
