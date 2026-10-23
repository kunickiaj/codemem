import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { queryRetrievalAttempts } from "@codemem/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocalCaptureFixture } from "../../core/src/memory-local-capture-test-fixtures.js";
import { createApp } from "./index.js";
import { fileContextRoutes } from "./routes/file-context.js";

const identity = vi.hoisted(() => ({
	device_id: "synthetic-device",
	actor_id_present: false,
	actor_id: null,
	config_path: null,
	runtime_root: null,
	workspace_id: null,
	home_dir: null,
	pack_compression: null,
	embedding_disabled: true,
	embedding_offline: true,
	embedding_model: "synthetic-model",
	embedding_revision: null,
}));
vi.mock("@codemem/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@codemem/core")>()),
	buildViewerIdentityTarget: () => identity,
}));
beforeEach(() => {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("CODEMEM_")) vi.stubEnv(key, undefined);
	}
	vi.stubEnv("HOME", "/nonexistent/codemem-transport-test-home");
});
const { fixture, remember } = useLocalCaptureFixture();
const attemptId = "018f2db4-f9d3-7a22-8d18-000000000001";
const payload = () => ({
	action: "lookup",
	attempt_id: attemptId,
	request_id: `claude-file-context/http/${attemptId}`,
	source_session_id: "synthetic-session",
	ledger_enabled: true,
	db_path: fixture.store.dbPath,
	identity_target: { ...identity },
	relative_path: "src/security.ts",
	project: "test-project",
	file_mtime_ms: 0,
});
function setup(options: { mounted?: boolean } = {}) {
	vi.spyOn(fixture.store, "hasCurrentIdentity").mockReturnValue(true);
	const factory = vi.fn(() => fixture.store);
	const query = vi.spyOn(fixture.store, "findByFile");
	let app = fileContextRoutes(factory);
	if (options.mounted) {
		writeFileSync(join(fixture.dir, "index.html"), "<!doctype html><title>synthetic</title>");
		vi.stubEnv("CODEMEM_VIEWER_STATIC_DIR", fixture.dir);
		app = createApp({
			storeFactory: factory,
			accountLink: {
				getListenerAddress: () => ({ host: "127.0.0.1", port: 7441 }),
			},
		});
	}
	return { app, factory, query };
}
function post(
	app: ReturnType<typeof fileContextRoutes>,
	body: unknown = payload(),
	headers: Record<string, string> = {},
) {
	return app.request("http://127.0.0.1:7441/api/file-context", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}
const attempts = () => queryRetrievalAttempts(fixture.store.db);

describe("HTTP file-context validation before store access", () => {
	it.each([
		["malformed JSON", "{"],
		["array", "[]"],
		["null", "null"],
		["unknown action", { action: "execute" }],
		["missing action", { action: undefined }],
		["missing path", { relative_path: undefined }],
		["absolute path", { relative_path: "/secret" }],
		["path traversal", { relative_path: "../secret" }],
		["Windows path", { relative_path: "C:\\secret" }],
		["missing session", { source_session_id: undefined }],
		["blank session", { source_session_id: " " }],
		["absolute session", { source_session_id: "/session" }],
		["missing database", { db_path: undefined }],
		["missing identity", { identity_target: undefined }],
		["client visibility", { visibility_context: { allow_all: true } }],
		["lookup with delivery fields", { delivery_status: "handed_off" }],
	])("rejects %s without querying or writing the ledger", async (_name, changes) => {
		// Arrange
		const { app, factory, query } = setup();
		const body = typeof changes === "string" ? changes : { ...payload(), ...changes };
		// Act
		const response = await post(app, body);
		// Assert
		expect(response.status).toBe(400);
		expect(factory).not.toHaveBeenCalled();
		expect(query).not.toHaveBeenCalled();
		expect(attempts()).toEqual([]);
	});
	it.each([false, true])(
		"enforces the 16 KiB body limit with declared Content-Length=%s",
		async (declared) => {
			// Arrange: valid trailing whitespace must count toward the body limit.
			const { app, factory } = setup();
			const raw = JSON.stringify(payload()) + " ".repeat(16_385);
			const headers = declared ? { "Content-Length": String(Buffer.byteLength(raw)) } : {};
			// Act
			const response = await post(app, raw, headers);
			// Assert
			expect(response.status).toBe(413);
			expect(factory).not.toHaveBeenCalled();
			expect(attempts()).toEqual([]);
		},
	);
	it("counts multibyte body content as bytes rather than UTF-16 characters", async () => {
		// Arrange
		const { app, factory } = setup();
		const raw = JSON.stringify({ ...payload(), extra: "é".repeat(8192) });
		// Act
		const response = await post(app, raw);
		// Assert
		expect(raw.length).toBeLessThan(16_384);
		expect(Buffer.byteLength(raw)).toBeGreaterThan(16_384);
		expect(response.status).toBe(413);
		expect(factory).not.toHaveBeenCalled();
	});
	it("accepts a valid request exactly at the byte limit", async () => {
		// Arrange
		const { app } = setup();
		const raw = JSON.stringify(payload());
		const body = raw + " ".repeat(16_384 - Buffer.byteLength(raw));
		// Act
		const response = await post(app, body);
		// Assert
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			result: { continue: true },
			delivery_pending: false,
		});
	});
});

