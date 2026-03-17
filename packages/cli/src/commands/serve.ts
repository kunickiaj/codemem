import { resolveDbPath } from "@codemem/core";
import { Command } from "commander";

export const serveCommand = new Command("serve")
	.description("Start the viewer server")
	.option("--db <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
	.option("--host <host>", "bind host", "127.0.0.1")
	.option("--port <port>", "bind port", "38888")
	.action(async (opts: { db?: string; host: string; port: string }) => {
		// Dynamic import to avoid loading hono/server deps for non-serve commands
		const { createApp, closeStore } = await import("@codemem/viewer-server");
		const { serve } = await import("@hono/node-server");

		const dbPath = resolveDbPath(opts.db);
		process.env.CODEMEM_DB = dbPath;

		const port = Number.parseInt(opts.port, 10);
		const app = createApp();

		const server = serve({ fetch: app.fetch, hostname: opts.host, port }, (info) => {
			console.log(`codemem viewer listening on http://${info.address}:${info.port}`);
			console.log(`  database: ${dbPath}`);
		});

		const shutdown = () => {
			console.log("\nShutting down...");
			closeStore();
			server.close();
			process.exit(0);
		};
		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
	});
