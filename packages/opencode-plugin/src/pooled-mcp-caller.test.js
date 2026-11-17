import { describe, expect, it } from "vitest";
import {
	addCallerToPooledMcpTools,
	CALLER_ARGUMENT,
	createCallSequence,
} from "../.opencode/lib/pooled-mcp-caller.js";

function createEditor(tools) {
	const byId = new Map(tools.map((tool) => [tool.id, tool]));
	return {
		list: () => [...byId.values()],
		update: (id, update) => {
			const tool = byId.get(id);
			if (tool) update(tool);
		},
		get: (id) => byId.get(id),
	};
}

function pooledTool(id, received, namespace = "codemem") {
	return {
		id,
		options: { namespace },
		input: {
			type: "object",
			properties: { query: { type: "string" }, [CALLER_ARGUMENT]: { type: "object" } },
			required: ["query"],
		},
		execute: async (input, context) => {
			received.push({ input, context });
			return { ok: true };
		},
	};
}

const hostContext = (id = "call_1", sessionID = "ses_1") => ({ id, sessionID });

function setup(options = {}) {
	const received = [];
	const privateTool = {
		id: "other_search",
		input: { type: "object", properties: { query: { type: "string" } } },
		execute: async (input) => input,
	};
	const editor = createEditor([pooledTool("codemem_memory_search", received), privateTool]);
	const stamped = addCallerToPooledMcpTools(editor, {
		directory: "/work/alpha",
		nextSequence: createCallSequence("n1"),
		readEnvProject: () => undefined,
		...options,
	});
	return { editor, received, stamped, privateTool };
}

describe("addCallerToPooledMcpTools", () => {
	it("adds this instance's directory, session, and call identity to each call", async () => {
		const { editor, received } = setup();

		const result = await editor.get("codemem_memory_search").execute({ query: "x" }, hostContext());

		expect(result).toEqual({ ok: true });
		expect(received[0].input).toEqual({
			query: "x",
			[CALLER_ARGUMENT]: {
				directory: "/work/alpha",
				env_project: null,
				session_id: "ses_1",
				request_id: "call_1:n1:1",
			},
		});
	});

	it("hides the argument from the model-visible schema and keeps the other properties", () => {
		const { editor } = setup();

		expect(editor.get("codemem_memory_search").input).toEqual({
			type: "object",
			properties: { query: { type: "string" } },
			required: ["query"],
		});
	});

	it("replaces a caller value that arrived with the call", async () => {
		const { editor, received } = setup();
		const forged = { query: "x", [CALLER_ARGUMENT]: { directory: "/work/other" } };

		await editor.get("codemem_memory_search").execute(forged, hostContext());

		expect(received[0].input[CALLER_ARGUMENT].directory).toBe("/work/alpha");
	});
});

describe("pooled caller identity and scope", () => {
	it("gives calls that share one host call ID distinct request IDs", async () => {
		const { editor, received } = setup();
		const tool = editor.get("codemem_memory_search");

		await tool.execute({ query: "a" }, hostContext("call_block"));
		await tool.execute({ query: "a" }, hostContext("call_block"));

		expect(received.map((call) => call.input[CALLER_ARGUMENT].request_id)).toEqual([
			"call_block:n1:1",
			"call_block:n1:2",
		]);
	});

	it("reads the project override at call time and treats blank as none", async () => {
		let project = "  ";
		const { editor, received } = setup({ readEnvProject: () => project });
		const tool = editor.get("codemem_memory_search");

		await tool.execute({ query: "a" }, hostContext());
		project = " override ";
		await tool.execute({ query: "a" }, hostContext());

		expect(received.map((call) => call.input[CALLER_ARGUMENT].env_project)).toEqual([
			null,
			"override",
		]);
	});
});

describe("tools outside a shared server", () => {
	it("does not send the caller to another server's tool that declares the argument", async () => {
		const received = [];
		// A server whose name merely starts with "codemem" shares the ID prefix.
		const id = "codemem_external_memory_search";
		const editor = createEditor([pooledTool(id, received, "codemem_external")]);

		const stamped = addCallerToPooledMcpTools(editor, {
			directory: "/work/alpha",
			nextSequence: createCallSequence(),
		});
		await editor.get(id).execute({ query: "x" }, hostContext());

		expect(stamped).toEqual([]);
		expect(received[0].input).toEqual({ query: "x" });
		expect(editor.get(id).input.properties).toHaveProperty(CALLER_ARGUMENT);
	});

	it("gives each plugin instance its own request ID space", () => {
		expect(createCallSequence()()).not.toBe(createCallSequence()());
	});

	it("leaves tools that do not declare the argument untouched", async () => {
		const { editor, stamped, privateTool } = setup();
		const execute = privateTool.execute;

		expect(stamped).toEqual(["codemem_memory_search"]);
		expect(editor.get("other_search").execute).toBe(execute);
		expect(await execute({ query: "x" })).toEqual({ query: "x" });
	});

	it("does nothing on a host whose editor cannot list tools", () => {
		expect(addCallerToPooledMcpTools({ add() {} }, { directory: "/work/alpha" })).toEqual([]);
	});

	it("does not wrap a tool twice when the transform runs again", async () => {
		const { editor, received } = setup();

		const again = addCallerToPooledMcpTools(editor, {
			directory: "/work/alpha",
			nextSequence: createCallSequence(),
		});
		await editor.get("codemem_memory_search").execute({ query: "x" }, hostContext());

		expect(again).toEqual([]);
		expect(received).toHaveLength(1);
	});
});
