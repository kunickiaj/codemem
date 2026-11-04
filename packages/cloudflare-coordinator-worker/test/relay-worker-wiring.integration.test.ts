import { listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
	encodeRelayAdmissionBody,
	encodeRelayCheckPacket,
	encodeRelayRegistrationBody,
	type RelayAdmissionRole,
} from "../../core/src/relay-admission-codec.js";
import {
	METADATA_AUDIENCE_INSERT,
	METADATA_POLICY_INSERT,
	metadataSeed,
} from "../../core/src/relay-admission-metadata-test-fixtures.js";
import {
	PARTICIPANT_CREATED_AT,
	PARTICIPANT_DEVICE_INSERT,
	PARTICIPANT_GROUP_INSERT,
} from "../../core/src/relay-admission-participant-nonce-test-fixtures.js";
import { readRelayAdmissionReply } from "../../core/src/relay-admission-reply.js";
import { decodeRelayControl, type RelayControl } from "../../core/src/relay-control-codec.js";
import { relayEd25519KeyId } from "../../core/src/relay-ed25519.js";
import { relayAudienceId, relayRealmId } from "../../core/src/relay-service-proof.js";
import worker, { type CloudflareCoordinatorEnv } from "../src/index.js";
import { captureRelayEnv, RELAY_ADMISSION_PATH, readRelayConfig } from "../src/relay-config.js";
import { RELAY_QUOTA_ADMIN_PATH } from "../src/relay-route.js";

// Local miniflare D1 and Durable Objects only. Nothing here reaches a remote account.
const base = "https://coordinator.example.test";
const config = readRelayConfig(captureRelayEnv({ ...env, CODEMEM_RELAY_ENABLED: "true" }));
if (!config) throw new Error("Relay test config is invalid");
const groupId = "relay-test-group";
const realmId = relayRealmId(config.authorityId, groupId);
const unknownRealm = "0".repeat(64);
const serviceKeyId = await relayEd25519KeyId(env.RELAY_TEST_SERVICE_PUBLIC_KEY);
const audienceId = relayAudienceId(config.audienceOrigin, serviceKeyId);
const namespace = { authorityId: config.authorityId, groupId, relayAudienceId: audienceId };

type WorkerEnv = CloudflareCoordinatorEnv & Record<string, unknown>;
const disabledEnv = (overrides: Record<string, unknown> = {}): WorkerEnv => ({
	...env,
	...overrides,
});
const enabledEnv = (overrides: Record<string, unknown> = {}): WorkerEnv =>
	disabledEnv({
		CODEMEM_RELAY_ENABLED: "true",
		RELAY_REALM: env.RELAY_REALM_LOOPBACK_TEST,
		...overrides,
	});
const send = (request: Request, workerEnv: WorkerEnv) => worker.fetch(request, workerEnv);

/** Records every way the Worker could name or reach an object. */
function recordingNamespace() {
	const calls: string[] = [];
	const namespace = {
		idFromName: (name: string) => {
			calls.push(`idFromName:${name}`);
			return { name };
		},
		get: () => {
			calls.push("get");
			return { fetch: async () => new Response("relay-handoff") };
		},
		getByName: () => calls.push("getByName"),
		newUniqueId: () => calls.push("newUniqueId"),
		idFromString: () => calls.push("idFromString"),
	};
	return { calls, namespace };
}

const upgrade = { Upgrade: "websocket" };
const realmPath = `/v1/relay/${realmId}`;
const ROUTING: readonly [string, string, string, Record<string, string>, boolean][] = [
	["upgrade on a configured realm", "GET", realmPath, upgrade, true],
	["mixed-case Upgrade value", "GET", realmPath, { Upgrade: "WebSocket" }, true],
	["GET without Upgrade", "GET", realmPath, {}, false],
	["POST with Upgrade", "POST", realmPath, upgrade, false],
	["Upgrade other than websocket", "GET", realmPath, { Upgrade: "h2c" }, false],
	["path with a trailing segment", "GET", `${realmPath}/x`, upgrade, false],
	["uppercase realm ID", "GET", `/v1/relay/${realmId.toUpperCase()}`, upgrade, false],
	["admission-check with Upgrade", "POST", RELAY_ADMISSION_PATH, upgrade, false],
	["admission-check GET with Upgrade", "GET", RELAY_ADMISSION_PATH, upgrade, false],
	["coordinator path with Upgrade", "GET", "/v1/peers?group_id=g", upgrade, false],
];

