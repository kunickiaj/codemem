// @vitest-environment node
/// <reference types="node" />

import { execFileSync } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { Plugin, UserConfig } from "vite";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Config routing does not need to start Vite or run the external Preact plugin.
vi.mock("@preact/preset-vite", () => ({ default: () => [] }));
vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

// Vite configs use their own compiler settings; do not add them to the UI TS program.
const configPath = "../../vite.gallery.config.ts";
const { default: config }: { default: UserConfig } = await import(configPath);

type Middleware = (request: IncomingMessage, response: ServerResponse, next: () => void) => void;

function galleryPlugin(): Plugin {
	const plugin = config.plugins?.find(
		(entry) =>
			entry && typeof entry === "object" && "name" in entry && entry.name === "gallery-home",
	) as Plugin;
	return plugin;
}

function fakeServer() {
	const watchedFiles: string[] = [];
	return {
		middlewares: { use: vi.fn() },
		watcher: { add: vi.fn((file: string) => watchedFiles.push(file)) },
		ws: { send: vi.fn() },
		watchedFiles,
	};
}

function middleware(
	mode: "configureServer" | "configurePreviewServer",
	server = fakeServer(),
): Middleware {
	const plugin = galleryPlugin();
	const hook = plugin?.[mode];
	if (typeof hook !== "function") throw new Error(`Missing gallery ${mode} hook`);
	const { use } = server.middlewares;
	hook.call(plugin as never, server as never);
	expect(use).toHaveBeenCalledTimes(1);
	return use.mock.calls[0][0];
}

function hotUpdate(file: string, server = fakeServer()) {
	const plugin = galleryPlugin();
	const hook = plugin.handleHotUpdate;
	if (typeof hook !== "function") throw new Error("Missing gallery handleHotUpdate hook");
	return hook.call(plugin as never, { file, server } as never);
}

