/**
 * Wiring of the thin-host memory-tool route into the assembled viewer apps:
 * mounted only when `codemem serve` supplies a handler, behind the app-wide
 * origin guard, and never reachable on the peer-facing sync listener.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildViewerIdentityTarget, connect, initTestSchema, MemoryStore } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, createSyncApp } from "../index.js";
import type { MemoryToolCallFn } from "./memory-tool-call.js";

let tempDirectory: string;
let store: MemoryStore;
let previousStaticDir: string | undefined;

beforeEach(() => {
	tempDirectory = mkdtempSync(join(tmpdir(), "codemem-memory-tool-app-"));
	previousStaticDir = process.env.CODEMEM_VIEWER_STATIC_DIR;
	process.env.CODEMEM_VIEWER_STATIC_DIR = tempDirectory;
	writeFileSync(join(tempDirectory, "index.html"), "<!doctype html>");
	const databasePath = join(tempDirectory, "memory.sqlite");
	const database = connect(databasePath);
	initTestSchema(database);
	database.close();
	store = new MemoryStore(databasePath);
});

afterEach(() => {
	store.close();
	if (previousStaticDir == null) delete process.env.CODEMEM_VIEWER_STATIC_DIR;
	else process.env.CODEMEM_VIEWER_STATIC_DIR = previousStaticDir;
	rmSync(tempDirectory, { recursive: true, force: true });
});

function toolRequest(headers: Record<string, string> = {}): RequestInit {
	return {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify({
			arguments: {},
			caller: { directory: tempDirectory, env_project: null },
			db_path: store.dbPath,
			identity_target: buildViewerIdentityTarget(),
		}),
	};
}

describe("memory-tool route wiring", () => {
	it("is mounted and advertised only when a handler is supplied", async () => {
		const call = vi.fn<MemoryToolCallFn>(async () => ({ ok: true, result: {} }));
		const withHandler = createApp({ storeFactory: () => store, memoryToolCall: call });
		const without = createApp({ storeFactory: () => store });

		const mounted = await withHandler.request("/api/memory-tools/memory_learn", toolRequest());
		const unmounted = await without.request("/api/memory-tools/memory_learn", toolRequest());

		expect(mounted.status).toBe(200);
		expect(call).toHaveBeenCalledOnce();
		expect(unmounted.status).toBe(404);
	});

	it("rejects a cross-site browser POST before the handler runs", async () => {
		const call = vi.fn<MemoryToolCallFn>();
		const app = createApp({ storeFactory: () => store, memoryToolCall: call });

		const res = await app.request(
			"/api/memory-tools/memory_remember",
			toolRequest({ Origin: "https://attacker.example" }),
		);

		expect(res.status).toBe(403);
		expect(call).not.toHaveBeenCalled();
	});

	it("is not reachable on the peer-facing sync listener", async () => {
		const syncApp = createSyncApp({ storeFactory: () => store });

		const res = await syncApp.request("/api/memory-tools/memory_learn", toolRequest());

		expect(res.status).toBe(404);
	});
});
