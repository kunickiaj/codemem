import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { headers, keypair, NOW, ORIGIN } from "./coordinator-account-change-http-test-fixtures.js";
import { createCoordinatorApp } from "./coordinator-api.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { BOUNDARY_READINESS_PATH } from "./coordinator-boundary-readiness-route.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import {
	READINESS_BINDING_MIGRATION,
	READINESS_BINDING_SCHEMA,
} from "./coordinator-readiness-binding.js";
import { verifySignature } from "./sync-auth.js";

async function fixture() {
	const { store, db } = setupStore("D1");
	const key = keypair();
	const groupId = "group-a";
	await store.createGroup(groupId);
	await store.enrollDevice(groupId, key);
	const prepare = () => {
		const generation = crypto.randomUUID();
		db.prepare(
			"UPDATE groups SET readiness_generation=?,readiness_coordinator_id=? WHERE group_id=?",
		).run(generation, ORIGIN, groupId);
		return generation;
	};
	const generation = prepare();
	const path = `${BOUNDARY_READINESS_PATH}?group_id=${groupId}`;
	const record = {
		version: 2,
		group_id: groupId,
		device_id: key.deviceId,
		coordinator_id: ORIGIN,
		group_generation: generation,
		scope_refresh_revision: 2,
		key_id: await ed25519KeyId(key.publicKey),
		filter_evidence: "none",
		sequence: 1,
		projects: [],
		omitted_projects: 0,
	};
	const app = createCoordinatorApp({
		storeFactory: () => store,
		runtime: { now: () => new Date(NOW).toISOString(), adminSecret: () => null },
		requestVerifier: (proof) =>
			verifySignature({ ...proof, bodyBytes: Buffer.from(proof.bodyBytes) }),
	});
	function request(updates: Record<string, unknown> = {}, signer = key) {
		const body = JSON.stringify({ ...record, ...updates });
		const init = { method: "POST", headers: headers(signer, "POST", path, body), body };
		return () => app.request(`${ORIGIN}${path}`, init);
	}
	const verified = () =>
		store.getVerifiedBoundaryReadiness({
			coordinatorId: ORIGIN,
			groupId,
			deviceId: key.deviceId,
			generation,
		});
	return { request, verified, record, db, store, key, prepare };
}
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	f = await fixture();
});
afterEach(() => {
	f?.db.close();
	vi.useRealTimers();
});

it("acknowledges the signed tuple; a reused nonce and a fresh nonce at the same sequence cannot replace it", async () => {
	const request = f.request();
	const stored = await request();
	const echo = {
		version: 2,
		device_id: f.key.deviceId,
		group_id: f.record.group_id,
		key_id: f.record.key_id,
		group_generation: f.record.group_generation,
		sequence: 1,
	};
	expect(await stored.json()).toEqual({ ...echo, status: "stored", rejected: [] });
	expect(await (await request()).json()).toEqual({ error: "nonce_replay" });
	expect(await (await f.request({ filter_evidence: "present" })()).json()).toEqual({
		...echo,
		status: "stale",
	});
	expect(await f.verified()).toMatchObject({ filter_evidence: "none", sequence: 1 });
});

it.each([
	[{ group_generation: crypto.randomUUID() }, 409],
	[{ device_id: "other" }, 400],
	[{ group_id: "other" }, 400],
	[{ key_id: "0".repeat(64) }, 400],
	[{ coordinator_id: "https://other.example.test" }, 400],
	[{ scope_refresh_revision: 0 }, 400],
	[{ filter_evidence: [] }, 400],
	[{ omitted_projects: null }, 400],
] as const)("does not store a signed request with %j", async (changed, status) => {
	expect((await f.request(changed)()).status).toBe(status);
	expect(await f.verified()).toBeNull();
});

it("refuses a signature from another key for the same device", async () => {
	expect((await f.request({}, keypair(f.key.deviceId))()).status).toBe(401);
	expect(await f.verified()).toBeNull();
});

it("does not revive evidence if the group is unarchived or an enrollment is re-enabled", async () => {
	expect((await f.request()()).status).toBe(200);
	await f.store.setDeviceEnabled(f.record.group_id, f.key.deviceId, false);
	await f.store.setDeviceEnabled(f.record.group_id, f.key.deviceId, true);
	expect(await f.verified()).toBeNull();
	const generation = f.prepare();
	expect((await f.request({ sequence: 2, group_generation: generation })()).status).toBe(200);
	await f.store.archiveGroup(f.record.group_id);
	await f.store.unarchiveGroup(f.record.group_id);
	expect(
		await f.store.getVerifiedBoundaryReadiness({
			coordinatorId: ORIGIN,
			generation,
			groupId: f.record.group_id,
			deviceId: f.key.deviceId,
		}),
	).toBeNull();
});

it("refuses verified evidence after the enrolled key is revoked", async () => {
	expect((await f.request()()).status).toBe(200);
	f.db
		.prepare(`INSERT INTO coordinator_device_revocations(subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,created_at)
		VALUES('ed25519_key',?,'fixture',?,?,?,?,'now')`)
		.run(f.record.key_id, f.record.group_id, f.key.deviceId, f.key.publicKey, f.key.fingerprint);
	expect(await f.verified()).toBeNull();
});

it("matches the numbered migration and fresh Worker schema to SQLite initialization", () => {
	const worker = new URL("../../cloudflare-coordinator-worker/", import.meta.url);
	for (const name of ["schema.sql", `migrations/${READINESS_BINDING_MIGRATION}`]) {
		expect(readFileSync(new URL(name, worker), "utf8")).toContain(READINESS_BINDING_SCHEMA.trim());
	}
});
