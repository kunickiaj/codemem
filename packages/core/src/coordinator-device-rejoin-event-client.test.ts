import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { generateDeviceKey } from "../../cloudflare-coordinator-worker/test/device-rejoin-ceremony-fixture.js";
import { readCoordinatorDeviceRejoinEvents } from "./coordinator-device-rejoin-event-client.js";
import { connect } from "./db.js";
import { verifySignature } from "./sync-auth.js";

const directories: string[] = [];
afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	const keysDir = mkdtempSync(join(tmpdir(), "codemem-rejoin-notice-"));
	directories.push(keysDir);
	const { privateKey, publicKey, fingerprint } = generateDeviceKey();
	writeFileSync(join(keysDir, "device.key"), privateKey.export({ format: "pem", type: "pkcs8" }), {
		mode: 0o600,
	});
	const dbPath = join(keysDir, "device.sqlite");
	const db = connect(dbPath);
	db.prepare("INSERT INTO sync_device VALUES ('observer', ?, ?, 'then')").run(
		publicKey,
		fingerprint,
	);
	db.close();
	return {
		keysDir,
		dbPath,
		publicKey,
		groupId: "group-a",
		coordinatorUrl: "https://coordinator.example.test",
	};
}

const item = {
	event_id: "event-a",
	device_id: "another-device",
	group_ids: ["group-b", "group-c"],
	finalized_at_ms: 1234,
};

it("signs the exact current group and cursor without sending credentials or following redirects", async () => {
	const f = fixture();
	const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
		const url = new URL(String(input));
		const path = "/v1/auth/rejoin-events?group_id=group-a&after=prior";
		expect(`${url.origin}${url.pathname}${url.search}`).toBe(`${f.coordinatorUrl}${path}`);
		expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "manual" });
		const headers = new Headers(init?.headers);
		expect(headers.get("x-opencode-device")).toBe("observer");
		expect(headers.has("x-codemem-coordinator-admin")).toBe(false);
		expect(
			verifySignature({
				method: "GET",
				pathWithQuery: path,
				deviceId: "observer",
				publicKey: f.publicKey,
				bodyBytes: Buffer.alloc(0),
				timestamp: headers.get("x-opencode-timestamp") ?? "",
				nonce: headers.get("x-opencode-nonce") ?? "",
				signature: headers.get("x-opencode-signature") ?? "",
			}),
		).toBe(true);
		return Response.json({ items: [item], next_cursor: "event-a" });
	});
	expect(await readCoordinatorDeviceRejoinEvents({ ...f, after: "prior", fetch })).toEqual({
		kind: "page",
		nextCursor: "event-a",
		items: [
			{
				eventId: "event-a",
				deviceId: "another-device",
				groupIds: ["group-b", "group-c"],
				finalizedAtMs: 1234,
			},
		],
	});
	expect(fetch).toHaveBeenCalledOnce();
});

it.each([
	["a changed cursor on an empty page", { items: [], next_cursor: "other" }],
	["a repeated cursor", { items: [{ ...item, event_id: "prior" }], next_cursor: "prior" }],
	["an invalid event", { items: [{ ...item, finalized_at_ms: -1 }], next_cursor: "event-a" }],
	["more than 50 items", { items: Array(51).fill(item), next_cursor: "event-a" }],
])("does not advance the cursor for %s", async (_case, response) => {
	const f = fixture();
	expect(
		await readCoordinatorDeviceRejoinEvents({
			...f,
			after: "prior",
			fetch: async () => Response.json(response),
		}),
	).toEqual({ kind: "unavailable" });
});

it("distinguishes older coordinators, rejects redirects, and keeps a valid empty cursor", async () => {
	const f = fixture();
	const read = (fetch: typeof globalThis.fetch) =>
		readCoordinatorDeviceRejoinEvents({ ...f, after: "prior", fetch });
	expect(await read(async () => new Response(null, { status: 404 }))).toEqual({
		kind: "unsupported",
	});
	expect(await read(async () => Response.redirect("https://other.example.test"))).toEqual({
		kind: "unavailable",
	});
	expect(await read(async () => Response.json({ items: [], next_cursor: "prior" }))).toEqual({
		kind: "page",
		items: [],
		nextCursor: "prior",
	});
});

it("does not make a fetch when the coordinator URL or local signing key is unavailable", async () => {
	const f = fixture();
	const fetch = vi.fn<typeof globalThis.fetch>();
	expect(
		await readCoordinatorDeviceRejoinEvents({
			...f,
			coordinatorUrl: "https://coordinator.example.test/unexpected",
			fetch,
		}),
	).toEqual({ kind: "unavailable" });
	expect(
		await readCoordinatorDeviceRejoinEvents({
			...f,
			keysDir: join(f.keysDir, "missing"),
			fetch,
		}),
	).toEqual({ kind: "unavailable" });
	expect(fetch).not.toHaveBeenCalled();
});

it("does not send a request when the caller's captured signer is no longer current", async () => {
	const f = fixture();
	const fetch = vi.fn<typeof globalThis.fetch>();
	expect(
		await readCoordinatorDeviceRejoinEvents({
			...f,
			expectedSigner: { deviceId: "observer", fingerprint: "0".repeat(64) },
			fetch,
		}),
	).toEqual({ kind: "unavailable" });
	expect(fetch).not.toHaveBeenCalled();
});

it("refuses oversized replies and does not wait for a transport that ignores cancellation", async () => {
	const f = fixture();
	const oversized = vi.fn<typeof globalThis.fetch>(
		async () => new Response(" ".repeat(256 * 1024 + 1)),
	);
	expect(await readCoordinatorDeviceRejoinEvents({ ...f, fetch: oversized })).toEqual({
		kind: "unavailable",
	});
	const controller = new AbortController();
	const hanging = vi.fn<typeof globalThis.fetch>(() => {
		controller.abort();
		return new Promise<Response>(() => {});
	});
	expect(
		await readCoordinatorDeviceRejoinEvents({
			...f,
			signal: controller.signal,
			fetch: hanging,
		}),
	).toEqual({ kind: "unavailable" });
	expect(hanging).toHaveBeenCalledOnce();
});
