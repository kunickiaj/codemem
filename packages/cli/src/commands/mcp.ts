import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import { addDbOption, type DbOpts, resolveDbOpt } from "../shared-options.js";

const mcpCmd = new Command("mcp")
	.configureHelp(helpStyle)
	.description("Start an MCP server")
	.summary("Start the MCP stdio server");

addDbOption(mcpCmd);

interface McpHttpOpts extends DbOpts {
	host?: string;
	port?: string;
	unsafePublic?: boolean;
}

const mcpHttpCmd = new Command("http")
	.configureHelp(helpStyle)
	.description("Start the MCP Streamable HTTP server")
	.option("--host <host>", "HTTP host")
	.option("--port <port>", "HTTP port")
	.option("--unsafe-public", "allow non-loopback bind without auth");

addDbOption(mcpHttpCmd);

mcpHttpCmd.action(async () => {
	const opts = mcpHttpCmd.opts<McpHttpOpts>();
	try {
		const { startCodememMcpHttpServer } = await import("@codemem/mcp/http");
		const server = await startCodememMcpHttpServer({
			dbPath: resolveDbOpt(opts) ?? resolveDbOpt(mcpCmd.opts<DbOpts>()),
			host: opts.host,
			port: opts.port,
			allowUnsafePublic: opts.unsafePublic,
		});
		console.error(`codemem MCP HTTP server listening at ${server.url}`);

		const shutdown = async () => {
			try {
				await server.close();
			} catch {
				// Best effort — process is exiting.
			}
			process.exit(0);
		};

		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`Failed to start MCP HTTP server: ${message}`);
		process.exitCode = isMcpHttpUsageError(message) ? 2 : 1;
	}
});

mcpCmd.addCommand(mcpHttpCmd);

export const mcpCommand = mcpCmd.action(async (opts: DbOpts) => {
	const dbPath = resolveDbOpt(opts);
	if (dbPath) process.env.CODEMEM_DB = dbPath;
	try {
		await import("@codemem/mcp/stdio");
	} catch (err) {
		console.error(
			`Failed to start MCP server: ${err instanceof Error ? err.message : String(err)}`,
		);
		process.exitCode = 1;
	}
});

function isMcpHttpUsageError(message: string): boolean {
	return (
		message.includes("Invalid MCP HTTP host") ||
		message.includes("Invalid MCP HTTP port") ||
		message.includes("Refusing unsafe MCP HTTP host")
	);
}
