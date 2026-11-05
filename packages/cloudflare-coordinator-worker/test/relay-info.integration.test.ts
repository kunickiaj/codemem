import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	PARTICIPANT_CREATED_AT,
	PARTICIPANT_DEVICE_INSERT,
	PARTICIPANT_GROUP_INSERT,
} from "../../core/src/relay-admission-participant-nonce-test-fixtures.js";
import { relayRealmId } from "../../core/src/relay-service-proof.js";
import worker, { type CloudflareCoordinatorEnv } from "../src/index.js";
import {
	captureRelayEnv,
	RELAY_ADMISSION_PATH,
	RELAY_INFO_PATH,
	readRelayConfig,
} from "../src/relay-config.js";

// Local miniflare D1 only. Nothing here reaches a remote account.
const base = "https://coordinator.example.test";
const groups = ["relay-test-group", "relay-other-group"] as const;
type WorkerEnv = CloudflareCoordinatorEnv & Record<string, unknown>;
const relayOn = (): WorkerEnv => ({ ...env, CODEMEM_RELAY_ENABLED: "true" });
const relayOff = (): WorkerEnv => ({ ...env, CODEMEM_RELAY_ENABLED: "false" });
const config = readRelayConfig(captureRelayEnv(relayOn()));
if (!config) throw new Error("Relay test config is invalid");

const hex = (bytes: number) =>
	Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join(
		"",
	);

/** A disposable device key with its SSH text, as coordinator enrollment stores it. */
async function deviceKey() {
	const keys = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
	const raw = new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
	const wire = new Uint8Array(51);
	new DataView(wire.buffer).setUint32(0, 11);
	wire.set(new TextEncoder().encode("ssh-ed25519"), 4);
	new DataView(wire.buffer).setUint32(15, 32);
	wire.set(raw, 19);
	return { privateKey: keys.privateKey, publicKey: `ssh-ed25519 ${btoa(String.fromCharCode(...wire))}` };
}
type DeviceKey = Awaited<ReturnType<typeof deviceKey>>;

async function enroll(group: string, deviceId: string, key: DeviceKey) {
	const db = env.COORDINATOR_DB;
	await db.batch([
		db.prepare(`${PARTICIPANT_GROUP_INSERT} ON CONFLICT DO NOTHING`).bind(group, PARTICIPANT_CREATED_AT),
		db.prepare(PARTICIPANT_DEVICE_INSERT).bind(group, deviceId, key.publicKey, hex(32), null, 1, PARTICIPANT_CREATED_AT),
	]);
}

/** A GET signed with the coordinator's v2 canonical request, as `/v1/peers` callers sign. */
async function signedGet(path: string, deviceId: string, key: DeviceKey): Promise<Request> {
	const timestamp = String(Math.floor(Date.now() / 1000));
	const nonce = hex(16);
	const emptyDigest = Array.from(
		new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array())),
		(b) => b.toString(16).padStart(2, "0"),
	).join("");
	const canonical = ["GET", path, timestamp, nonce, emptyDigest].join("\n");
	const signature = await crypto.subtle.sign("Ed25519", key.privateKey, new TextEncoder().encode(canonical));
	return new Request(`${base}${path}`, {
		headers: {
			"X-Opencode-Device": deviceId,
			"X-Opencode-Timestamp": timestamp,
			"X-Opencode-Nonce": nonce,
			"X-Opencode-Signature": `v2:${btoa(String.fromCharCode(...new Uint8Array(signature)))}`,
		},
	});
}

/** One device per team. Each test passes its own device ID, so rows never collide. */
async function seedTeams(deviceId: string) {
	const teams = await Promise.all(groups.map(async (group) => ({ group, deviceId, key: await deviceKey() })));
	for (const { group, key } of teams) await enroll(group, deviceId, key);
	return teams;
}

const infoPath = (group: string) => `${RELAY_INFO_PATH}?group_id=${group}`;

describe("relay info over the public Worker", () => {
	it("gives a device in each configured team its own info and the configured service key", async () => {
		// Arrange
		const teams = await seedTeams("member-each");
		// Act
		const bodies = [];
		for (const { group, deviceId, key } of teams) {
			const response = await worker.fetch(await signedGet(infoPath(group), deviceId, key), relayOn());
			expect(response.status).toBe(200);
			bodies.push(await response.json());
		}
		// Assert: the vitest config derives the expected key from the configured secret on its own.
		expect(bodies).toEqual(
			groups.map((group) => ({
				group_id: group,
				service_public_key: env.RELAY_TEST_SERVICE_PUBLIC_KEY,
				relay_path: `/v1/relay/${relayRealmId(config.authorityId, group)}`,
				admission_path: RELAY_ADMISSION_PATH,
			})),
		);
	});

	it("refuses a device enrolled only in another team like /v1/peers does", async () => {
		// Arrange
		const key = await deviceKey();
		await enroll(groups[0], "member-first-only", key);
		// Act
		const info = await worker.fetch(await signedGet(infoPath(groups[1]), "member-first-only", key), relayOn());
		const peers = await worker.fetch(
			await signedGet(`/v1/peers?group_id=${groups[1]}`, "member-first-only", key),
			relayOn(),
		);
		// Assert
		expect(info.status).toBe(401);
		expect({ status: info.status, body: await info.json() }).toEqual({
			status: peers.status,
			body: await peers.json(),
		});
	});

	it("refuses a signature from one team's key for the same device ID in another team like /v1/peers does", async () => {
		// Arrange
		const [first, second] = await seedTeams("member-cross");
		if (!first || !second) throw new Error("expected two teams");
		// Act
		const info = await worker.fetch(await signedGet(infoPath(second.group), first.deviceId, first.key), relayOn());
		const peers = await worker.fetch(
			await signedGet(`/v1/peers?group_id=${second.group}`, first.deviceId, first.key),
			relayOn(),
		);
		// Assert: the device ID is enrolled in both teams, so the other team's key fails verification.
		expect(info.status).toBe(401);
		expect({ status: info.status, body: await info.json() }).toEqual({
			status: peers.status,
			body: await peers.json(),
		});
	});

	it("serves no team while relay is off, with the refusal a non-member gets", async () => {
		// Arrange
		const [first] = await seedTeams("member-off");
		if (!first) throw new Error("expected a team");
		// Act
		const response = await worker.fetch(await signedGet(infoPath(first.group), first.deviceId, first.key), relayOff());
		// Assert
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "unknown_device" });
	});
});
