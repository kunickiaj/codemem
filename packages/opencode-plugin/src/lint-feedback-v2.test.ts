import { describe, expect, it, vi } from "vitest";
import type { LintFeedbackController } from "./lint-feedback-core.js";
import { defineLintFeedbackV2Plugin } from "./lint-feedback-v2.js";

type Hook = (event: Record<string, unknown>) => Promise<void>;

function fixture(message = "[lint-feedback] New diagnostic") {
	const hooks = new Map<string, Hook>();
	const disposed: string[] = [];
	const controller: LintFeedbackController = {
		before: vi.fn(async () => undefined),
		after: vi.fn(async () => message),
		discard: vi.fn(),
		dispose: vi.fn(async () => undefined),
	};
	const context = {
		location: {
			directory: "/repo/worktree/packages/core",
			project: { directory: "/repo/worktree" },
		},
		tool: {
			hook: async (name: string, hook: Hook) => {
				hooks.set(name, hook);
				return { dispose: async () => void disposed.push(name) };
			},
		},
	};
	const createController = vi.fn(() => controller);
	const plugin = defineLintFeedbackV2Plugin({ createController });
	return { context, controller, createController, disposed, hooks, plugin };
}

describe("OpenCode 2 lint feedback", () => {
	it("anchors lint feedback at the worktree root for nested sessions", async () => {
		const test = fixture();
		await test.plugin.setup(test.context as never);

		expect(test.createController).toHaveBeenCalledWith("/repo/worktree");
	});

	it("passes full call identity and appends feedback to completed string results", async () => {
		const test = fixture();
		const cleanup = await test.plugin.setup(test.context as never);
		const event = {
			tool: "edit",
			sessionID: "session-a",
			agent: "build",
			messageID: "message-a",
			id: "call-a",
			input: { path: "packages/core/src/a.ts" },
			status: "completed" as const,
			result: { content: "Edit applied" },
		};

		await test.hooks.get("execute.before")?.(event);
		await test.hooks.get("execute.after")?.(event);

		expect(test.controller.before).toHaveBeenCalledWith({
			tool: "edit",
			sessionID: "session-a",
			callID: "call-a",
			args: event.input,
		});
		expect(event.result).toEqual({
			content: "Edit applied\n\n[lint-feedback] New diagnostic",
		});
		await cleanup?.();
		expect(test.disposed).toEqual(["execute.after", "execute.before"]);
		expect(test.controller.dispose).toHaveBeenCalledOnce();
	});

	it("preserves structured content and discards failed calls", async () => {
		const test = fixture();
		await test.plugin.setup(test.context as never);
		const completed = {
			tool: "patch",
			sessionID: "session-a",
			agent: "build",
			messageID: "message-a",
			id: "call-a",
			input: { patchText: "patch" },
			status: "completed" as const,
			result: { content: [{ type: "file" as const, uri: "file:///a", mime: "text/plain" }] },
		};
		const failed = {
			...completed,
			id: "call-b",
			status: "error" as const,
			error: { message: "failed" },
		};

		await test.hooks.get("execute.after")?.(completed);
		await test.hooks.get("execute.after")?.(failed);

		expect(completed.result.content).toEqual([
			{ type: "file", uri: "file:///a", mime: "text/plain" },
			{ type: "text", text: "[lint-feedback] New diagnostic" },
		]);
		expect(test.controller.discard).toHaveBeenCalledWith(
			expect.objectContaining({ callID: "call-b", sessionID: "session-a" }),
		);
	});
});
