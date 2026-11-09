import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildViewerIdentityTarget, connect, initTestSchema, MemoryStore } from "@codemem/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rawEventsRoutes } from "../../../viewer-server/src/routes/raw-events.js";
import { retryNativeHookReceipt } from "./capture-native-retry.js";

const receipt = "rejected-400-invalid_payload-hook-1730000000-123-1234.json.retained";
const cases = [
	{
		provider: "claude",
		payload: {
			hook_event_name: "UserPromptSubmit",
			session_id: "fixture-session",
			prompt: "fixture prompt",
			timestamp: "2026-09-17T12:00:00.000Z",
		},
	},
	{
		provider: "codex",
		payload: {
			hook_event_name: "UserPromptSubmit",
			session_id: "fixture-session",
			prompt: "fixture prompt",
			timestamp: "2026-09-17T12:00:00.000Z",
		},
	},
	{
		provider: "pi",
		payload: {
			piEvent: "session_start",
			sessionId: "fixture-session",
			ts: "2026-09-17T12:00:00.000Z",
		},
	},
] as const;
let home: string;
let path: string;
let store: MemoryStore;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "codemem-native-route-"));
	const dir = join(home, "spool");
	await mkdir(dir, { mode: 0o755 });
	path = join(dir, receipt);
	vi.stubEnv("HOME", home);
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	vi.stubEnv("CODEMEM_EMBEDDING_OFFLINE", "1");
	vi.stubEnv("CODEMEM_VIEWER_HOST", "127.0.0.1");
	vi.stubEnv("CODEMEM_VIEWER_PORT", "38888");
	vi.stubEnv("CODEMEM_CLAUDE_HOOK_FLUSH", "1");
	for (const { provider } of cases)
		vi.stubEnv(`CODEMEM_${provider.toUpperCase()}_HOOK_SPOOL_DIR`, dir);
	const dbPath = join(home, "fixture.sqlite");
	const db = connect(dbPath);
	initTestSchema(db);
	db.close();
	store = new MemoryStore(dbPath);
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("unexpected network");
		}),
	);
});

afterEach(async () => {
	store?.close();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	await rm(home, { recursive: true, force: true });
});

function transport(app: ReturnType<typeof rawEventsRoutes>) {
	return vi.fn<typeof fetch>(async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/prompt-pack-profile")
			return Response.json({
				service: "codemem-viewer",
				protocol_version: 1,
				min_supported_protocol_version: 1,
				db_path: store.dbPath,
				identity_target: buildViewerIdentityTarget(),
			});
		return app.request(`${url.pathname}${url.search}`, init);
	});
}

it.each(cases)(
	"uses actual $provider inserted and duplicate replies to decide cleanup",
	async ({ provider, payload }) => {
		// Arrange: exercise production normalization and deduplication against a temporary store.
		const app = rawEventsRoutes(() => store, null);
		const fetchImpl = transport(app);
		const bytes = ` \n${JSON.stringify(payload)}\n`;
		await writeFile(path, bytes, { mode: 0o644 });
		const options = { provider, dbPath: store.dbPath, yes: true };
		// Act
		const first = await retryNativeHookReceipt(receipt, options, { fetchImpl });
		await writeFile(path, bytes, { mode: 0o644 });
		const duplicate = await retryNativeHookReceipt(receipt, options, { fetchImpl });
		// Assert
		expect(first).toMatchObject({
			ok: true,
			recovery: { acknowledgement: "ingested", cleanup: "removed" },
		});
		expect(duplicate).toMatchObject({ ok: false, recovery: { delivery: "unacknowledged" } });
		expect(await readFile(path, "utf8")).toBe(bytes);
		expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
	},
);

it.each(cases)("keeps actual unsupported $provider hook replies", async ({ provider }) => {
	// Arrange
	const app = rawEventsRoutes(() => store, null);
	const bytes = JSON.stringify({
		hook_event_name: "UnsupportedFixture",
		piEvent: "unsupported_fixture",
		session_id: "fixture-session",
		sessionId: "fixture-session",
	});
	await writeFile(path, bytes);
	// Act
	const result = await retryNativeHookReceipt(
		receipt,
		{ provider, dbPath: store.dbPath, yes: true },
		{ fetchImpl: transport(app) },
	);
	// Assert
	expect(result).toMatchObject({ ok: false, recovery: { delivery: "unacknowledged" } });
	expect(await readFile(path, "utf8")).toBe(bytes);
});

it("keeps Claude no-envelope boundary skips and accepts queued Pi flush-only replies", async () => {
	// Arrange
	const inbox = {
		enqueue: vi.fn().mockResolvedValue(undefined),
		start: vi.fn(),
		status: vi.fn(),
		stop: vi.fn(),
	};
	const app = rawEventsRoutes(() => store, null, inbox, {
		dbPath: store.dbPath,
		hasCurrentIdentity: () => true,
	});
	const fetchImpl = transport(app);
	const claude = JSON.stringify({ hook_event_name: "Stop", session_id: "fixture-session" });
	await writeFile(path, claude);
	// Act
	const skipped = await retryNativeHookReceipt(
		receipt,
		{ provider: "claude", dbPath: store.dbPath, yes: true },
		{ fetchImpl },
	);
	const kept = await readFile(path, "utf8");
	await writeFile(
		path,
		JSON.stringify({
			piEvent: "session_before_compact",
			sessionId: "fixture-session",
			timestamp: "2026-09-17T12:00:00.000Z",
		}),
	);
	const queued = await retryNativeHookReceipt(
		receipt,
		{ provider: "pi", dbPath: store.dbPath, yes: true },
		{ fetchImpl },
	);
	// Assert
	expect(skipped).toMatchObject({ ok: false, recovery: { delivery: "unacknowledged" } });
	expect(kept).toBe(claude);
	expect(queued).toMatchObject({
		ok: true,
		recovery: { acknowledgement: "queued", cleanup: "removed" },
	});
	expect(inbox.enqueue).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({ source: "pi", events: [] }),
		expect.objectContaining({ boundary: expect.objectContaining({ source: "pi" }) }),
	);
	await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
});
