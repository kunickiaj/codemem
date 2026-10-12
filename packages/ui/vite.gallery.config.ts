import { execFileSync } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";
import { uiAliases } from "./ui-aliases.ts";

const canonicalHtml = resolve(import.meta.dirname, "static/index.html");
const galleryGenerator = resolve(import.meta.dirname, "scripts/make-gallery-html.mjs");

function routeGallery(request: IncomingMessage, response: ServerResponse, next: () => void) {
	const url = request.url ?? "/";
	const path = url.split("?")[0];
	if (path === "/") {
		response.writeHead(302, { Location: `/gallery.html${url.slice(1)}` });
		response.end();
		return;
	}
	if (path === "/gallery.html") request.url = url.replace("/gallery.html", "/.tmp/gallery.html");
	next();
}

export default defineConfig({
	root: import.meta.dirname,
	appType: "mpa",
	publicDir: false,
	plugins: [
		preact(),
		{
			name: "gallery-home",
			configureServer(server) {
				server.middlewares.use(routeGallery);
				server.watcher.add(canonicalHtml);
			},
			async handleHotUpdate({ file, server, read }) {
				if (resolve(file) !== canonicalHtml) return;
				const html = await read();
				execFileSync(process.execPath, [galleryGenerator, "--stdin"], {
					cwd: import.meta.dirname,
					input: html,
				});
				server.ws.send({ type: "full-reload", path: "*" });
				return [];
			},
			configurePreviewServer(server) {
				server.middlewares.use(routeGallery);
			},
		},
	],
	optimizeDeps: { entries: [".tmp/gallery.html"] },
	resolve: { alias: uiAliases },
	server: { host: "127.0.0.1", port: 38922, strictPort: true },
	preview: { host: "127.0.0.1", port: 38922, strictPort: true },
	build: {
		// The canonical inline CSS includes browser-tolerated syntax (an extra
		// closing brace). Preserve it as shipped instead of reparsing/minifying it.
		cssMinify: false,
		outDir: resolve(import.meta.dirname, "../../.tmp/gallery-dist"),
		emptyOutDir: true,
		rollupOptions: { input: resolve(import.meta.dirname, ".tmp/gallery.html") },
	},
});
