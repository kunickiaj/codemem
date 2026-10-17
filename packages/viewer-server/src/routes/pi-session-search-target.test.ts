import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTestSchema, MemoryStore } from "@codemem/core";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createApp } from "../index.js";
import { currentIdentityTarget } from "./target-validation.js";

function createTestApp() {
	const tmpDir = mkdtempSync(join(tmpdir(), "codemem-pi-search-target-"));
	const dbPath = join(tmpDir, "test.sqlite");
	const rawDb = new Database(dbPath);
	initTestSchema(rawDb);
	rawDb
		.prepare(
			"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
		)
		.run("test-device-001", "test-public-key", "test-fingerprint", new Date().toISOString());
	rawDb.close();
	const store = new MemoryStore(dbPath);
	writeFileSync(join(tmpDir, "index.html"), "<!doctype html><title>test</title>");
	const previousStaticDir = process.env.CODEMEM_VIEWER_STATIC_DIR;
	process.env.CODEMEM_VIEWER_STATIC_DIR = tmpDir;
	const app = createApp({ storeFactory: () => store, sweeper: null });
	return {
		app,
		store,
		cleanup: () => {
			store.close();
			if (previousStaticDir == null) delete process.env.CODEMEM_VIEWER_STATIC_DIR;
			else process.env.CODEMEM_VIEWER_STATIC_DIR = previousStaticDir;
			rmSync(tmpDir, { recursive: true, force: true });
		},
	};
}

function headers() {
	return { Origin: "http://127.0.0.1:39888" };
}

describe("Pi session search rejects a mismatched db_path", () => {
	it("returns the viewer database conflict", async () => {
		const { app, store, cleanup } = createTestApp();
		try {
			const query = new URLSearchParams({ query: "target", db_path: `${store.dbPath}.other` });
			const res = await app.request(`/api/pi/sessions/search?${query}`, { headers: headers() });
			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({ error: { code: "viewer_db_mismatch" } });
		} finally {
			cleanup();
		}
	});
});

describe("Pi session search rejects a mismatched identity_target", () => {
	it("returns the viewer identity conflict", async () => {
		const { app, cleanup } = createTestApp();
		try {
			const query = new URLSearchParams({
				query: "target",
				identity_target: JSON.stringify({ ...currentIdentityTarget(), device_id: "other-device" }),
			});
			const res = await app.request(`/api/pi/sessions/search?${query}`, { headers: headers() });
			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({ error: { code: "viewer_identity_mismatch" } });
		} finally {
			cleanup();
		}
	});
});

describe("Pi session search accepts matching and omitted targets", () => {
	it("passes matching paired targets and untargeted requests", async () => {
		const { app, store, cleanup } = createTestApp();
		try {
			const matching = new URLSearchParams({
				query: "target",
				db_path: store.dbPath,
				identity_target: JSON.stringify(currentIdentityTarget()),
			});
			const paired = await app.request(`/api/pi/sessions/search?${matching}`, {
				headers: headers(),
			});
			const untagged = await app.request("/api/pi/sessions/search?query=target", {
				headers: headers(),
			});
			expect(paired.status).toBe(200);
			expect(untagged.status).toBe(200);
		} finally {
			cleanup();
		}
	});
});

describe("Pi session search preserves lenient handling of an unpaired target", () => {
	it("accepts either matching target when the other is omitted", async () => {
		const { app, store, cleanup } = createTestApp();
		try {
			const dbOnly = await app.request(
				`/api/pi/sessions/search?${new URLSearchParams({ query: "target", db_path: store.dbPath })}`,
				{ headers: headers() },
			);
			const identityOnly = await app.request(
				`/api/pi/sessions/search?${new URLSearchParams({
					query: "target",
					identity_target: JSON.stringify(currentIdentityTarget()),
				})}`,
				{ headers: headers() },
			);
			expect(dbOnly.status).toBe(200);
			expect(identityOnly.status).toBe(200);
		} finally {
			cleanup();
		}
	});
});
