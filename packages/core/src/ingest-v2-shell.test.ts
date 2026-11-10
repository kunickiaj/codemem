import { describe, expect, it } from "vitest";
import { extractAdapterEvent, LOW_SIGNAL_TOOLS, projectAdapterToolEvent } from "./ingest-events.js";
import { prepareIngestInput } from "./ingest-pipeline.js";
import { normalizeEventsForSessionContext } from "./ingest-transcript.js";

function commandEvent(tool = "shell", input: unknown = { command: "printf 'synthetic result'" }) {
	return {
		type: "tool.execute.after",
		tool,
		args: input,
		result: "synthetic result",
		codemem_host_generation: "v2",
		_adapter: {
			schema_version: "1.0",
			source: "opencode",
			session_id: "synthetic-session",
			event_id: "synthetic-tool-result",
			event_type: "tool_result",
			ts: "2026-01-01T00:00:00.000Z",
			payload: {
				tool_name: tool,
				tool_input: input,
				tool_output: "synthetic result",
				status: "ok",
			},
		},
	};
}

function prepare(events: Record<string, unknown>[], observerMaxChars = 12000) {
	return prepareIngestInput({
		events,
		maxChars: 12000,
		observerMaxChars,
		priorDelegatedContext: { briefs: [], hasDelegatedTask: false },
		sessionContext: { source: "opencode", toolCount: events.length, flusher: "raw_events" },
		project: null,
		storeSummary: true,
		historicalRecovery: undefined,
	});
}

describe("OpenCode V2 shell command capture", () => {
	it("prepares three valid command envelopes exactly like bash without conversation input", () => {
		// Arrange: reproduce the command-only failure shape without retained session data.
		const events = ["alpha", "beta", "gamma"].map((word) =>
			commandEvent("shell", { command: `printf '${word}'` }),
		);
		const originals = structuredClone(events);
		const bashEvents = events.map((event) => ({
			...event,
			tool: "bash",
			_adapter: { ...event._adapter, payload: { ...event._adapter.payload, tool_name: "bash" } },
		}));

		// Act: validate, project, sanitize, budget and decide processability, without inference or storage.
		const adapters = events.map(extractAdapterEvent);
		const prepared = prepare(events);
		const equivalent = prepare(bashEvents);
		const contextEvents = normalizeEventsForSessionContext(events);

		// Assert: both consumers agree, and raw envelope identities remain unchanged.
		expect(adapters.every(Boolean)).toBe(true);
		expect(prepared).toEqual(equivalent);
		expect(prepared.shouldProcess).toBe(true);
		expect(prepared.toolEvents).toHaveLength(3);
		expect(prepared.transcript).toBe("");
		expect(contextEvents.map((event) => event.tool)).toEqual(["bash", "bash", "bash"]);
		expect(events).toEqual(originals);
	});

	it.each([
		["missing provenance", { codemem_host_generation: undefined }],
		["legacy provenance", { codemem_host_generation: "v1" }],
		["unknown provenance", { codemem_host_generation: "v3" }],
	])("keeps %s shell events excluded", (_label, overrides) => {
		// Arrange
		const event = { ...commandEvent(), ...overrides };
		// Act
		const prepared = prepare([event]);
		// Assert
		expect(prepared.toolEvents).toEqual([]);
		expect(prepared.shouldProcess).toBe(false);
		expect(LOW_SIGNAL_TOOLS.has("shell")).toBe(true);
	});

	it.each(["claude", "pi", "unknown"])("does not alias another adapter source: %s", (source) => {
		// Arrange
		const event = commandEvent();
		event._adapter.source = source;
		// Act
		const prepared = prepare([event]);
		// Assert
		expect(prepared.toolEvents).toEqual([]);
		expect(prepared.shouldProcess).toBe(false);
	});

	it.each(
		[
			undefined,
			null,
			[],
			"printf synthetic",
			{},
			{ command: "" },
			{ command: " \n " },
			{ command: 42 },
			{ cmd: "printf synthetic" },
		].map((input) => ({ input })),
	)("does not alias non-command input $input", ({ input }) => {
		// Arrange
		const event = commandEvent("shell", null);
		event.args = input;
		event._adapter.payload.tool_input = input;
		// Act
		const prepared = prepare([event]);
		// Assert
		expect(prepared.toolEvents).toEqual([]);
		expect(prepared.shouldProcess).toBe(false);
	});

	it.each(["mcp:shell", "custom.shell", "skill", "task", "cmd", "codemem_memory_search"])(
		"does not overwrite or enable excluded tool %s",
		(tool) => {
			// Arrange
			const event = commandEvent(tool);
			// Act
			const projected = projectAdapterToolEvent(event._adapter, event);
			const prepared = prepare([event]);
			// Assert
			expect(projected?.tool).toBe(tool);
			expect(prepared.toolEvents).toEqual([]);
			expect(prepared.shouldProcess).toBe(false);
		},
	);

	it("keeps supported namespaced tools processable", () => {
		// Arrange
		const event = commandEvent("mcp:read", { file_path: "synthetic.txt" });
		// Act
		const prepared = prepare([event]);
		// Assert
		expect(prepared.toolEvents[0]?.toolName).toBe("read");
		expect(prepared.shouldProcess).toBe(true);
	});

	it.each(["missing", "invalid schema", "invalid timestamp", "tool_call"])(
		"does not alias shell through %s envelopes",
		(kind) => {
			// Arrange
			const event: Record<string, unknown> = commandEvent();
			const adapter = event._adapter as Record<string, unknown>;
			if (kind === "missing") delete event._adapter;
			if (kind === "invalid schema") adapter.schema_version = "2.0";
			if (kind === "invalid timestamp") adapter.ts = "invalid";
			if (kind === "tool_call") adapter.event_type = "tool_call";
			// Act
			const prepared = prepare([event]);
			// Assert
			expect(prepared.toolEvents).toEqual([]);
			expect(prepared.shouldProcess).toBe(false);
		},
	);
});

