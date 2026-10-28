import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import codememPiExtension, { __setTestExecImpl, defaultPiExtensionConfig } from "./index.js";

/** Literal roster: the native default must stay exactly these 15 direct tools. */
const NATIVE_TOOL_NAMES = [
	"memory_distill_candidates",
	"memory_expand",
	"memory_explain",
	"memory_forget",
	"memory_get",
	"memory_get_observations",
	"memory_learn",
	"memory_pack",
	"memory_recent",
	"memory_remember",
	"memory_schema",
	"memory_search",
	"memory_search_index",
	"memory_session_search",
	"memory_timeline",
];

type MockTool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };

function createMockPi() {
	const handlers = new Map<string, unknown>();
	const tools: MockTool[] = [];
	const pi = {
		on(event: string, handler: unknown) {
			handlers.set(event, handler);
		},
		registerTool(def: MockTool) {
			tools.push(def);
		},
		appendEntry() {},
	};
	return { pi, handlers, tools };
}

describe("Pi host compatibility", () => {
	const prevEnv = { ...process.env };

	beforeEach(() => {
		for (const key of Object.keys(process.env))
			if (key.startsWith("CODEMEM_")) delete process.env[key];
		process.env.CODEMEM_VIEWER_AUTO = "0";
	});

	afterEach(() => {
		__setTestExecImpl(null);
		for (const key of Object.keys(process.env)) if (!(key in prevEnv)) delete process.env[key];
		for (const [key, value] of Object.entries(prevEnv))
			if (value !== undefined) process.env[key] = value;
	});

	it("declares the Pi 1.1.0 host floor and the verified 1.4.0 dev SDK", () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		expect(pkg.peerDependencies["@earendil-works/pi-coding-agent"]).toBe(">=1.1.0 <2");
		expect(pkg.devDependencies["@earendil-works/pi-coding-agent"]).toBe("1.4.0");
	});

	it("registers the exact 15-tool native default", () => {
		expect(defaultPiExtensionConfig().toolsMode).toBe("native");
		const { pi, tools } = createMockPi();
		codememPiExtension(pi as never);
		expect(tools.map((tool) => tool.name).toSorted()).toEqual(NATIVE_TOOL_NAMES);
	});

	it("keeps mcp-adapter mode free of native tools", () => {
		process.env.CODEMEM_PI_TOOLS_MODE = "mcp-adapter";
		const { pi, handlers, tools } = createMockPi();
		codememPiExtension(pi as never);
		expect(tools).toEqual([]);
		expect(handlers.has("session_start")).toBe(true);
	});

	it("forwards the third execute argument (abort signal) to the CLI path", async () => {
		process.env.CODEMEM_VIEWER = "0";
		const execCalls: Array<{ args: string[]; signal?: AbortSignal }> = [];
		__setTestExecImpl(async (args, opts) => {
			execCalls.push({ args, signal: opts?.signal });
			return { stdout: JSON.stringify({ pack_text: "ok" }), stderr: "" };
		});
		const { pi, tools } = createMockPi();
		codememPiExtension(pi as never);
		const controller = new AbortController();
		const onUpdate = vi.fn();
		const pack = tools.find((tool) => tool.name === "memory_pack");
		if (!pack) throw new Error("memory_pack did not register");
		await pack.execute(
			"tool-call-id",
			{ context: "continue work" },
			controller.signal,
			onUpdate,
			{},
		);
		expect(execCalls[0]?.args).toContain("continue work");
		expect(execCalls[0]?.signal).toBe(controller.signal);
		expect(onUpdate).not.toHaveBeenCalled();
	});
});
