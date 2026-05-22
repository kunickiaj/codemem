import { startCodememMcpHttpServer } from "@codemem/mcp/http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mcpCommand } from "./mcp.js";

const stdioImportMock = vi.hoisted(() => vi.fn());

vi.mock("@codemem/mcp/stdio", () => {
	stdioImportMock();
	return {};
});
vi.mock("@codemem/mcp/http", () => ({
	startCodememMcpHttpServer: vi.fn(async () => ({
		url: "http://127.0.0.1:38889/mcp",
		close: vi.fn(async () => {}),
	})),
}));

const startHttpMock = vi.mocked(startCodememMcpHttpServer);

describe("mcp command", () => {
	afterEach(() => {
		startHttpMock.mockClear();
		stdioImportMock.mockClear();
		process.exitCode = undefined;
	});

	it("keeps stdio mode as the default command", () => {
		expect(mcpCommand.name()).toBe("mcp");
		expect(mcpCommand.summary()).toBe("Start the MCP stdio server");
	});

	it("exposes HTTP mode with host, port, and database options", () => {
		const httpCommand = mcpCommand.commands.find((command) => command.name() === "http");

		expect(httpCommand).toBeDefined();
		expect(httpCommand?.description()).toBe("Start the MCP Streamable HTTP server");
		expect(httpCommand?.options.map((option) => option.long).toSorted()).toEqual([
			"--db",
			"--db-path",
			"--host",
			"--port",
			"--public-url",
			"--unsafe-public",
		]);
	});

	it("forwards HTTP mode options to the MCP HTTP starter", async () => {
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await mcpCommand.parseAsync(
				[
					"http",
					"--db-path",
					"/tmp/codemem-test.sqlite",
					"--host",
					"localhost",
					"--port",
					"39999",
					"--public-url",
					"https://codemem.example.test/mcp",
					"--unsafe-public",
				],
				{ from: "user" },
			);

			expect(startHttpMock).toHaveBeenCalledWith({
				allowUnsafePublic: true,
				dbPath: "/tmp/codemem-test.sqlite",
				host: "localhost",
				port: "39999",
				publicUrl: "https://codemem.example.test/mcp",
			});
		} finally {
			stderr.mockRestore();
		}
	});

	it("forwards parent-level database options to HTTP mode", async () => {
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await mcpCommand.parseAsync(["--db-path", "/tmp/parent.sqlite", "http"], { from: "user" });

			expect(startHttpMock).toHaveBeenCalledWith({
				allowUnsafePublic: undefined,
				dbPath: "/tmp/parent.sqlite",
				host: undefined,
				port: undefined,
				publicUrl: undefined,
			});
		} finally {
			stderr.mockRestore();
		}
	});

	it("lets the MCP HTTP starter resolve env/default host and port", async () => {
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await mcpCommand.parseAsync(["http"], { from: "user" });

			expect(startHttpMock).toHaveBeenCalledWith({
				allowUnsafePublic: undefined,
				dbPath: undefined,
				host: undefined,
				port: undefined,
				publicUrl: undefined,
			});
		} finally {
			stderr.mockRestore();
		}
	});

	it("classifies MCP HTTP validation failures as usage errors", async () => {
		startHttpMock.mockRejectedValueOnce(new Error("Invalid MCP HTTP port: nope"));
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await mcpCommand.parseAsync(["http", "--port", "nope"], { from: "user" });

			expect(process.exitCode).toBe(2);
		} finally {
			stderr.mockRestore();
		}
	});

	it("runs stdio mode by default", async () => {
		await mcpCommand.parseAsync([], { from: "user" });

		expect(stdioImportMock).toHaveBeenCalledTimes(1);
		expect(startHttpMock).not.toHaveBeenCalled();
	});
});
