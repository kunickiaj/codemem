import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { directNoiseConnectionFactory } from "./direct-noise-client.js";
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
