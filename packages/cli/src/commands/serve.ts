import * as p from "@clack/prompts";
import { ObserverClient, RawEventSweeper, resolveDbPath } from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";

export const serveCommand = new Command("serve")
	.configureHelp(helpStyle)
	.description("Start the viewer server")
	.option("--db <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
	.option("--host <host>", "bind host", "127.0.0.1")
	.option("--port <port>", "bind port", "38888")
	.action(async (opts: { db?: string; host: string; port: string }) => {
		// Dynamic import to avoid loading hono/server deps for non-serve commands
		const { createApp, closeStore, getStore } = await import("@codemem/viewer-server");
		const { serve } = await import("@hono/node-server");

		const dbPath = resolveDbPath(opts.db);
		process.env.CODEMEM_DB = dbPath;

		const port = Number.parseInt(opts.port, 10);
		// Start the raw event sweeper — shares the same store as the viewer
		const observer = new ObserverClient();
		const sweeper = new RawEventSweeper(getStore(), { observer });
		sweeper.start();

		const app = createApp({ storeFactory: getStore, sweeper });

		const server = serve({ fetch: app.fetch, hostname: opts.host, port }, (info) => {
			p.intro("codemem viewer");
			p.log.success(`Listening on http://${info.address}:${info.port}`);
			p.log.info(`Database: ${dbPath}`);
			p.log.step("Raw event sweeper started");
		});

		const shutdown = async () => {
			p.outro("shutting down");
			// Stop sweeper first and wait for any in-flight tick to drain.
			await sweeper.stop();
			// Close HTTP server, wait for in-flight requests to drain
			server.close(() => {
				closeStore();
				process.exit(0);
			});
			// Force exit after 5s if graceful shutdown stalls
			setTimeout(() => {
				closeStore();
				process.exit(1);
			}, 5000).unref();
		};
		process.on("SIGINT", () => {
			void shutdown();
		});
		process.on("SIGTERM", () => {
			void shutdown();
		});
	});
