import {
	evictDurableObject,
	listDurableObjectIds,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import {
	encodeRelayAdmissionBody,
	encodeRelayCheckPacket,
	encodeRelayRegistrationBody,
} from "../../core/src/relay-admission-codec.js";
import {
	PARTICIPANT_CREATED_AT,
	PARTICIPANT_DEVICE_INSERT,
	PARTICIPANT_GROUP_INSERT,
} from "../../core/src/relay-admission-participant-nonce-test-fixtures.js";
import { readRelayAdmissionReply } from "../../core/src/relay-admission-reply.js";
import { decodeRelayControl, type RelayControl } from "../../core/src/relay-control-codec.js";
import { relayEd25519KeyId } from "../../core/src/relay-ed25519.js";
import type { RelayHealthState } from "../../core/src/relay-health.js";
import { relayAudienceId, relayRealmId } from "../../core/src/relay-service-proof.js";
import worker, { type CloudflareCoordinatorEnv } from "../src/index.js";
import { captureRelayEnv, RELAY_ADMISSION_PATH, readRelayConfig } from "../src/relay-config.js";
import { RELAY_HEALTH_OBJECT_NAME } from "../src/relay-health-config.js";
import type { RelayHealthContext } from "../src/relay-health-link.js";
import { RELAY_ADMISSION_ADMIN_PATH, RELAY_QUOTA_ADMIN_PATH } from "../src/relay-route.js";
import { relayHealthTestState, relayHealthWorkerEnv } from "./relay-health-do-object.js";

// Local miniflare D1 and Durable Objects only. The tests below run in order and
// share one health object and this file's D1, as one deployment would.
const base = "https://coordinator.example.test";
const config = readRelayConfig(captureRelayEnv({ ...env, CODEMEM_RELAY_ENABLED: "true" }));
if (!config) throw new Error("Relay test config is invalid");
const groups = [...config.realms.values()];
const [group] = groups as [string];
const PROBE = "relay-health-probe";
const audienceId = relayAudienceId(
	config.audienceOrigin,
	await relayEd25519KeyId(env.RELAY_TEST_SERVICE_PUBLIC_KEY),
);
const hex = (bytes: number) =>
	Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
const base64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));

async function deviceKey() {
	const keys = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
	const raw = new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
	const wire = new Uint8Array(51);
	new DataView(wire.buffer).setUint32(0, 11);
	wire.set(new TextEncoder().encode("ssh-ed25519"), 4);
	new DataView(wire.buffer).setUint32(15, 32);
	wire.set(raw, 19);
	const publicKey = `ssh-ed25519 ${base64(wire.buffer)}`;
	return { keys, publicKey, keyId: await relayEd25519KeyId(publicKey) };
}
type DeviceKey = Awaited<ReturnType<typeof deviceKey>>;

const [probe, source, target] = (await Promise.all([deviceKey(), deviceKey(), deviceKey()])) as [
	DeviceKey,
	DeviceKey,
	DeviceKey,
];
const state = relayHealthTestState();
// Set before any health object is constructed, because it reads env once.
state.settings = {
	CODEMEM_RELAY_HEALTH_PROBE_DEVICE: PROBE,
	CODEMEM_RELAY_HEALTH_PROBE_KEY: base64(
		(await crypto.subtle.exportKey("pkcs8", probe.keys.privateKey)) as ArrayBuffer,
	),
	CODEMEM_RELAY_HEALTH_SCOPES: JSON.stringify(
		Object.fromEntries(groups.map((g, index) => [g, `health-scope-${index}`])),
	),
};
const stub = env.RELAY_HEALTH_TEST.get(env.RELAY_HEALTH_TEST.idFromName(RELAY_HEALTH_OBJECT_NAME));
const workerEnv = () => relayHealthWorkerEnv(env) as unknown as CloudflareCoordinatorEnv;
const send = (request: Request, ctx?: RelayHealthContext) => worker.fetch(request, workerEnv(), ctx);