describe("Worker relay routing", () => {
	it.each(ROUTING)("%s", async (_name, method, path, headers, handedOff) => {
		// Arrange
		const { calls, namespace } = recordingNamespace();
		const request = () => new Request(`${base}${path}`, { method, headers });
		// Act
		const relayOn = await send(request(), enabledEnv({ RELAY_REALM: namespace }));
		const relayOff = await send(request(), disabledEnv({ RELAY_REALM: namespace }));
		// Assert
		if (handedOff) {
			expect(await relayOn.text()).toBe("relay-handoff");
			expect(calls).toEqual([`idFromName:${realmId}`, "get"]);
		} else if (method === "POST" && path === RELAY_ADMISSION_PATH) {
			// Relay on serves the coordinator admission check, which denies this empty body.
			expect(calls).toEqual([]);
			expect([relayOn.status, relayOff.status]).toEqual([200, 404]);
			expect(await relayOn.json()).toEqual({ v: 1, eligible: false });
		} else {
			expect(calls).toEqual([]);
			expect(relayOn.status).toBe(relayOff.status);
			expect(await relayOn.text()).toBe(await relayOff.text());
		}
	});

	it.each([
		["an unknown realm", unknownRealm, enabledEnv()],
		["relay on without the Durable Object binding", realmId, enabledEnv({ RELAY_REALM: undefined })],
	])("answers 404 for %s before naming any object", async (_name, id, workerEnv) => {
		// Arrange
		const { calls, namespace } = recordingNamespace();
		const request = new Request(`${base}/v1/relay/${id}`, { headers: upgrade });
		// Act
		const response = await send(
			request,
			workerEnv.RELAY_REALM ? { ...workerEnv, RELAY_REALM: namespace } : workerEnv,
		);
		// Assert
		expect(response.status).toBe(404);
		expect(calls).toEqual([]);
	});

	it("leaves relay-path upgrades to the coordinator while relay is off", async () => {
		// Arrange
		const { calls, namespace } = recordingNamespace();
		const coordinatorOnly = Object.fromEntries(
			Object.entries(env).filter(([key]) => key !== "RELAY_REALM" && !key.startsWith("CODEMEM_RELAY_")),
		) as WorkerEnv;
		const request = () => new Request(`${base}${realmPath}`, { headers: upgrade });
		// Act
		const relayOff = await send(request(), disabledEnv({ RELAY_REALM: namespace }));
		const baseline = await send(request(), coordinatorOnly);
		// Assert
		expect(calls).toEqual([]);
		expect(relayOff.status).toBe(baseline.status);
		expect(Object.fromEntries(relayOff.headers)).toEqual(Object.fromEntries(baseline.headers));
		expect(await relayOff.text()).toBe(await baseline.text());
	});

	it("keeps the production config relay-off and creates no object", async () => {
		// Act
		const response = await exports.default.fetch(`${base}${realmPath}`, { headers: upgrade });
		const admission = await exports.default.fetch(`${base}${RELAY_ADMISSION_PATH}`, {
			method: "POST",
			body: "{}",
		});
		// Assert
		expect(env.CODEMEM_RELAY_ENABLED).toBe("false");
		expect(response.status).toBe(404);
		expect(admission.status).toBe(404);
		expect(await listDurableObjectIds(env.RELAY_REALM as DurableObjectNamespace)).toEqual([]);
	});

	it("serves public admission checks through the coordinator for one or several realms", async () => {
		// Arrange
		const request = () =>
			new Request(`${base}${RELAY_ADMISSION_PATH}`, { method: "POST", body: "{}" });
		// Act
		const single = await send(request(), enabledEnv({ CODEMEM_RELAY_GROUPS: `["${groupId}"]` }));
		const multiple = await send(request(), enabledEnv());
		// Assert: an unsigned packet gets the coordinator's fixed denial reply.
		for (const response of [single, multiple]) {
			expect(response.status).toBe(200);
			expect(response.headers.get("Cache-Control")).toBe("no-store");
			expect(await response.json()).toEqual({ v: 1, eligible: false });
		}
	});

	it.each([
		["GET", "/v1/peers?group_id=g"],
		["GET", "/v1/scopes?group_id=g"],
		["POST", "/v1/presence"],
		["POST", "/v1/admin/devices/revoke"],
		["GET", "/v1/unknown"],
	])("answers coordinator route %s %s the same with relay on and off", async (method, path) => {
		// Arrange
		const { calls, namespace } = recordingNamespace();
		const request = () => new Request(`${base}${path}`, { method, body: method === "GET" ? null : "{}" });
		// Act
		const relayOn = await send(request(), enabledEnv({ RELAY_REALM: namespace }));
		const relayOff = await send(request(), disabledEnv());
		// Assert
		expect(relayOn.status).toBe(relayOff.status);
		expect(await relayOn.text()).toBe(await relayOff.text());
		expect(calls).toEqual([]);
	});
});

