import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryStore } from "@codemem/core";
import { VERSION } from "@codemem/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../index.js";

type HealthPayload = {
	service: string;
	version: string;
	pid: number;
	uptime_ms: number;
	ready: boolean;
	database: { reachable: boolean };
};

function createStoreDouble(options?: { probeError?: Error; open?: boolean }) {
	const pragma = options?.probeError
		? vi.fn(() => {
				throw options.probeError;
			})
		: vi.fn(() => 17);
	const prepare = vi.fn(() => {
		throw new Error("health must not run a statement");
	});
	const stats = vi.fn(() => {
		throw new Error("health must not aggregate database stats");
	});
	const store = {
		actorId: "actor-local",
		db: { open: options?.open ?? true, pragma, prepare },
		stats,
	} as unknown as MemoryStore;
	return { store, pragma, prepare, stats };
}

function createMountedApp(storeFactory: () => MemoryStore) {
	const staticDir = mkdtempSync(join(tmpdir(), "codemem-health-route-test-"));
	writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>test</title>");
	const previousStaticDir = process.env.CODEMEM_VIEWER_STATIC_DIR;
	process.env.CODEMEM_VIEWER_STATIC_DIR = staticDir;

	try {
		const app = createApp({ storeFactory });
		return {
			app,
			cleanup: () => {
				if (previousStaticDir == null) delete process.env.CODEMEM_VIEWER_STATIC_DIR;
				else process.env.CODEMEM_VIEWER_STATIC_DIR = previousStaticDir;
				rmSync(staticDir, { recursive: true, force: true });
			},
		};
	} catch (error) {
		if (previousStaticDir == null) delete process.env.CODEMEM_VIEWER_STATIC_DIR;
		else process.env.CODEMEM_VIEWER_STATIC_DIR = previousStaticDir;
		rmSync(staticDir, { recursive: true, force: true });
		throw error;
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("GET /api/health", () => {
	it("returns the stable healthy viewer contract through createApp", async () => {
		// Arrange
		vi.spyOn(process, "uptime").mockReturnValue(42.125);
		const { store } = createStoreDouble();
		const { app, cleanup } = createMountedApp(() => store);

		try {
			// Act
			const response = await app.request("/api/health");
			const body = (await response.json()) as HealthPayload;

			// Assert
			expect(response.status).toBe(200);
			expect(body).toMatchObject({
				service: "codemem-viewer",
				version: VERSION,
				pid: process.pid,
				ready: true,
				database: { reachable: true },
			});
			expect(Object.keys(body).sort()).toEqual([
				"database",
				"pid",
				"ready",
				"service",
				"uptime_ms",
				"version",
			]);
			expect(body.uptime_ms).toBe(42_125);
			expect(Number.isInteger(body.uptime_ms)).toBe(true);
			expect(response.headers.get("cache-control")).toBe("no-store");
		} finally {
			cleanup();
		}
	});

	it("answers from memory without touching the database, stats aggregation or egress", async () => {
		// Arrange: every way of reaching the database throws, as it would on a locked one.
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
		const { store, pragma, prepare, stats } = createStoreDouble({
			probeError: new Error("database is locked"),
		});
		const { app, cleanup } = createMountedApp(() => store);

		try {
			// Act
			const response = await app.request("/api/health");
			const body = (await response.json()) as HealthPayload;

			// Assert
			expect(response.status).toBe(200);
			expect(body).toMatchObject({ ready: true, database: { reachable: true } });
			expect(pragma).not.toHaveBeenCalled();
			expect(prepare).not.toHaveBeenCalled();
			expect(stats).not.toHaveBeenCalled();
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	it("reports store construction failure as degraded HTTP 200 without error details", async () => {
		// Arrange
		const privateErrorDetail = "private database construction detail";
		const storeFactory = vi.fn((): MemoryStore => {
			throw new Error(privateErrorDetail);
		});
		const { app, cleanup } = createMountedApp(storeFactory);

		try {
			// Act
			const response = await app.request("/api/health");
			const body = (await response.json()) as HealthPayload;

			// Assert
			expect(response.status).toBe(200);
			expect(body).toMatchObject({
				service: "codemem-viewer",
				version: VERSION,
				pid: process.pid,
				ready: false,
				database: { reachable: false },
			});
			expect(JSON.stringify(body)).not.toContain(privateErrorDetail);
			expect(storeFactory).toHaveBeenCalledOnce();
		} finally {
			cleanup();
		}
	});

	it("reports a closed database connection as degraded HTTP 200", async () => {
		// Arrange
		const { store, pragma, stats } = createStoreDouble({ open: false });
		const { app, cleanup } = createMountedApp(() => store);

		try {
			// Act
			const response = await app.request("/api/health");
			const body = (await response.json()) as HealthPayload;

			// Assert
			expect(response.status).toBe(200);
			expect(body).toMatchObject({
				service: "codemem-viewer",
				version: VERSION,
				pid: process.pid,
				ready: false,
				database: { reachable: false },
			});
			expect(pragma).not.toHaveBeenCalled();
			expect(stats).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});
});

describe("GET /api/viewer-status", () => {
	it("returns only the current actor identity after a cheap database probe", async () => {
		const { store, pragma, stats } = createStoreDouble();
		const { app, cleanup } = createMountedApp(() => store);

		try {
			const response = await app.request("/api/viewer-status");

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ identity: { actor_id: "actor-local" } });
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(pragma).toHaveBeenCalledWith("schema_version", { simple: true });
			expect(stats).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});
});