describe("OpenCode V2 shell sanitization and budgets", () => {
	it("prepares envelope-only command failures with sanitized tool_error and no output", () => {
		// Arrange: tool_error takes precedence over the fallback error field.
		const event = commandEvent();
		const payload = {
			...event._adapter.payload,
			status: "error",
			tool_output: null,
			tool_error: "command failed<private>hidden-error</private>",
			error: "stale fallback error",
		};
		// Act
		const prepared = prepare([
			{ codemem_host_generation: "v2", _adapter: { ...event._adapter, payload } },
		]);
		// Assert
		expect(prepared.shouldProcess).toBe(true);
		expect(prepared.toolEvents[0]).toMatchObject({
			toolName: "bash",
			toolOutput: null,
			toolError: "command failed",
		});
	});

	it("sanitizes command input, output and failure details before preparation", () => {
		// Arrange: error results must survive while private strings and sensitive fields do not.
		const event = commandEvent("shell", {
			command: "printf '<private>hidden-input</private>visible-input'",
			api_key: "synthetic-key",
		});
		const payload = {
			...event._adapter.payload,
			status: "error",
			tool_output: "visible-output<private>hidden-output</private>",
			error: { message: "visible-error<private>hidden-error</private>", token: "synthetic-token" },
		};
		// Act
		const prepared = prepare([{ ...event, _adapter: { ...event._adapter, payload } }]);
		// Assert
		expect(prepared.shouldProcess).toBe(true);
		expect(prepared.toolEvents[0]).toMatchObject({
			toolName: "bash",
			toolInput: { command: "printf 'visible-input'", api_key: "[REDACTED]" },
			toolOutput: "visible-output",
			toolError: { message: "visible-error", token: "[REDACTED]" },
		});
		expect(JSON.stringify(prepared.observerContext)).not.toMatch(
			/hidden-|synthetic-key|synthetic-token/,
		);
	});

	it("applies bash line compaction to the actual adapter result rather than stale flat output", () => {
		// Arrange
		const event = commandEvent();
		event.result = "stale flat result";
		event._adapter.payload.tool_output = Array.from({ length: 100 }, (_, i) => `line ${i}`).join(
			"\n",
		);
		// Act
		const prepared = prepare([event]);
		// Assert
		expect(prepared.toolEvents[0]?.toolOutput).toBe(
			`${Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n")}\n... (+20 more lines)`,
		);
	});

	it("applies bash character compaction and event budgets", () => {
		// Arrange
		const events = Array.from({ length: 40 }, (_, i) => {
			const event = commandEvent("shell", { command: `printf 'result ${i}'` });
			event._adapter.payload.tool_output = "x".repeat(5000);
			return event;
		});
		// Act
		const prepared = prepare(events);
		const smaller = prepare(events, 7000);
		// Assert
		expect(prepared.toolEvents.length).toBeGreaterThan(0);
		expect(prepared.toolEvents.length).toBeLessThanOrEqual(30);
		expect(
			prepared.toolEvents.reduce((size, event) => size + JSON.stringify(event).length, 0),
		).toBeLessThanOrEqual(7000);
		expect(prepared.toolEvents[0]?.toolOutput).toBe(`${"x".repeat(2000)}\n... (truncated)`);
		expect(smaller.toolEvents).toHaveLength(1);
	});
});

describe("OpenCode V2 command identity and event limits", () => {
	it.each(["custom.shellish", "mcp:shell_exec", "Shell"])(
		"preserves other tool identities: %s",
		(tool) => {
			// Arrange
			const event = commandEvent(tool);
			// Act
			const projected = projectAdapterToolEvent(event._adapter, event);
			// Assert: alias recognition does not rewrite arbitrary tools.
			expect(projected?.tool).toBe(tool);
		},
	);

	it("caps short command events at thirty and deduplicates repeated git status", () => {
		// Arrange
		const events = Array.from({ length: 40 }, (_, i) =>
			commandEvent("shell", { command: `printf '${i}'` }),
		);
		const firstStatus = commandEvent("shell", { command: "git status" });
		const lastStatus = commandEvent("shell", { command: "git status" });
		lastStatus._adapter.payload.tool_output = "synthetic changed status";
		// Act
		const capped = prepare(events, 13000);
		const deduplicated = prepare([firstStatus, lastStatus]);
		// Assert
		expect(capped.toolEvents).toHaveLength(30);
		expect(deduplicated.toolEvents).toHaveLength(1);
		expect(deduplicated.toolEvents[0]?.toolOutput).toBe("synthetic changed status");
	});
});
