import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildSyncRejoinCommand } from "../../cli/src/commands/sync-rejoin.js";
import {
	config,
	confirmInBrowser,
	createRejoinOidc,
	deviceId,
	generateDeviceKey,
	groupId,
	now,
	origin,
	seedRemovedDevice,
} from "../../cloudflare-coordinator-worker/test/device-rejoin-ceremony-fixture.js";
import { createCoordinatorApp } from "./coordinator-api.js";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import {
	captureCoordinatorBrowserAuthOptions,
	createCoordinatorBrowserAuth,
} from "./coordinator-browser-auth-app.js";
import { importBrowserCsrfKey } from "./coordinator-browser-csrf.js";
import { createDeviceRejoinRequests } from "./coordinator-device-rejoin-client-requests.js";
import { readCoordinatorRemovalState } from "./coordinator-removal-notice.js";
import { removeCoordinatorRevokedPeers } from "./coordinator-runtime.js";
import { readCoordinatorSyncConfig } from "./coordinator-sync-config.js";
import { connect } from "./db.js";
import { createInMemoryRequestRateLimiter } from "./request-rate-limit.js";
import { SIGNATURE_VERSION, verifySignature } from "./sync-auth.js";

// The CLI imports the package entry point. Use source here rather than a package build.
vi.mock("@codemem/core", () => import("./index.js"));

const syncProfile = { sync_coordinator_url: origin, sync_coordinator_groups: [groupId] };
const removalScope = { coordinatorId: origin, groupIds: [groupId] };
const fixtureAdmin = "ceremony-fixture-admin";
const tty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
const originalExitCode = process.exitCode;
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
	if (tty) Object.defineProperty(process.stderr, "isTTY", tty);
	else Reflect.deleteProperty(process.stderr, "isTTY");
	process.exitCode = originalExitCode;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

function localDevice() {
	const dir = mkdtempSync(join(tmpdir(), "codemem-rejoin-route-cli-"));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	const { privateKey, publicKey, fingerprint } = generateDeviceKey();
	writeFileSync(join(dir, "device.key"), privateKey.export({ type: "pkcs8", format: "pem" }), {
		mode: 0o600,
	});
	const dbPath = join(dir, "device.sqlite");
	const profile = join(dir, "config.json");
	writeFileSync(profile, JSON.stringify(syncProfile));
	const db = connect(dbPath);
	db.prepare(
		`INSERT INTO sync_device (device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, 'then')`,
	).run(deviceId, publicKey, fingerprint);
	db.close();
	return { dbPath, profile, keysDir: dir, publicKey, fingerprint };
}

async function coordinator(local: ReturnType<typeof localDevice>) {
	const { db, store } = setupStore("SQLite", { authClock: () => now });
	const close = store.close.bind(store);
	cleanup.push(close);
	vi.spyOn(store, "close").mockResolvedValue(undefined);
	await seedRemovedDevice(
		{
			first: async <T>({ sql, values }: AuthLinkStatement) =>
				(db.prepare(sql).get(...values) as T | undefined) ?? null,
			run: async (sql, ...values) => db.prepare(sql).run(...values),
		},
		local,
	);
	const oidc = createRejoinOidc();
	const created = await createCoordinatorBrowserAuth(
		captureCoordinatorBrowserAuthOptions({
			config,
			csrfKey: await importBrowserCsrfKey(new Uint8Array(32).fill(7)),
			oidcOptions: { fetch: oidc.fetch },
		}),
		store,
		createInMemoryRequestRateLimiter({ now: () => now }),
	);
	if (!created.ok) throw new Error(created.error);
	const storeFactory = () => store;
	const clientKey = () => "synthetic-client";
	const app = createCoordinatorApp({
		storeFactory,
		runtime: { adminSecret: () => fixtureAdmin, now: () => new Date(now).toISOString() },
		deviceRevocation: { coordinatorId: config.coordinatorId },
		requestVerifier: (input) =>
			verifySignature({ ...input, bodyBytes: Buffer.from(input.bodyBytes) }),
		browserAuth: {
			kind: "ready",
			auth: created.auth,
			storeFactory,
			clientKey,
			clientAddress: clientKey,
		},
	});
	return { db, app, oidc };
}

