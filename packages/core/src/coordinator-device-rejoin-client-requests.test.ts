import { generateKeyPairSync, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeCoordinatorAuthProof32 } from "./coordinator-auth-proof.js";
import { createDeviceRejoinRequests } from "./coordinator-device-rejoin-client-requests.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

const origin = "https://coordinator.example.test";
const startInput = {
	attemptId: "attempt-a",
	browserStartHash: "a".repeat(64),
	loopbackRedirect: "http://127.0.0.1:4321/codemem/auth/complete",
};
const now = 1_791_028_800_000;
const startReply = {
	attempt_id: startInput.attemptId,
	expires_at_ms: now + 600_000,
	coordinator_id: "coordinator-a",
	origin,
	issuer: "https://accounts.google.com",
	auth_config_revision: "b".repeat(64),
	identity_id: "identity-a",
	binding_id: "binding-a",
	removal_digest: "c".repeat(64),
};
const receipt = {
	attempt_id: startInput.attemptId,
	device_id: "device-a",
	identity_id: startReply.identity_id,
	binding_id: startReply.binding_id,
	group_ids: ["project-a", "team-b"],
	lifted_removal_seqs: [1, 3],
	finalized_at_ms: now + 12,
};
const completion = {
	completionSecret: encodeCoordinatorAuthProof32(new Uint8Array(32).fill(6)),
	confirmationHash: "d".repeat(64),
};

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

async function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "codemem-rejoin-client-"));
	dirs.push(dir);
	const dbPath = join(dir, "device.sqlite");
	const keysDir = join(dir, "keys");
	mkdirSync(keysDir);
	const keys = generateKeyPairSync("ed25519");
	const raw = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
	const wire = Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), raw]);
	const publicKey = `ssh-ed25519 ${wire.toString("base64")}`;
	const fingerprint = fingerprintPublicKey(publicKey);
	const keyId = await ed25519KeyId(publicKey);
	writeFileSync(
		join(keysDir, "device.key"),
		keys.privateKey.export({ type: "pkcs8", format: "pem" }),
		{ mode: 0o600 },
	);
	const db = new Database(dbPath);
	db.exec("CREATE TABLE sync_device(device_id TEXT, public_key TEXT, fingerprint TEXT)");
	db.prepare("INSERT INTO sync_device VALUES ('device-a', ?, ?)").run(publicKey, fingerprint);
	db.close();

	const fetch = vi.fn<typeof globalThis.fetch>();
	const clock = vi.fn(() => now);
	const context = vi.fn(() => true);
	const client = await createDeviceRejoinRequests({
		coordinatorUrl: origin,
		dbPath,
		keysDir,
		fetch,
		now: clock,
		assertCurrentContext: context,
	});
	if (!client) throw new Error("Missing client");
	return {
		client,
		fetch,
		clock,
		context,
		dbPath,
		key: keys.publicKey,
		publicKey,
		fingerprint,
		keyId,
	};
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function begin(f: Fixture) {
	f.fetch.mockResolvedValueOnce(Response.json(startReply));
	const result = await f.client.start(startInput);
	if (result.kind !== "started") throw new Error("Missing start pins");
	return result.pins;
}

function sent(f: Fixture, index: number, suffix: string, fields: string[]) {
	const call = f.fetch.mock.calls[index];
	if (!call) throw new Error("Missing request");
	const [url, init] = call;
	expect(url).toBe(`${origin}/v1/auth/rejoin-attempts${suffix}`);
	expect(init).toMatchObject({
		method: "POST",
		redirect: "manual",
		credentials: "omit",
		headers: { "Content-Type": "application/json" },
	});
	const body = JSON.parse(String(init?.body));
	expect(Object.keys(body).sort()).toEqual([...fields, "signature"].sort());
	return body;
}

function verifies(f: Fixture, literal: unknown[], signature: string) {
	expect(
		verify(null, Buffer.from(JSON.stringify(literal)), f.key, Buffer.from(signature, "base64url")),
	).toBe(true);
}