function adminRequest(path: string, body: unknown) {
	return new Request(`${base}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Codemem-Coordinator-Admin": "test-secret" },
		body: JSON.stringify(body),
	});
}

/** Enrollment and synthetic scopes come from normal coordinator flows these tests skip. */
async function seedCoordinator() {
	const db = env.COORDINATOR_DB;
	const devices = [
		...groups.flatMap((g) => [
			[g, PROBE, probe] as const,
			[g, "source", source] as const,
			[g, "target", target] as const,
		]),
	];
	await db.batch([
		...groups.map((g) => db.prepare(PARTICIPANT_GROUP_INSERT).bind(g, PARTICIPANT_CREATED_AT)),
		...devices.map(([g, id, key]) =>
			db
				.prepare(PARTICIPANT_DEVICE_INSERT)
				.bind(g, id, key.publicKey, hex(32), null, 1, PARTICIPANT_CREATED_AT),
		),
	]);
	const store = new D1CoordinatorStore(db);
	for (const [index, g] of groups.entries()) {
		const scopeId = `health-scope-${index}`;
		await store.createScope({ scopeId, groupId: g, label: "Health probe", membershipEpoch: 1 });
		await store.grantScopeMembership({ scopeId, deviceId: PROBE, effectId: `probe-${index}`, membershipEpoch: 1 });
	}
}

async function readiness() {
	const { results } = await env.COORDINATOR_DB.prepare(
		"SELECT scope, group_id, state, observed_at_ms FROM relay_admission_readiness WHERE authority_id = ? ORDER BY scope, group_id",
	)
		.bind(config?.authorityId)
		.all<{ scope: string; group_id: string; state: string; observed_at_ms: number | null }>();
	return results;
}

const stored = (g: string) =>
	runInDurableObject(stub, (_instance, s) => s.storage.get<RelayHealthState>(`state:${g}`));

const CYCLE_KEY = "cycle";
/**
 * Runs the scheduled alarm at fake UTC `now`, then waits for its probes' server
 * samples. It clears the real-time record of the last cycle first, because these
 * alarms run milliseconds apart and would otherwise be skipped as repeats.
 */
async function alarmAt(now: number, samples: number) {
	const before = state.samples;
	state.now = now;
	await runInDurableObject(stub, (_instance, s) => s.storage.delete(CYCLE_KEY));
	const ran = await runDurableObjectAlarm(stub);
	await vi.waitUntil(() => state.samples >= before + samples, { timeout: 5000 });
	return ran;
}

async function signed(
	key: DeviceKey,
	method: string,
	path: string,
	body: Uint8Array,
	timestamp = String(Math.floor(Date.now() / 1000)),
) {
	const nonce = hex(16);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(body)));
	const canonical = [method, path, timestamp, nonce, Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")];
	const signature = await crypto.subtle.sign("Ed25519", key.keys.privateKey, new TextEncoder().encode(canonical.join("\n")));
	return { timestamp, nonce, signature: `v2:${base64(signature)}` };
}

async function signedCheck(bodyBytes: Uint8Array, createdAt: number) {
	const { timestamp, nonce, signature } = await signed(
		source,
		"POST",
		RELAY_ADMISSION_PATH,
		bodyBytes,
		String(createdAt),
	);
	const packet = encodeRelayCheckPacket({
		bodyBytes,
		timestamp,
		nonce,
		signatureBytes: Uint8Array.from(atob(signature.slice(3)), (c) => c.charCodeAt(0)),
	});
	return { packet, bodyBytes };
}

function listen(ws: WebSocket) {
	const texts: RelayControl[] = [];
	ws.accept();
	ws.addEventListener("message", (event) => {
		if (typeof event.data === "string") texts.push(decodeRelayControl(new TextEncoder().encode(event.data)));
	});
	return {
		send: (message: RelayControl) => ws.send(JSON.stringify(message)),
		async next(type: RelayControl["type"]) {
			let found: RelayControl | undefined;
			await vi.waitUntil(() => {
				found = texts.find((m) => m.type === type);
				return found;
			});
			return found as RelayControl;
		},
	};
}

/** The next fake time: at least a second after the last, and never behind real time. */
const nextNow = () => Math.max((state.now ?? 0) + 1000, Date.now());

async function admissionInit(open: Awaited<ReturnType<typeof signedCheck>>): Promise<RequestInit> {
	const { packet } = open;
	return {
		method: "POST",
		headers: {
			"X-Opencode-Device": "source",
			"X-Opencode-Timestamp": packet.timestamp,
			"X-Opencode-Nonce": packet.nonce,
			"X-Opencode-Signature": packet.signature,
		},
		body: open.bodyBytes,
	};
}

/** A source-role route-open check through the public route. True when admitted. */
async function routeOpen(groupId: string): Promise<boolean> {
	const createdAt = Math.floor(Date.now() / 1000);
	const open = await signedCheck(
		encodeRelayAdmissionBody({
			authorityId: config.authorityId,
			groupId,
			relayAudienceId: audienceId,
			role: "source",
			sourceDeviceId: "source",
			sourceKeyId: source.keyId,
			targetDeviceId: "target",
			targetKeyId: target.keyId,
			routeSessionId: hex(16),
			messageADigest: hex(32),
			createdAt,
			admitBefore: createdAt + 30,
			routeNotAfter: createdAt + 55,
		}),
		createdAt,
	);
	const reply = await send(new Request(`${base}${RELAY_ADMISSION_PATH}`, await admissionInit(open)));
	if (reply.status !== 200) return false;
	return readRelayAdmissionReply(new Uint8Array(await reply.arrayBuffer()), open.packet) !== null;
}

const statesBy = async () =>
	Object.fromEntries((await readiness()).map((row) => [`${row.scope}:${row.group_id}`, row.state]));

// The last fake cycle lands 30 s before the real start, so later tests stay fresh.
const start = Date.now() - 15 * 30_000;
beforeAll(async () => {
	await seedCoordinator();
	state.now = start;
	const setup = await send(adminRequest(RELAY_ADMISSION_ADMIN_PATH, {}));
	expect(setup.status).toBe(200);
	expect(await setup.json()).toMatchObject({ readiness: "not_written", health: "scheduled" });
	// Setup arms an immediate alarm, which runs the first cycle on its own.
	await vi.waitUntil(() => state.alarms === 1 && state.samples >= 2 * groups.length, {
		timeout: 5000,
	});
});

describe("relay health Durable Object", () => {
	it("publishes ready authority and realm rows only after five healthy windows, across an eviction", async () => {
		// Arrange: cycle 0 already ran from the alarm that setup armed.
		const states: string[][] = [(await readiness()).map((row) => row.state)];
		const windows: number[] = [(await stored(group))?.healthyWindows ?? -1];
		// Act
		for (let cycle = 1; cycle < 15; cycle++) {
			if (cycle === 7) await evictDurableObject(stub);
			expect(await alarmAt(start + cycle * 30_000, 2 * groups.length)).toBe(true);
			states.push((await readiness()).map((row) => row.state));
			windows.push((await stored(group))?.healthyWindows ?? -1);
		}
		const firstFive = windows.indexOf(5);
		// Assert
		expect(states[0]).toEqual(["tripped", "tripped", "tripped"]);
		expect(firstFive).toBeGreaterThan(4);
		expect(states.slice(0, firstFive).flat()).not.toContain("ready");
		expect(windows[6]).toBeGreaterThan(0);
		expect(windows[7]).toBeGreaterThanOrEqual(windows[6] ?? Infinity);
		expect(await readiness()).toEqual(
			[["authority", ""], ...groups.toSorted().map((g) => ["realm", g])].map(([scope, group_id]) => ({
				scope,
				group_id,
				state: "ready",
				observed_at_ms: start + 14 * 30_000,
			})),
		);
	});

	it("admits a registration through the realm and a route-open check with no seeded readiness", async () => {
		// Arrange: one real-time cycle refreshes readiness.
		await alarmAt(Date.now(), 2 * groups.length);
		const realmId = relayRealmId(config.authorityId, group);
		const quota = await send(adminRequest(RELAY_QUOTA_ADMIN_PATH, { realm_id: realmId, enabled: true }));
		const createdAt = Math.floor(Date.now() / 1000);
		const namespace = { authorityId: config.authorityId, groupId: group, relayAudienceId: audienceId };
		// Act
		const upgrade = await send(new Request(`${base}/v1/relay/${realmId}`, { headers: { Upgrade: "websocket" } }));
		if (!upgrade.webSocket) throw new Error(`upgrade ${upgrade.status}`);
		const peer = listen(upgrade.webSocket);
		peer.send({ v: 1, type: "SERVICE_CHALLENGE", session: hex(16), body: { audienceId } });
		const challenge = await peer.next("SOCKET_CHALLENGE");
		const registration = await signedCheck(
			encodeRelayRegistrationBody({
				...namespace,
				deviceId: "source",
				keyId: source.keyId,
				socketChallengeId: challenge.session,
				createdAt,
				admitBefore: createdAt + 30,
			}),
			createdAt,
		);
		peer.send({ v: 1, type: "REGISTER", session: challenge.session, body: registration.packet });
		const registered = await peer.next("REGISTERED");
		const admitted = await routeOpen(group);
		// Assert
		expect(quota.status).toBe(200);
		expect(registered.body).toMatchObject({ deviceId: "source", realmId });
		expect(admitted).toBe(true);
	});

	it("keeps another team admitted while one team is tripped and while it recovers", async () => {
		// Arrange
		const [healthy, failing] = groups as [string, string];
		state.failGroup = failing;
		// Act: the failing team's probes fail, and its realm row leaves ready.
		await alarmAt(nextNow(), 2);
		const afterFailure = await statesBy();
		const admittedHealthy = await routeOpen(healthy);
		const admittedFailing = await routeOpen(failing);
		// Act: its probes succeed again, but recovery takes five windows.
		state.failGroup = undefined;
		const duringProbe: { authority: string; admitted: boolean }[] = [];
		state.onProbe = async (url) => {
			if (url.searchParams.get("group_id") !== failing || duringProbe.length > 0) return;
			duringProbe.push({ authority: "", admitted: await routeOpen(healthy) });
			const current = duringProbe[0];
			if (current) current.authority = (await statesBy())["authority:"] ?? "";
		};
		await alarmAt(nextNow(), 4);
		state.onProbe = undefined;
		const afterRecoveryCycle = await statesBy();
		// Assert
		expect(afterFailure).toMatchObject({ "authority:": "ready", [`realm:${healthy}`]: "ready" });
		expect(afterFailure[`realm:${failing}`]).not.toBe("ready");
		expect([admittedHealthy, admittedFailing]).toEqual([true, false]);
		expect(duringProbe).toEqual([{ authority: "ready", admitted: true }]);
		expect(afterRecoveryCycle).toMatchObject({ "authority:": "ready", [`realm:${healthy}`]: "ready" });
		expect(afterRecoveryCycle[`realm:${failing}`]).not.toBe("ready");
		expect(await routeOpen(healthy)).toBe(true);
	});

	it("answers a coordinator read before the health object records its sample", async () => {
		// Arrange
		let release = () => {};
		state.sampleGate = new Promise((resolve) => {
			release = resolve;
		});
		const pending: Promise<unknown>[] = [];
		const path = `/v1/scopes?group_id=${encodeURIComponent(group)}`;
		const auth = await signed(source, "GET", path, new Uint8Array());
		const samples = async () => (await stored(group))?.windows["catalogue:real-client"]?.durations.length;
		const before = await samples();
		// Act
		const response = await send(
			new Request(`${base}${path}`, {
				headers: {
					"X-Opencode-Device": "source",
					"X-Opencode-Timestamp": auth.timestamp,
					"X-Opencode-Nonce": auth.nonce,
					"X-Opencode-Signature": auth.signature,
				},
			}),
			{ waitUntil: (promise) => pending.push(promise) },
		);
		const whileHeld = await samples();
		release();
		await Promise.all(pending);
		state.sampleGate = undefined;
		// Assert: the reply came back while the object still held the sample.
		expect(response.status).toBe(200);
		expect(pending).toHaveLength(1);
		expect(whileHeld).toBe(before);
		expect(await samples()).toBe((before ?? 0) + 1);
	});

	it("keeps the original cadence when an alarm is delivered twice", async () => {
		// Arrange
		await alarmAt(nextNow(), 2 * groups.length);
		const cycle = await runInDurableObject(stub, (_instance, s) => s.storage.get<number>(CYCLE_KEY));
		const samples = state.samples;
		// Act: the re-armed alarm runs at once, inside the 29 s repeat gap.
		const ran = await runDurableObjectAlarm(stub);
		const alarm = await runInDurableObject(stub, (_instance, s) => s.storage.getAlarm());
		// Assert
		expect(ran).toBe(true);
		expect(alarm).toBe((cycle ?? Number.NaN) + 30_000);
		expect(state.samples).toBe(samples);
	});

	it("stops while disabled, and after a re-enable past the gap needs five windows again", async () => {
		// Arrange
		const healthy = group;
		expect((await statesBy())[`realm:${healthy}`]).toBe("ready");
		state.enabled = false;
		await evictDurableObject(stub);
		const ranDisabled = await runDurableObjectAlarm(stub);
		const alarmDisabled = await runInDurableObject(stub, (_instance, s) => s.storage.getAlarm());
		const again = await runDurableObjectAlarm(stub);
		// Act: re-enable after more than two minutes and let setup re-arm the alarm.
		state.now = (state.now ?? Date.now()) + 150_000;
		state.enabled = true;
		await evictDurableObject(stub);
		await runInDurableObject(stub, (_instance, s) => s.storage.delete(CYCLE_KEY));
		const alarms = state.alarms;
		const samples = state.samples;
		const setup = await send(adminRequest(RELAY_ADMISSION_ADMIN_PATH, {}));
		await vi.waitUntil(
			() => state.alarms > alarms && state.samples >= samples + 2 * groups.length,
			{ timeout: 5000 },
		);
		const realmStates = [(await statesBy())[`realm:${healthy}`]];
		const windows = [(await stored(healthy))?.healthyWindows ?? -1];
		for (let cycle = 1; cycle < 15; cycle++) {
			await alarmAt((state.now ?? 0) + 30_000, 2 * groups.length);
			realmStates.push((await statesBy())[`realm:${healthy}`]);
			windows.push((await stored(healthy))?.healthyWindows ?? -1);
		}
		const firstFive = windows.indexOf(5);
		// Assert
		expect([ranDisabled, alarmDisabled, again]).toEqual([true, null, false]);
		expect(await setup.json()).toMatchObject({ health: "scheduled" });
		expect(realmStates[0]).toBe("tripped");
		expect(firstFive).toBeGreaterThan(4);
		expect(realmStates.slice(0, firstFive)).not.toContain("ready");
		expect(realmStates.at(-1)).toBe("ready");
		// The production binding, with relay off, never created an object.
		expect(await listDurableObjectIds(env.RELAY_HEALTH as DurableObjectNamespace)).toEqual([]);
	});

	it("leaves readiness at once when a probe fails, then trips at the window close", async () => {
		// Arrange
		state.failProbe = true;
		const last = state.now ?? Date.now();
		// Act
		await alarmAt(last + 30_000, 0);
		const afterFailure = (await readiness()).map((row) => row.state);
		await alarmAt(last + 90_000, 0);
		// Assert
		expect(afterFailure).not.toContain("ready");
		expect((await readiness()).map((row) => row.state)).toEqual(["tripped", "tripped", "tripped"]);
	});
});
