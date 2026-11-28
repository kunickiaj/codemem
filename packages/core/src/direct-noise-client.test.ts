import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import {
	DirectNoiseBusy,
	DirectNoiseNotOffered,
	directNoiseConnectionFactory,
} from "./direct-noise-client.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import {
	ensureDeviceIdentity,
	generateKeypair,
	loadPublicKey,
	resolveKeyPaths,
} from "./sync-identity.js";
import { initTestSchema } from "./test-utils.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("does not dial when the pin it must prove is no longer the current pin", async () => {
	const db = new Database(":memory:");
	cleanups.push(() => db.close());
	initTestSchema(db);
	db.prepare(
		"INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, created_at) VALUES ('peer', ?, 'key-b', '2026-01-01T00:00:00Z')",
	).run(fingerprintPublicKey("key-b"));
	let connections = 0;
	const server = net.createServer((socket) => {
		connections += 1;
		socket.destroy();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => new Promise((resolve) => server.close(resolve)));
	const factory = directNoiseConnectionFactory({
		db,
		host: "127.0.0.1",
		port: (server.address() as net.AddressInfo).port,
		localDeviceId: "local",
		peerDeviceId: "peer",
		expectedPin: "key-a",
	});

	await expect(
		factory.open({ signal: new AbortController().signal, deadlineMs: performance.now() + 5_000 }),
	).rejects.toThrow(/peer key changed before dialing/);

	expect(connections).toBe(0);
});

it("closes the socket when a listener never answers the upgrade before the deadline", async () => {
	const db = new Database(":memory:");
	cleanups.push(() => db.close());
	initTestSchema(db);
	const keysDir = mkdtempSync(join(tmpdir(), "codemem-direct-noise-hang-"));
	cleanups.push(() => rmSync(keysDir, { recursive: true, force: true }));
	const [localDeviceId] = ensureDeviceIdentity(db, { keysDir });
	const peerKeysDir = join(keysDir, "peer");
	mkdirSync(peerKeysDir);
	generateKeypair(...resolveKeyPaths(peerKeysDir));
	const peerKey = loadPublicKey(peerKeysDir) ?? "";
	db.prepare(
		"INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, created_at) VALUES ('peer', ?, ?, '2026-01-01T00:00:00Z')",
	).run(fingerprintPublicKey(peerKey), peerKey);
	// Accepts the connection, reads the upgrade, and never answers.
	let closedByClient: () => void = () => {};
	const clientClosed = new Promise<void>((resolve) => {
		closedByClient = resolve;
	});
	const server = net.createServer((socket) => {
		// Reading lets the server see the client's end of the connection.
		socket.resume();
		socket.once("close", () => closedByClient());
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => new Promise((resolve) => server.close(resolve)));
	const controller = new AbortController();
	const factory = directNoiseConnectionFactory({
		db,
		host: "127.0.0.1",
		port: (server.address() as net.AddressInfo).port,
		localDeviceId,
		peerDeviceId: "peer",
		keysDir,
		expectedPin: peerKey,
	});

	const opening = factory.open({
		signal: controller.signal,
		deadlineMs: performance.now() + 5_000,
	});
	setTimeout(() => controller.abort(), 50);

	await expect(opening).rejects.toThrow("Direct Noise upgrade got no answer in time");
	await clientClosed;
});

/** A listener that answers every upgrade with one fixed response head, or closes at once. */
async function answering(head: string | "close at once") {
	const db = new Database(":memory:");
	cleanups.push(() => db.close());
	initTestSchema(db);
	const keysDir = mkdtempSync(join(tmpdir(), "codemem-direct-noise-client-"));
	cleanups.push(() => rmSync(keysDir, { recursive: true, force: true }));
	const [localDeviceId] = ensureDeviceIdentity(db, { keysDir });
	const peerKeysDir = join(keysDir, "peer");
	mkdirSync(peerKeysDir);
	generateKeypair(...resolveKeyPaths(peerKeysDir));
	const peerKey = loadPublicKey(peerKeysDir) ?? "";
	db.prepare(
		"INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, created_at) VALUES ('peer', ?, ?, '2026-01-01T00:00:00Z')",
	).run(fingerprintPublicKey(peerKey), peerKey);
	const server = net.createServer((socket) => {
		if (head === "close at once") socket.destroy();
		else socket.once("data", () => socket.end(head));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => new Promise((resolve) => server.close(resolve)));
	return directNoiseConnectionFactory({
		db,
		host: "127.0.0.1",
		port: (server.address() as net.AddressInfo).port,
		localDeviceId,
		peerDeviceId: "peer",
		keysDir,
		expectedPin: peerKey,
	});
}

const open = (factory: Awaited<ReturnType<typeof answering>>) =>
	factory.open({ signal: new AbortController().signal, deadlineMs: performance.now() + 5_000 });

it.each([
	[
		"503",
		"HTTP/1.1 503 Service Unavailable\r\nRetry-After: 2\r\nContent-Length: 0\r\n\r\n",
		503,
		2,
	],
	["429", "HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\n\r\n", 429, undefined],
] as const)(
	"reports a %s answer to the upgrade as busy, not as Noise missing",
	async (_label, head, status, retryAfterS) => {
		const failure = await open(await answering(head)).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(DirectNoiseBusy);
		expect(failure).toMatchObject({ status, retryAfterS });
	},
);

it("still reports a 404 answer to the upgrade as Noise not offered", async () => {
	const failure = await open(
		await answering("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"),
	).catch((error: unknown) => error);

	expect(failure).toBeInstanceOf(DirectNoiseNotOffered);
});

it("reports a connection closed with no answer, as the socket caps refuse, as busy", async () => {
	const failure = await open(await answering("close at once")).catch((error: unknown) => error);

	expect(failure).toBeInstanceOf(DirectNoiseBusy);
	expect(failure).toMatchObject({ status: "closed" });
});

it("still reports a partial answer followed by a close as Noise not offered", async () => {
	const failure = await open(await answering("HTTP/1.1 4")).catch((error: unknown) => error);

	expect(failure).toBeInstanceOf(DirectNoiseNotOffered);
});