type Coordinator = Awaited<ReturnType<typeof coordinator>>;

async function completeInBrowser(f: Coordinator, link: string) {
	const href = await confirmInBrowser({ request: f.app.request.bind(f.app), oidc: f.oidc }, link);
	await new Promise<void>((resolve, reject) => {
		get(href, (response) => {
			response.resume();
			response.on("end", () =>
				response.statusCode === 200 ? resolve() : reject(new Error("Loopback refused")),
			);
		}).on("error", reject);
	});
}

function ordinarySyncCheck(local: ReturnType<typeof localDevice>) {
	const db = connect(local.dbPath);
	return removeCoordinatorRevokedPeers(
		{ db, dbPath: local.dbPath },
		readCoordinatorSyncConfig(syncProfile),
		{
			keysDir: local.keysDir,
		},
	).finally(() => db.close());
}

function localRemovalState(local: ReturnType<typeof localDevice>) {
	const db = connect(local.dbPath);
	try {
		return readCoordinatorRemovalState(db, removalScope);
	} finally {
		db.close();
	}
}

async function removeAndBlock(f: Coordinator) {
	async function admin<T>(path: string, body: object): Promise<T> {
		const response = await f.app.request(`${origin}/v1/admin/devices/${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-codemem-coordinator-admin": fixtureAdmin,
			},
			body: JSON.stringify(body),
		});
		expect(response.status).toBe(200);
		return response.json<T>();
	}
	const remove = { device_ids: [deviceId] };
	const preview = await admin<{ expected_digest: string }>("removal-preview", remove);
	const receipt = await admin<{ state: string; removal_id: string }>("removal", {
		...remove,
		expected_digest: preview.expected_digest,
	});
	expect(receipt.state).toBe("removed");
	const block = { device_id: deviceId, group_id: groupId, required_removal_id: receipt.removal_id };
	const pinned = await admin<{ expected_digest: string }>("revoke-preview", block);
	expect(
		await admin("revoke", { ...block, expected_digest: pinned.expected_digest }),
	).toMatchObject({
		state: "revoked",
		revocations: [{ subject_kind: "device_id" }, { subject_kind: "ed25519_key" }],
	});
}

function coordinatorState(f: Coordinator) {
	return [
		"enrolled_devices",
		"coordinator_device_ownership_bindings",
		"coordinator_device_removals",
		"coordinator_device_revocations",
		"coordinator_device_rejoin_attempts",
		"coordinator_device_rejoin_audit_log",
		"request_nonces",
	].map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

function runCli(local: ReturnType<typeof localDevice>) {
	return buildSyncRejoinCommand().parseAsync(
		["--config", local.profile, "--db-path", local.dbPath],
		{ from: "user" },
	);
}

it("recovers a lost start from the mounted route with the original expiry and a new signature", async () => {
	const clock = vi.spyOn(Date, "now").mockReturnValue(now);
	const local = localDevice();
	const f = await coordinator(local);
	let original: unknown;
	const transport = vi.fn<typeof fetch>(async (url, init) => {
		const response = await f.app.request(url, init);
		expect(response.status).toBe(200);
		if (transport.mock.calls.length === 1) {
			original = await response.json();
			throw new Error("Synthetic loss after start committed");
		}
		return response;
	});
	const client = await createDeviceRejoinRequests({
		...local,
		coordinatorUrl: origin,
		fetch: transport,
	});
	if (!client) throw new Error("Missing local signer");
	const start = {
		attemptId: "lost-reply",
		browserStartHash: "a".repeat(64),
		loopbackRedirect: "http://127.0.0.1:1234/codemem/auth/complete",
	};
	expect(await client.start(start)).toEqual({ kind: "unknown" });
	expect(transport).toHaveBeenCalledOnce();
	const before = f.db.prepare("SELECT * FROM coordinator_device_rejoin_attempts").all();
	clock.mockReturnValue(now + 1000);
	expect(await client.start(start)).toMatchObject({
		kind: "started",
		pins: { attemptId: "lost-reply", expiresAtMs: now + 600_000 },
	});
	expect(original).toMatchObject({ attempt_id: start.attemptId, expires_at_ms: now + 600_000 });
	const [first, second] = transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
	expect(second.timestamp_ms).toBe(first.timestamp_ms + 1000);
	expect(second.signature).not.toBe(first.signature);
	expect(f.db.prepare("SELECT * FROM coordinator_device_rejoin_attempts").all()).toEqual(before);
});

it("rejoins after a lost finalize reply, clears the notice on signed sync, and cannot rejoin after Block", async () => {
	vi.spyOn(Date, "now").mockReturnValue(now);
	process.exitCode = undefined;
	Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
	const local = localDevice();
	vi.stubEnv("CODEMEM_KEYS_DIR", local.keysDir);
	vi.stubEnv("CODEMEM_DEVICE_ID", "");
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_URL", undefined);
	const f = await coordinator(local);
	const calls: string[] = [];
	const syncChecks: { signature: string | null; status: number }[] = [];
	const startResponses: { status: number; body: unknown }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			expect(new URL(url).origin).toBe(origin);
			const action = new URL(url).pathname.split("/").at(-1) ?? "";
			calls.push(action);
			const response = await f.app.request(url, init);
			if (action === "rejoin-attempts") {
				startResponses.push({ status: response.status, body: await response.clone().json() });
			}
			if (action === "revocations") {
				syncChecks.push({
					signature: new Headers(init.headers).get("X-Opencode-Signature"),
					status: response.status,
				});
			}
			if (action === "finalize") {
				expect(response.status).toBe(200);
				throw new Error("Synthetic loss after finalize committed");
			}
			return response;
		}),
	);
	expect((await ordinarySyncCheck(local)).status).toBe("failed");
	expect(syncChecks.map(({ status }) => status)).toEqual([403]);
	expect(localRemovalState(local)).toEqual({ removed: true, removedFromGroups: [groupId] });
	let browser: Promise<void> | undefined;
	const output: string[] = [];
	vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
		const text = String(chunk);
		output.push(text);
		const link = /https:\/\/app\.example\.test\/auth\/rejoin\/start\?[A-Za-z0-9_=&-]+/.exec(
			text,
		)?.[0];
		if (link && !browser) {
			browser = completeInBrowser(f, link);
			void browser.catch(() => process.emit("SIGINT"));
		}
		return true;
	});
	await runCli(local);
	await browser;
	expect(calls).toEqual(["revocations", "rejoin-attempts", "status", "finalize", "status"]);
	expect(output.join("")).toContain("This device rejoined");
	expect(f.db.prepare("SELECT device_id,group_id FROM enrolled_devices").all()).toEqual([
		{ device_id: "removed", group_id: "group-a" },
	]);
	expect(
		f.db.prepare("SELECT count(*) AS count FROM coordinator_device_rejoin_audit_log").get(),
	).toEqual({ count: 1 });
	expect(localRemovalState(local)).toEqual({ removed: true, removedFromGroups: [groupId] });
	expect((await ordinarySyncCheck(local)).status).toBe("checked");
	expect(syncChecks.map(({ status }) => status)).toEqual([403, 200]);
	expect(syncChecks.every(({ signature }) => signature?.startsWith(`${SIGNATURE_VERSION}:`))).toBe(
		true,
	);
	expect(localRemovalState(local)).toEqual({ removed: false, removedFromGroups: [] });

	await removeAndBlock(f);
	const beforeRefusal = coordinatorState(f);
	const callsBeforeRefusal = calls.length;
	const outputBeforeRefusal = output.length;
	await runCli(local);
	expect(calls.slice(callsBeforeRefusal)).toEqual(["rejoin-attempts"]);
	expect(startResponses.at(-1)).toEqual({
		status: 403,
		body: { error: "device_rejoin_unavailable" },
	});
	expect(output.slice(outputBeforeRefusal).join("")).not.toContain("/auth/rejoin/start");
	expect(process.exitCode).toBe(1);
	expect(coordinatorState(f)).toEqual(beforeRefusal);
});
