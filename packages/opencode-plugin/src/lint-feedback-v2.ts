import { createRequire } from "node:module";
import { Plugin } from "@opencode/plugin";
import type { Result as ToolResult } from "@opencode/plugin/promise/tool";
import {
	createWorktreeLintFeedbackController,
	type LintFeedbackController,
} from "./lint-feedback-core.js";

const biomeEntrypoint = createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");

function appendContent(content: ToolResult["content"], message: string) {
	if (typeof content === "string") return content ? `${content}\n\n${message}` : message;
	if (Array.isArray(content)) return [...content, { type: "text" as const, text: message }];
	return message;
}

interface V2Dependencies {
	createController(worktree: string): LintFeedbackController | undefined;
}

export function defineLintFeedbackV2Plugin(
	dependencies: V2Dependencies = {
		createController: (worktree) =>
			createWorktreeLintFeedbackController(worktree, {
				command: [process.execPath, biomeEntrypoint, "lint", "--reporter=json"],
				timeoutMs: 10_000,
			}),
	},
) {
	return Plugin.define({
		id: "codemem-lint-feedback",
		async setup(context) {
			const controller = dependencies.createController(context.location.project.directory);
			if (!controller) return;

			const registrations: Array<{ dispose(): Promise<void> }> = [];
			try {
				registrations.push(
					await context.tool.hook("execute.before", async (event) => {
						await controller.before({
							tool: event.tool,
							sessionID: event.sessionID,
							callID: event.id,
							args: event.input,
						});
					}),
				);
				registrations.push(
					await context.tool.hook("execute.after", async (event) => {
						const invocation = {
							tool: event.tool,
							sessionID: event.sessionID,
							callID: event.id,
							args: event.input,
						};
						if (event.status === "error") {
							controller.discard(invocation);
							return;
						}
						const message = await controller.after(invocation);
						if (!message) return;
						event.result = {
							...event.result,
							content: appendContent(event.result.content, message),
						};
					}),
				);
			} catch (error) {
				await Promise.allSettled(registrations.map((registration) => registration.dispose()));
				await controller.dispose();
				throw error;
			}

			return async () => {
				await Promise.allSettled(
					[...registrations].reverse().map((registration) => registration.dispose()),
				);
				await controller.dispose();
			};
		},
	});
}

export default defineLintFeedbackV2Plugin();