describe("isolated gallery Vite configuration", () => {
	beforeEach(() => {
		vi.mocked(execFileSync).mockReset();
	});

	it("watches the canonical HTML in dev without regenerating at startup", () => {
		// Arrange
		const server = fakeServer();
		const canonicalHtml = resolve(import.meta.dirname, "../../static/index.html");
		// Act
		middleware("configureServer", server);
		// Assert: inline CSS edits must reach the hot-update hook.
		expect(server.watchedFiles).toEqual([canonicalHtml]);
		expect(server.watcher.add).toHaveBeenCalledExactlyOnceWith(canonicalHtml);
		expect(execFileSync).not.toHaveBeenCalled();
		expect(server.ws.send).not.toHaveBeenCalled();
	});

	it("keeps preview static without watching or regenerating canonical HTML", () => {
		// Arrange
		const server = fakeServer();
		// Act
		middleware("configurePreviewServer", server);
		// Assert
		expect(server.watchedFiles).toEqual([]);
		expect(server.watcher.add).not.toHaveBeenCalled();
		expect(execFileSync).not.toHaveBeenCalled();
		expect(server.ws.send).not.toHaveBeenCalled();
	});

	it("regenerates canonical HTML before a full reload and stops native HMR", () => {
		// Arrange
		const server = fakeServer();
		const uiRoot = resolve(import.meta.dirname, "../..");
		const canonicalHtml = resolve(uiRoot, "static/index.html");
		// Act
		const result = hotUpdate(canonicalHtml, server);
		// Assert: reload only after the generated page contains the latest inline CSS.
		expect(execFileSync).toHaveBeenCalledExactlyOnceWith(
			process.execPath,
			[resolve(uiRoot, "scripts/make-gallery-html.mjs")],
			{ cwd: uiRoot },
		);
		expect(server.ws.send).toHaveBeenCalledExactlyOnceWith({ type: "full-reload", path: "*" });
		expect(vi.mocked(execFileSync).mock.invocationCallOrder[0]).toBeLessThan(
			server.ws.send.mock.invocationCallOrder[0],
		);
		expect(result).toEqual([]);
	});

	it("propagates generator failure without reloading a stale page", () => {
		// Arrange
		const server = fakeServer();
		const canonicalHtml = resolve(import.meta.dirname, "../../static/index.html");
		const failure = new Error("Invalid canonical gallery source");
		vi.mocked(execFileSync).mockImplementationOnce(() => {
			throw failure;
		});
		// Act
		const update = () => hotUpdate(canonicalHtml, server);
		// Assert
		expect(update).toThrow(failure);
		expect(execFileSync).toHaveBeenCalledTimes(1);
		expect(server.ws.send).not.toHaveBeenCalled();
	});

	it.each([
		".tmp/gallery.html",
		".tmp/index.html",
		"static/controls.css",
		"static/themes.css",
		"static/tokens.css",
		"src/gallery/gallery.tsx",
		"src/app.ts",
		"scripts/make-gallery-html.mjs",
		"static/index.html.bak",
		"other/static/index.html",
	])("leaves %s to native HMR without a regeneration or reload loop", (path) => {
		// Arrange
		const server = fakeServer();
		const file = resolve(import.meta.dirname, "../..", path);
		// Act
		const result = hotUpdate(file, server);
		// Assert: generated output and similarly named files are not canonical input.
		expect(result).toBeUndefined();
		expect(execFileSync).not.toHaveBeenCalled();
		expect(server.ws.send).not.toHaveBeenCalled();
	});

	it.each(["configureServer", "configurePreviewServer"] as const)(
		"%s redirects and rewrites only gallery URLs, preserving queries",
		(mode) => {
			// Arrange
			const route = middleware(mode);
			const cases = [
				{ url: "/", redirect: "/gallery.html", rewritten: "/" },
				{
					url: "/?theme=light&label=a%20b",
					redirect: "/gallery.html?theme=light&label=a%20b",
					rewritten: "/?theme=light&label=a%20b",
				},
				{ url: "/gallery.html", rewritten: "/.tmp/gallery.html" },
				{
					url: "/gallery.html?theme=light&label=a%20b",
					rewritten: "/.tmp/gallery.html?theme=light&label=a%20b",
				},
				{ url: "/api/stats?project=fixture", rewritten: "/api/stats?project=fixture" },
				{ url: "/assets/app.js", rewritten: "/assets/app.js" },
				{ url: "/index.html", rewritten: "/index.html" },
			];
			for (const fixture of cases) {
				const request = { url: fixture.url } as IncomingMessage;
				const writeHead = vi.fn();
				const end = vi.fn();
				const response = { writeHead, end } as unknown as ServerResponse;
				const next = vi.fn();
				// Act
				route(request, response, next);
				// Assert
				expect(request.url).toBe(fixture.rewritten);
				if (fixture.redirect) {
					expect(writeHead).toHaveBeenCalledExactlyOnceWith(302, { Location: fixture.redirect });
					expect(end).toHaveBeenCalledTimes(1);
					expect(next).not.toHaveBeenCalled();
				} else {
					expect(next).toHaveBeenCalledTimes(1);
					expect(writeHead).not.toHaveBeenCalled();
					expect(end).not.toHaveBeenCalled();
				}
			}
		},
	);

	it("keeps dev and preview loopback-only and builds ignored artifacts outside production staging", () => {
		// Arrange
		const uiRoot = resolve(import.meta.dirname, "../..");
		// Act
		const { server, preview, build, optimizeDeps } = config;
		// Assert
		expect(server).toEqual({ host: "127.0.0.1", port: 38922, strictPort: true });
		expect(preview).toEqual(server);
		expect(server?.proxy).toBeUndefined();
		expect(preview?.proxy).toBeUndefined();
		expect(config.publicDir).toBe(false);
		expect(config.appType).toBe("mpa");
		expect(optimizeDeps?.entries).toEqual([".tmp/gallery.html"]);
		expect(build?.rollupOptions?.input).toBe(resolve(uiRoot, ".tmp/gallery.html"));
		expect(build?.outDir).toBe(resolve(uiRoot, "../../.tmp/gallery-dist"));
		expect(build?.outDir).not.toBe(resolve(uiRoot, "../viewer-server/static"));
		expect(build?.cssMinify).toBe(false);
	});
});