describe("signed device rejoin requests", () => {
	it("uses exact start bytes and signs each status poll with a fresh clock", async () => {
		const f = await fixture();
		const pins = await begin(f);
		const start = sent(f, 0, "", [
			"device_id",
			"public_key",
			"attempt_id",
			"browser_start_hash",
			"loopback_redirect",
			"timestamp_ms",
		]);
		verifies(
			f,
			[
				"codemem-device-rejoin-start-v1",
				origin,
				startInput.attemptId,
				"device-a",
				f.publicKey,
				f.keyId,
				startInput.browserStartHash,
				startInput.loopbackRedirect,
				now,
			],
			start.signature,
		);
		for (const offset of [100, 200]) {
			f.clock.mockReturnValue(now + offset);
			f.fetch.mockResolvedValueOnce(
				Response.json({ state: "confirmed", expires_at_ms: pins.expiresAtMs }),
			);
			expect(await f.client.status(pins)).toEqual({ kind: "status", state: "confirmed" });
			const status = sent(f, offset / 100, "/attempt-a/status", ["device_id", "timestamp_ms"]);
			expect(status.timestamp_ms).toBe(now + offset);
			verifies(
				f,
				["codemem-device-rejoin-status-v1", origin, "attempt-a", "device-a", f.keyId, now + offset],
				status.signature,
			);
		}
		f.clock.mockReturnValue(pins.expiresAtMs);
		expect(await f.client.status(pins)).toEqual({ kind: "unknown" });
		expect(f.fetch).toHaveBeenCalledTimes(3);
	});

	it("signs the completion and accepts only a receipt matching the start pins", async () => {
		const f = await fixture();
		const pins = await begin(f);
		f.fetch.mockResolvedValueOnce(Response.json({ state: "prior_commit", receipt }));
		const result = await f.client.finalize(pins, completion);
		expect(result).toMatchObject({
			kind: "finalized",
			receipt: {
				attemptId: "attempt-a",
				bindingId: "binding-a",
				groupIds: ["project-a", "team-b"],
				liftedRemovalSeqs: [1, 3],
			},
		});
		const final = sent(f, 1, "/attempt-a/finalize", ["device_id", "completion"]);
		expect(final.completion).toBe(completion.completionSecret);
		verifies(
			f,
			[
				"codemem-device-rejoin-finalize-v1",
				startReply.coordinator_id,
				origin,
				startReply.auth_config_revision,
				"attempt-a",
				"device-a",
				f.publicKey,
				f.keyId,
				f.fingerprint,
				startReply.issuer,
				startReply.identity_id,
				startReply.binding_id,
				startReply.removal_digest,
				completion.confirmationHash,
				completion.completionSecret,
			],
			final.signature,
		);
		for (const drift of [
			{ binding_id: "wrong" },
			{ attempt_id: "wrong" },
			{ device_id: "wrong" },
			{ lift_removals: ["non-authoritative"], lifted_removal_seqs: [3, 1] },
			{ finalized_at_ms: pins.expiresAtMs },
		]) {
			f.fetch.mockResolvedValueOnce(
				Response.json({ state: "finalized", receipt: { ...receipt, ...drift } }),
			);
			expect(await f.client.finalize(pins, completion)).toEqual({ kind: "unknown" });
		}
	});
});

describe("device rejoin request failures", () => {
	it("does not repeat a start with no usable response", async () => {
		const f = await fixture();
		f.fetch.mockRejectedValueOnce(new Error("transport lost"));
		expect(await f.client.start(startInput)).toEqual({ kind: "unknown" });
		expect(f.fetch).toHaveBeenCalledOnce();
		f.fetch.mockResolvedValueOnce(
			Response.json({ ...startReply, origin: "https://other.example.test" }),
		);
		expect(await f.client.start(startInput)).toEqual({ kind: "unknown" });
		expect(f.fetch).toHaveBeenCalledTimes(2);
	});

	it("does not sign after local context or key evidence changes", async () => {
		const f = await fixture();
		const pins = await begin(f);
		f.context.mockReturnValueOnce(false);
		expect(await f.client.finalize(pins, completion)).toEqual({ kind: "unknown" });
		const db = new Database(f.dbPath);
		db.prepare("UPDATE sync_device SET device_id = 'different-device'").run();
		db.close();
		expect(await f.client.status(pins)).toEqual({ kind: "unknown" });
		expect(f.fetch).toHaveBeenCalledOnce();
	});

	it("treats a lost finalize as unknown and lets the caller recover through signed live status", async () => {
		const f = await fixture();
		const pins = await begin(f);
		f.fetch.mockRejectedValueOnce(new Error("transport lost"));
		expect(await f.client.finalize(pins, completion)).toEqual({ kind: "unknown" });
		expect(f.fetch).toHaveBeenCalledTimes(2);
		f.fetch.mockResolvedValueOnce(
			Response.json({ state: "finalized", expires_at_ms: pins.expiresAtMs, receipt }),
		);
		expect(await f.client.status(pins)).toMatchObject({
			kind: "status",
			state: "finalized",
			receipt: {
				attemptId: pins.attemptId,
				deviceId: "device-a",
			},
		});
	});
});