describe("relay admission loopback", () => {
	it("rejects redirect error on a service-binding fetch, so the client sends manual", async () => {
		// Arrange
		const loopback = (exports as unknown as { RelayAdmission: Fetcher }).RelayAdmission;
		const init = { method: "POST", body: "{}" } as const;
		// Act
		const attempt = loopback
			.fetch(`${base}${RELAY_ADMISSION_PATH}`, { ...init, redirect: "error" })
			.then(() => null, (error: unknown) => error);
		const manual = await loopback.fetch(`${base}${RELAY_ADMISSION_PATH}`, {
			...init,
			redirect: "manual",
		});
		// Assert: production config keeps relay off, so the entrypoint answers 503.
		expect(await attempt).toBeInstanceOf(TypeError);
		expect(String(await attempt)).toContain("Invalid redirect value");
		expect(manual.status).toBe(503);
	});
});

function adminRequest(body: unknown, secret = "test-secret") {
	return new Request(`${base}${RELAY_QUOTA_ADMIN_PATH}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Codemem-Coordinator-Admin": secret },
		body: JSON.stringify(body),
	});
}

describe("relay quota provisioning route", () => {
	it("leaves the path to the coordinator while relay is off", async () => {
		// Act
		const relayOff = await send(adminRequest({ realm_id: realmId, enabled: true }), disabledEnv());
		// Assert
		expect(relayOff.status).toBe(404);
		expect(await listDurableObjectIds(env.RELAY_REALM as DurableObjectNamespace)).toEqual([]);
	});

	it.each([
		["a wrong secret", adminRequest({ realm_id: realmId, enabled: true }, "wrong"), 401],
		["an extra field", adminRequest({ realm_id: realmId, enabled: true, x: 1 }), 400],
		["a non-boolean switch", adminRequest({ realm_id: realmId, enabled: "true" }), 400],
		["an unknown realm", adminRequest({ realm_id: unknownRealm, enabled: true }), 404],
	])("refuses %s", async (_name, request, status) => {
		// Arrange
		const { calls, namespace } = recordingNamespace();
		// Act
		const response = await send(request, enabledEnv({ RELAY_REALM: namespace }));
		// Assert
		expect(response.status).toBe(status);
		expect(calls).toEqual([]);
	});

	it("provisions the static share once, then switches the quota root", async () => {
		// Arrange
		const realm = relayRealmId(config.authorityId, "relay-other-group");
		const stub = env.RELAY_REALM_LOOPBACK_TEST.get(env.RELAY_REALM_LOOPBACK_TEST.idFromName(realm));
		const quota = () =>
			runInDurableObject(stub, (_object, state) => ({
				root: state.storage.sql.exec("SELECT realm_id, enabled FROM relay_quota_root").toArray(),
				upgrade: state.storage.sql
					.exec("SELECT rate, burst FROM relay_quota_allocations WHERE purpose = 'upgrade' AND scope = 'service'")
					.toArray(),
			}));
		// Act
		const first = await send(adminRequest({ realm_id: realm, enabled: true }), enabledEnv());
		const again = await send(adminRequest({ realm_id: realm, enabled: true }), enabledEnv());
		const off = await send(adminRequest({ realm_id: realm, enabled: false }), enabledEnv());
		// Assert: two configured realms share 120/min, burst 16 as 60/min, burst 8.
		expect([first.status, again.status, off.status]).toEqual([200, 200, 200]);
		expect(await off.json()).toEqual({ realm_id: realm, enabled: false });
		expect(await quota()).toEqual({
			root: [{ realm_id: realm, enabled: 0 }],
			upgrade: [{ rate: 60, burst: 8 }],
		});
	});
});

const hex = (bytes: number) =>
	Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
	return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A disposable device key, enrolled in local D1 with SSH wire encoding. */
async function deviceKey() {
	const keys = (await crypto.subtle.generateKey("Ed25519", true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	const raw = new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
	const wire = new Uint8Array(51);
	new DataView(wire.buffer).setUint32(0, 11);
	wire.set(new TextEncoder().encode("ssh-ed25519"), 4);
	new DataView(wire.buffer).setUint32(15, 32);
	wire.set(raw, 19);
	const publicKey = `ssh-ed25519 ${btoa(String.fromCharCode(...wire))}`;
	return { privateKey: keys.privateKey, publicKey, keyId: await relayEd25519KeyId(publicKey) };
}

interface Enrolled {
	readonly group: string;
	readonly deviceId: string;
	readonly publicKey: string;
}

/** Realm rows for one group. The first group also publishes the authority-wide rows. */
function groupMetadata(group: string, index: number, now: number) {
	const authorityRows = new Set([METADATA_POLICY_INSERT, METADATA_AUDIENCE_INSERT]);
	return metadataSeed({
		authority: namespace.authorityId,
		group,
		audience: audienceId,
		authorityObserved: now,
		realmObserved: now,
	}).filter(
		({ sql, values }) => index === 0 || !(authorityRows.has(sql) || values[1] === "authority"),
	);
}

/** Coordinator-side rows admission needs: enrollment, policy, readiness and budgets per group. */
async function seedAdmission(devices: readonly Enrolled[]) {
	const db = env.COORDINATOR_DB;
	const now = Date.now();
	const groups = [...new Set(devices.map((device) => device.group))];
	const allocate = (pool: string, audience = "", group = "", rate = 1, burst = 16) =>
		db
			.prepare(
				"INSERT INTO admission_budget_allocations(authority_id,pool,audience_id,group_id,rate_per_min,burst) VALUES (?1,?2,?3,?4,?5,?6)",
			)
			.bind(config?.authorityId, pool, audience, group, rate, burst);
	// Each group-'' parent covers the sum of its per-group children.
	const relayPools = ["relay-registration", "relay-route"].flatMap((pool) => [
		allocate(pool, audienceId, "", groups.length, 16 * groups.length),
		...groups.map((group) => allocate(pool, audienceId, group)),
	]);
	await db.batch([
		...groups.map((group) => db.prepare(PARTICIPANT_GROUP_INSERT).bind(group, PARTICIPANT_CREATED_AT)),
		...devices.map(({ group, deviceId, publicKey }) =>
			db
				.prepare(PARTICIPANT_DEVICE_INSERT)
				.bind(group, deviceId, publicKey, hex(32), null, 1, PARTICIPANT_CREATED_AT),
		),
		...groups
			.flatMap((group, index) => groupMetadata(group, index, now))
			.map(({ sql, values }) => db.prepare(sql).bind(...values)),
		allocate("authority", "", "", 4, 64),
		allocate("device"),
		allocate("device-registration", "", "", 1, 2),
		...relayPools,
	]);
}

type DeviceKey = Awaited<ReturnType<typeof deviceKey>>;

/** Signs a body for the public admission pathname, as a peer or relay would. */
async function signedCheck(key: DeviceKey, bodyBytes: Uint8Array, createdAt: number) {
	const nonce = hex(16);
	const canonical = ["POST", RELAY_ADMISSION_PATH, String(createdAt), nonce, await sha256Hex(bodyBytes)];
	const signature = await crypto.subtle.sign(
		"Ed25519",
		key.privateKey,
		new TextEncoder().encode(canonical.join("\n")),
	);
	const packet = encodeRelayCheckPacket({
		bodyBytes,
		timestamp: String(createdAt),
		nonce,
		signatureBytes: new Uint8Array(signature),
	});
	return { packet, bodyBytes };
}

function registrationBody(key: DeviceKey, deviceId: string, socketChallengeId: string, group: string) {
	const createdAt = Math.floor(Date.now() / 1000);
	const bodyBytes = encodeRelayRegistrationBody({
		...namespace,
		groupId: group,
		deviceId,
		keyId: key.keyId,
		socketChallengeId,
		createdAt,
		admitBefore: createdAt + 30,
	});
	return { bodyBytes, createdAt };
}

async function signedRegistration(
	key: DeviceKey,
	deviceId: string,
	socketChallengeId: string,
	group = groupId,
) {
	const { bodyBytes, createdAt } = registrationBody(key, deviceId, socketChallengeId, group);
	return signedCheck(key, bodyBytes, createdAt);
}

const otherGroupId = "relay-other-group";
type Team = { readonly group: string; readonly source: DeviceKey; readonly target: DeviceKey };
type SignedCheck = Awaited<ReturnType<typeof signedCheck>>;

async function team(group: string): Promise<Team> {
	const [source, target] = await Promise.all([deviceKey(), deviceKey()]);
	return { group, source, target };
}

const enrolled = (t: Team): Enrolled[] => [
	{ group: t.group, deviceId: "source", publicKey: t.source.publicKey },
	{ group: t.group, deviceId: "target", publicKey: t.target.publicKey },
];

function signedAdmission(t: Team, role: RelayAdmissionRole) {
	const createdAt = Math.floor(Date.now() / 1000);
	const bodyBytes = encodeRelayAdmissionBody({
		...namespace,
		groupId: t.group,
		role,
		sourceDeviceId: "source",
		sourceKeyId: t.source.keyId,
		targetDeviceId: "target",
		targetKeyId: t.target.keyId,
		routeSessionId: hex(16),
		messageADigest: hex(32),
		createdAt,
		admitBefore: createdAt + 30,
		routeNotAfter: createdAt + 55,
	});
	return signedCheck(t.source, bodyBytes, createdAt);
}

/** The registration, then a source, relay and responder check, all signed by the source. */
async function teamChecks(t: Team): Promise<SignedCheck[]> {
	return [
		await signedRegistration(t.source, "source", hex(16), t.group),
		await signedAdmission(t, "source"),
		await signedAdmission(t, "relay"),
		await signedAdmission(t, "responder"),
	];
}

function checkInit(check: SignedCheck): RequestInit {
	return {
		method: "POST",
		headers: {
			"X-Opencode-Device": "source",
			"X-Opencode-Timestamp": check.packet.timestamp,
			"X-Opencode-Nonce": check.packet.nonce,
			"X-Opencode-Signature": check.packet.signature,
		},
		body: check.bodyBytes,
	};
}

async function admitted(response: Response, check: SignedCheck) {
	return readRelayAdmissionReply(new Uint8Array(await response.arrayBuffer()), check.packet) !== null;
}

const publicCheck = (check: SignedCheck) =>
	send(new Request(`${base}${RELAY_ADMISSION_PATH}`, checkInit(check)), enabledEnv());

async function nonceCount() {
	const row = await env.COORDINATOR_DB.prepare("SELECT COUNT(*) AS n FROM request_nonces").first<{
		n: number;
	}>();
	return row?.n;
}

/**
 * Admission rows are permanent and storage is shared across this file, so both
 * configured groups are enrolled once: a source and target per group, plus the
 * relay device the hand-off test registers.
 */
let seeding: Promise<{ relayKey: DeviceKey; teams: Team[] }> | undefined;
function seededAdmission() {
	seeding ??= (async () => {
		const [relayKey, ...teams] = await Promise.all([
			deviceKey(),
			team(groupId),
			team(otherGroupId),
		]);
		await seedAdmission([
			{ group: groupId, deviceId: "relay-device", publicKey: relayKey.publicKey },
			...teams.flatMap(enrolled),
		]);
		return { relayKey, teams };
	})();
	return seeding;
}

/** Bucket scopes (pool:group) whose reservation changed since `before`. */
async function bucketStamps() {
	const { results } = await env.COORDINATOR_DB.prepare(
		"SELECT pool || ':' || group_id || ':' || device_id AS key, pool || ':' || group_id AS scope, exec_id FROM admission_budget_buckets",
	).all<{ key: string; scope: string; exec_id: string }>();
	return results;
}

async function chargedScopes(before: Awaited<ReturnType<typeof bucketStamps>>) {
	const previous = new Map(before.map((row) => [row.key, row.exec_id]));
	const after = await bucketStamps();
	const changed = after.filter((row) => previous.get(row.key) !== row.exec_id);
	return [...new Set(changed.map((row) => row.scope))].sort();
}

function listen(ws: WebSocket) {
	const texts: RelayControl[] = [];
	let closeCode: number | null = null;
	ws.accept();
	ws.addEventListener("message", (event) => {
		if (typeof event.data === "string")
			texts.push(decodeRelayControl(new TextEncoder().encode(event.data)));
	});
	ws.addEventListener("close", (event) => {
		closeCode = event.code;
	});
	return {
		send: (message: RelayControl) => ws.send(JSON.stringify(message)),
		closeCode: () => closeCode,
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

describe("relay hand-off with real admission over the loopback", () => {
	it("registers end to end against migrated D1, then the quota switch closes the socket", async () => {
		// Arrange
		const { relayKey: key } = await seededAdmission();
		const provisioned = await send(adminRequest({ realm_id: realmId, enabled: true }), enabledEnv());
		const upgradeRequest = () => new Request(`${base}${realmPath}`, { headers: upgrade });
		// Act
		const response = await send(upgradeRequest(), enabledEnv());
		if (response.status !== 101 || !response.webSocket) throw new Error(`${response.status}`);
		const peer = listen(response.webSocket);
		peer.send({ v: 1, type: "SERVICE_CHALLENGE", session: hex(16), body: { audienceId } });
		await peer.next("SERVICE_PROOF");
		const challenge = await peer.next("SOCKET_CHALLENGE");
		const { packet: body } = await signedRegistration(key, "relay-device", challenge.session);
		peer.send({ v: 1, type: "REGISTER", session: challenge.session, body });
		const registered = await peer.next("REGISTERED");
		const nonces = await env.COORDINATOR_DB.prepare(
			"SELECT device_id FROM request_nonces WHERE device_id = 'relay-device'",
		).all();
		await send(adminRequest({ realm_id: realmId, enabled: false }), enabledEnv());
		const refused = await send(upgradeRequest(), enabledEnv());
		// Assert
		expect(provisioned.status).toBe(200);
		expect(registered.body).toMatchObject({ deviceId: "relay-device", realmId });
		expect(nonces.results).toHaveLength(1);
		await vi.waitUntil(() => peer.closeCode() !== null);
		expect(refused.status).toBe(429);
	});
});

describe("public relay admission for several configured groups", () => {
	it("registers and admits source, relay and responder checks for two groups", async () => {
		// Arrange
		const { teams } = await seededAdmission();
		const before = await bucketStamps();
		const nonces = await nonceCount();
		// Act
		const results: boolean[] = [];
		for (const t of teams)
			for (const check of await teamChecks(t)) results.push(await admitted(await publicCheck(check), check));
		// Assert
		expect(results).toEqual(Array(8).fill(true));
		expect(await nonceCount()).toBe((nonces ?? 0) + 8);
		expect(await chargedScopes(before)).toEqual([
			"authority:",
			`device-registration:${groupId}`,
			`device-registration:${otherGroupId}`,
			`device:${groupId}`,
			`device:${otherGroupId}`,
			"relay-registration:",
			`relay-registration:${groupId}`,
			`relay-registration:${otherGroupId}`,
			"relay-route:",
			`relay-route:${groupId}`,
			`relay-route:${otherGroupId}`,
		].sort());
	});

	it("denies a group the Worker does not serve and charges only the shared buckets", async () => {
		// Arrange
		await seededAdmission();
		const check = await signedAdmission(await team("relay-unknown-group"), "source");
		const before = await bucketStamps();
		const nonces = await nonceCount();
		// Act
		const response = await publicCheck(check);
		// Assert
		expect(await response.json()).toEqual({ v: 1, eligible: false });
		expect(await chargedScopes(before)).toEqual(["authority:", "relay-route:"]);
		expect(await nonceCount()).toBe(nonces);
	});

	it.each(["source", "relay"] as const)(
		"pins the loopback to its realm, so one group's realm cannot admit another group's %s check",
		async (role) => {
			// Arrange
			const { teams } = await seededAdmission();
			const loopback = (
				exports as unknown as {
					RelayAdmissionEnabledTest: (options: { props: { realmId: string } }) => Fetcher;
				}
			).RelayAdmissionEnabledTest({ props: { realmId } });
			const check = await signedAdmission(teams[1] as Team, role);
			const before = await bucketStamps();
			// Act
			const pinned = await loopback.fetch(`${base}${RELAY_ADMISSION_PATH}`, {
				...checkInit(check),
				redirect: "manual",
			});
			const charged = await chargedScopes(before);
			const viaPublic = await publicCheck(check);
			// Assert: the loopback wrote no nonce, so the same packet still admits publicly.
			expect(await pinned.json()).toEqual({ v: 1, eligible: false });
			expect(charged).toEqual(["authority:", "relay-route:"]);
			expect(await admitted(viaPublic, check)).toBe(true);
		},
	);
});
