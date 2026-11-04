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
	METADATA_READINESS_INSERT,
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
import {
	applyRelayAdmissionSetup,
	isRelayAdmissionRaceAbort,
	planRelayAdmissionSetup,
	readRelayAdmissionSnapshot,
	relayAdmissionTarget,
} from "../src/relay-admission-setup.js";
import { RELAY_ADMISSION_ADMIN_PATH, RELAY_QUOTA_ADMIN_PATH } from "../src/relay-route.js";

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

function adminRequest(body: unknown, secret = "test-secret", path = RELAY_QUOTA_ADMIN_PATH) {
	return new Request(`${base}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Codemem-Coordinator-Admin": secret },
		body: JSON.stringify(body),
	});
}
const setupRequest = () => adminRequest({}, "test-secret", RELAY_ADMISSION_ADMIN_PATH);

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

const ADMISSION_TABLES = [
	"relay_admission_authority_policy",
	"relay_admission_audiences",
	"relay_admission_realms",
	"relay_admission_readiness",
	"admission_budget_allocations",
] as const;

/** Every admission policy and budget row, in a stable order, for before and after comparisons. */
async function admissionSnapshot() {
	const tables = await Promise.all(
		ADMISSION_TABLES.map(async (table) => {
			const { results } = await env.COORDINATOR_DB.prepare(`SELECT * FROM ${table}`).all();
			return [table, results.map((row) => JSON.stringify(row)).sort()] as const;
		}),
	);
	return Object.fromEntries(tables);
}

/** Enrollment comes from the normal coordinator flows, which these tests skip. */
async function enroll(devices: readonly Enrolled[]) {
	const db = env.COORDINATOR_DB;
	const groups = [...new Set(devices.map((device) => device.group))];
	await db.batch([
		...groups.map((group) => db.prepare(PARTICIPANT_GROUP_INSERT).bind(group, PARTICIPANT_CREATED_AT)),
		...devices.map(({ group, deviceId, publicKey }) =>
			db
				.prepare(PARTICIPANT_DEVICE_INSERT)
				.bind(group, deviceId, publicKey, hex(32), null, 1, PARTICIPANT_CREATED_AT),
		),
	]);
}

/** Readiness has its own writer (codemem-zjvr.2.6.6), so tests still seed it at revision 1. */
async function seedReadiness(groups: readonly string[], options: { authority: boolean }) {
	const db = env.COORDINATOR_DB;
	const now = Date.now();
	const row = (scope: string, group: string) =>
		db.prepare(METADATA_READINESS_INSERT).bind(config?.authorityId, scope, group, 1, "ready", now);
	await db.batch([
		...(options.authority ? [row("authority", "")] : []),
		...groups.map((group) => row("realm", group)),
	]);
}

/**
 * Starts from the fresh migrated D1: the production setup route writes policy,
 * realm and budget rows. Only enrollment and readiness are seeded.
 */
async function seedAdmission(devices: readonly Enrolled[]) {
	const empty = Object.values(await admissionSnapshot()).every((rows) => rows.length === 0);
	if (!empty) throw new Error("Admission tables are not fresh");
	await enroll(devices);
	const setup = await send(setupRequest(), enabledEnv());
	if (setup.status !== 200) throw new Error(`Admission setup failed: ${setup.status}`);
	await seedReadiness([...new Set(devices.map((device) => device.group))], { authority: true });
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

const publicCheck = (check: SignedCheck, workerEnv = enabledEnv()) =>
	send(new Request(`${base}${RELAY_ADMISSION_PATH}`, checkInit(check)), workerEnv);

async function nonceCount() {
	const row = await env.COORDINATOR_DB.prepare("SELECT COUNT(*) AS n FROM request_nonces").first<{
		n: number;
	}>();
	return row?.n;
}

/**
 * Admission rows are permanent and storage is shared across this file, so both
 * configured groups are enrolled once: a source and target per group, plus the
 * relay device the hand-off test registers in each group.
 */
let seeding: Promise<{ relayKeys: DeviceKey[]; teams: Team[] }> | undefined;
function seededAdmission() {
	seeding ??= (async () => {
		const teams = await Promise.all([team(groupId), team(otherGroupId)]);
		const relayKeys = await Promise.all(teams.map(() => deviceKey()));
		await seedAdmission([
			...teams.map((t, index) => ({
				group: t.group,
				deviceId: "relay-device",
				publicKey: (relayKeys[index] as DeviceKey).publicKey,
			})),
			...teams.flatMap(enrolled),
		]);
		return { relayKeys, teams };
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

/** Upgrades to the group's realm object and registers the relay device over the real loopback. */
async function registerThroughRealm(group: string, key: DeviceKey) {
	const realm = relayRealmId(namespace.authorityId, group);
	const response = await send(
		new Request(`${base}/v1/relay/${realm}`, { headers: upgrade }),
		enabledEnv(),
	);
	if (response.status !== 101 || !response.webSocket) throw new Error(`${response.status}`);
	const peer = listen(response.webSocket);
	peer.send({ v: 1, type: "SERVICE_CHALLENGE", session: hex(16), body: { audienceId } });
	await peer.next("SERVICE_PROOF");
	const challenge = await peer.next("SOCKET_CHALLENGE");
	const { packet: body } = await signedRegistration(key, "relay-device", challenge.session, group);
	peer.send({ v: 1, type: "REGISTER", session: challenge.session, body });
	return { peer, registered: await peer.next("REGISTERED") };
}

describe("relay hand-off with real admission over the loopback", () => {
	it("registers both teams against migrated D1 after admission setup, then the quota switch closes a socket", async () => {
		// Arrange
		const { relayKeys, teams } = await seededAdmission();
		const realms = teams.map((t) => relayRealmId(namespace.authorityId, t.group));
		const provisioned = await Promise.all(
			realms.map((realm) => send(adminRequest({ realm_id: realm, enabled: true }), enabledEnv())),
		);
		// Act
		const sessions = [];
		for (const [index, t] of teams.entries())
			sessions.push(await registerThroughRealm(t.group, relayKeys[index] as DeviceKey));
		const nonces = await env.COORDINATOR_DB.prepare(
			"SELECT device_id FROM request_nonces WHERE device_id = 'relay-device'",
		).all();
		await send(adminRequest({ realm_id: realmId, enabled: false }), enabledEnv());
		const refused = await send(new Request(`${base}${realmPath}`, { headers: upgrade }), enabledEnv());
		// Assert
		expect(provisioned.map((response) => response.status)).toEqual([200, 200]);
		expect(sessions.map(({ registered }) => registered.body)).toMatchObject(
			realms.map((realm) => ({ deviceId: "relay-device", realmId: realm })),
		);
		expect(nonces.results).toHaveLength(2);
		await vi.waitUntil(() => sessions[0]?.peer.closeCode() !== null);
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

const thirdGroupId = "relay-third-group";
const threeGroups = () =>
	enabledEnv({ CODEMEM_RELAY_GROUPS: JSON.stringify([groupId, otherGroupId, thirdGroupId]) });

async function allocations(authorityId = namespace.authorityId) {
	const { results } = await env.COORDINATOR_DB.prepare(
		"SELECT pool || ':' || group_id AS scope, rate_per_min AS rate, burst FROM admission_budget_allocations WHERE authority_id = ?1",
	)
		.bind(authorityId)
		.all<{ scope: string; rate: number; burst: number }>();
	return Object.fromEntries(results.map(({ scope, rate, burst }) => [scope, [rate, burst]]));
}

/** Relay config for another authority origin, so its permanent rows stay apart from this file's. */
function otherAuthority(origin: string, groups: readonly string[]) {
	const overrides = {
		CODEMEM_RELAY_AUTHORITY_URL: origin,
		CODEMEM_RELAY_GROUPS: JSON.stringify(groups),
	};
	const other = readRelayConfig(captureRelayEnv({ ...env, ...overrides, CODEMEM_RELAY_ENABLED: "true" }));
	if (!other) throw new Error("Relay test config is invalid");
	return {
		config: other,
		authorityId: other.authorityId,
		audience: relayAudienceId(other.audienceOrigin, serviceKeyId),
		workerEnv: enabledEnv(overrides),
	};
}

describe("relay admission setup route", () => {
	const withHeaders = (headers: Record<string, string>, init: RequestInit = {}) => {
		const request = setupRequest();
		return new Request(request, { ...init, headers: { ...Object.fromEntries(request.headers), ...headers } });
	};
	it.each([
		["a wrong secret", () => adminRequest({}, "wrong", RELAY_ADMISSION_ADMIN_PATH), 401],
		["an Origin header", () => withHeaders({ Origin: base }), 400],
		["a query string", () => new Request(`${base}${RELAY_ADMISSION_ADMIN_PATH}?x=1`, setupRequest()), 400],
		["a non-empty body", () => adminRequest({ groups: [] }, "test-secret", RELAY_ADMISSION_ADMIN_PATH), 400],
		["a JSON array", () => adminRequest([], "test-secret", RELAY_ADMISSION_ADMIN_PATH), 400],
		["a non-JSON content type", () => withHeaders({ "Content-Type": "text/plain" }), 415],
		["GET", () => new Request(`${base}${RELAY_ADMISSION_ADMIN_PATH}`, { headers: setupRequest().headers }), 405],
	])("refuses %s and writes nothing", async (_name, request, status) => {
		// Arrange
		const before = await admissionSnapshot();
		// Act
		const response = await send(request(), enabledEnv());
		// Assert
		expect(response.status).toBe(status);
		expect(await admissionSnapshot()).toEqual(before);
	});

	it("leaves the path to the coordinator while relay is off", async () => {
		// Arrange
		const before = await admissionSnapshot();
		// Act
		const response = await send(setupRequest(), disabledEnv());
		// Assert
		expect(response.status).toBe(404);
		expect(await admissionSnapshot()).toEqual(before);
	});

	it("writes the default profile once, so repeating setup changes nothing", async () => {
		// Arrange: its own authority, so no other test's rows or order matter.
		const other = otherAuthority("https://profile.example.test", [groupId, otherGroupId]);
		const reply = {
			authority_id: other.authorityId,
			audience_id: other.audience,
			policy_revision: 1,
			readiness: "not_written",
		};
		// Act
		const first = await send(setupRequest(), other.workerEnv);
		const before = await admissionSnapshot();
		const again = await send(setupRequest(), other.workerEnv);
		// Assert
		expect([first.status, again.status]).toEqual([200, 200]);
		expect(await first.json()).toMatchObject({ ...reply, changed: true });
		expect(await again.json()).toMatchObject({ ...reply, changed: false });
		expect(await admissionSnapshot()).toEqual(before);
		expect(await allocations(other.authorityId)).toEqual({
			// Two groups: each audience parent sums its children, the authority sums the parents.
			"authority:": [480, 256],
			"device:": [96, 16],
			"device-registration:": [2, 2],
			"relay-route:": [240, 128],
			"relay-registration:": [240, 128],
			...Object.fromEntries(
				["relay-route", "relay-registration"].flatMap((pool) =>
					[groupId, otherGroupId].map((group) => [`${pool}:${group}`, [120, 64]]),
				),
			),
		});
	});

	it("raises the parents for a third group and admits its team", async () => {
		// Arrange
		await seededAdmission();
		const third = await team(thirdGroupId);
		await enroll(enrolled(third));
		// Act
		const setup = await send(setupRequest(), threeGroups());
		await seedReadiness([thirdGroupId], { authority: false });
		const results: boolean[] = [];
		for (const check of await teamChecks(third))
			results.push(await admitted(await publicCheck(check, threeGroups()), check));
		// Assert
		expect(setup.status).toBe(200);
		expect(await setup.json()).toMatchObject({ policy_revision: 2, changed: true });
		expect(await allocations()).toMatchObject({
			"authority:": [720, 384],
			"relay-route:": [360, 192],
			"relay-registration:": [360, 192],
			[`relay-route:${groupId}`]: [120, 64],
			[`relay-route:${thirdGroupId}`]: [120, 64],
		});
		expect(results).toEqual([true, true, true, true]);
	});

	it("keeps every row when a group leaves the config", async () => {
		// Arrange
		await seededAdmission();
		const before = await admissionSnapshot();
		// Act
		const response = await send(setupRequest(), enabledEnv({ CODEMEM_RELAY_GROUPS: `["${groupId}"]` }));
		// Assert
		expect(response.status).toBe(200);
		expect(await admissionSnapshot()).toEqual(before);
	});

	it("fits eight groups within the allocation triggers", async () => {
		// Arrange
		const groups = Array.from({ length: 8 }, (_, index) => `relay-eight-${index}`);
		const other = otherAuthority("https://eight.example.test", groups);
		// Act
		const response = await send(setupRequest(), other.workerEnv);
		// Assert
		expect(response.status).toBe(200);
		expect(await allocations(other.authorityId)).toMatchObject({
			"authority:": [1920, 1024],
			"relay-route:": [960, 512],
			"relay-registration:": [960, 512],
			"relay-route:relay-eight-7": [120, 64],
		});
	});

	it.each([
		[
			"a revoked audience",
			"https://revoked.example.test",
			"relay_audience_revoked",
			(authorityId: string, audience: string) => [
				env.COORDINATOR_DB.prepare(METADATA_POLICY_INSERT).bind(authorityId, 1, "enabled"),
				env.COORDINATOR_DB.prepare(METADATA_AUDIENCE_INSERT).bind(authorityId, audience, "revoked", 1),
			],
		],
		[
			"a closed authority budget",
			"https://closed.example.test",
			"relay_budget_closed",
			(authorityId: string) => [
				env.COORDINATOR_DB.prepare(
					"INSERT INTO admission_budget_allocations(authority_id,pool,audience_id,group_id,rate_per_min,burst) VALUES (?1,'authority','','',0,0)",
				).bind(authorityId),
			],
		],
	])("answers 409 for %s and writes nothing", async (_name, origin, error, seed) => {
		// Arrange
		const other = otherAuthority(origin, [groupId]);
		await env.COORDINATOR_DB.batch(seed(other.authorityId, other.audience));
		const before = await admissionSnapshot();
		// Act
		const response = await send(setupRequest(), other.workerEnv);
		// Assert
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error });
		expect(await admissionSnapshot()).toEqual(before);
	});

	it("aborts a stale plan in D1 and reports a conflict without writing", async () => {
		// Arrange: a real setup bumps the revision after the stale snapshot was read.
		const origin = "https://stale.example.test";
		await send(setupRequest(), otherAuthority(origin, [groupId]).workerEnv);
		const grown = otherAuthority(origin, [groupId, otherGroupId]);
		const target = await relayAdmissionTarget(grown.config);
		const stale = await readRelayAdmissionSnapshot(env.COORDINATOR_DB, target);
		const fresh = await send(setupRequest(), grown.workerEnv);
		const plan = planRelayAdmissionSetup(target, stale);
		if (!plan.ok) throw new Error(plan.error);
		const before = await admissionSnapshot();
		// Act
		const raw = await env.COORDINATOR_DB.batch(
			plan.value.statements.map(({ sql, values }) => env.COORDINATOR_DB.prepare(sql).bind(...values)),
		).then(
			() => null,
			(error: unknown) => error,
		);
		const result = await applyRelayAdmissionSetup(env.COORDINATOR_DB, grown.config, target, stale);
		// Assert
		expect(fresh.status).toBe(200);
		expect((raw as Error).message).toBe(
			"D1_ERROR: relay_policy_revision: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)",
		);
		expect(isRelayAdmissionRaceAbort(raw)).toBe(true);
		expect(result).toEqual({ ok: false, error: "relay_admission_conflict" });
		expect(await admissionSnapshot()).toEqual(before);
	});

	it("answers 409 when another setup commits between the route's read and write", async () => {
		// Arrange: the wrapped D1 lets a competing setup run right after the snapshot read.
		const origin = "https://race.example.test";
		await send(setupRequest(), otherAuthority(origin, [groupId]).workerEnv);
		const grown = otherAuthority(origin, [groupId, otherGroupId]);
		const db = env.COORDINATOR_DB;
		let raced = false;
		const racing = {
			prepare: (sql: string) => db.prepare(sql),
			batch: async (statements: D1PreparedStatement[]) => {
				const results = await db.batch(statements);
				if (!raced) {
					raced = true;
					await send(setupRequest(), grown.workerEnv);
				}
				return results;
			},
		};
		// Act
		const response = await send(setupRequest(), { ...grown.workerEnv, COORDINATOR_DB: racing });
		const after = await admissionSnapshot();
		const again = await send(setupRequest(), grown.workerEnv);
		// Assert
		expect(raced).toBe(true);
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: "relay_admission_conflict" });
		expect(await admissionSnapshot()).toEqual(after);
		expect(await again.json()).toMatchObject({ policy_revision: 2, changed: false });
	});
});