describe("HTTP file-context target and middleware authorization", () => {
	it.each(["database", "identity", "current identity", "identity contract"])(
		"rejects mismatched %s before query or ledger",
		async (field) => {
			// Arrange
			const { app, query } = setup();
			const body = payload();
			if (field === "database") body.db_path = join(fixture.dir, "other.sqlite");
			if (field === "identity") body.identity_target.device_id = "other-device";
			if (field === "current identity")
				vi.mocked(fixture.store.hasCurrentIdentity).mockReturnValue(false);
			if (field === "identity contract") Object.assign(body.identity_target, { unsupported: true });
			// Act
			const response = await post(app, body);
			// Assert
			expect(response.status).toBe(409);
			expect(query).not.toHaveBeenCalled();
			expect(attempts()).toEqual([]);
		},
	);
	it.each([
		{ Origin: "https://foreign.example.test" },
		{ "Sec-Fetch-Site": "cross-site" },
		{ Referer: "https://foreign.example.test/page" },
	])("rejects browser context %j through the mounted origin middleware", async (headers) => {
		// Arrange
		const { app, factory } = setup({ mounted: true });
		// Act
		const response = await post(app, payload(), headers);
		// Assert
		expect(response.status).toBe(403);
		expect(factory).not.toHaveBeenCalled();
		expect(attempts()).toEqual([]);
	});
	it.each([{}, { Origin: "http://127.0.0.1:7441" }])(
		"accepts local/programmatic context %j without an account CSRF token",
		async (headers) => {
			// Arrange: the account middleware must not claim the file-context namespace.
			const { app, query } = setup({ mounted: true });
			remember("Mounted visible observation", { files_modified: ["src/security.ts"] });
			// Act
			const response = await post(app, payload(), headers);
			// Assert
			expect(response.status).toBe(200);
			expect(JSON.stringify(await response.json())).toContain("Mounted visible observation");
			expect(query).toHaveBeenCalledOnce();
			expect(attempts()[0]).toMatchObject({ deliveryStatus: "not_attempted", source: "claude" });
		},
	);
	it("retains account authorization on its own namespace", async () => {
		// Arrange
		const { app, factory } = setup({ mounted: true });
		// Act
		const response = await app.request("http://127.0.0.1:7441/api/account/unknown", {
			method: "POST",
			headers: { Host: "127.0.0.1:7441", Origin: "http://127.0.0.1:7441" },
		});
		// Assert
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "account_csrf_invalid" });
		expect(factory).not.toHaveBeenCalled();
	});
});

describe("HTTP file-context outcomes", () => {
	it("delivers and acknowledges only the matching selection", async () => {
		// Arrange
		const { app } = setup();
		remember("HTTP selected observation", { files_modified: ["src/security.ts"] });
		const { relative_path: _path, project: _project, file_mtime_ms: _mtime, ...base } = payload();
		const ack = { ...base, action: "delivery", delivery_status: "handed_off" };
		// Act
		const selected = await post(app);
		const before = attempts();
		const wrong = await post(app, { ...ack, source_session_id: "other-session" });
		const accepted = await post(app, ack);
		const replay = await post(app);
		// Assert
		expect(selected.status).toBe(200);
		expect(await selected.json()).toMatchObject({ delivery_pending: true });
		expect(before[0]?.deliveryStatus).toBe("not_attempted");
		expect(wrong.status).toBe(400);
		expect(accepted.status).toBe(200);
		expect(await replay.json()).toMatchObject({ delivery_pending: false });
		expect(attempts()).toHaveLength(1);
		expect(attempts()[0]?.deliveryStatus).toBe("handed_off");
	});
	it("returns a sanitized unavailable error when acquiring the store fails", async () => {
		// Arrange
		const app = fileContextRoutes(() => {
			throw new Error("synthetic private database detail");
		});
		// Act
		const response = await post(app);
		// Assert
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: { code: "file_context_failed", message: "file context unavailable" },
		});
		expect(attempts()).toEqual([]);
	});
});
