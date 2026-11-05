import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBetterSqliteCoordinatorApp } from "./better-sqlite-coordinator-runtime.js";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import { createCoordinatorApp } from "./coordinator-api.js";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { UNRELATED_PUBLIC_KEY } from "./coordinator-enrollment-revocation-test-harness.js";
import {
	type CoordinatorRelayAdmissionRuntimeOptions,
	relayAdmissionNamespaces,
} from "./coordinator-relay-admission-route.js";
import { relayEd25519KeyId } from "./relay-ed25519.js";
import { relayAudienceId, relayAuthorityId, relayRealmId } from "./relay-service-proof.js";
import { buildAuthHeaders } from "./sync-auth.js";
import { ensureDeviceIdentity, loadPublicKey } from "./sync-identity.js";
import { initTestSchema } from "./test-utils.js";

const ORIGIN = "https://coordinator.example.test";
const AUDIENCE_ORIGIN = "wss://coordinator.example.test";
const AUTHORITY_ID = relayAuthorityId(`${ORIGIN}/`);
const ADMISSION_PATH = "/v1/relay/admission-check";
const SERVED_GROUPS = ["team-a", "team-b", "team-archived"];

async function relayOptions(
	servicePublicKey: string | undefined,
): Promise<CoordinatorRelayAdmissionRuntimeOptions> {
	const audience = relayAudienceId(AUDIENCE_ORIGIN, await relayEd25519KeyId(CANONICAL_PUBLIC_KEY));
	return {
		namespaces: relayAdmissionNamespaces(
			...SERVED_GROUPS.map((groupId) => ({
				authorityId: AUTHORITY_ID,
				groupId,
				relayAudienceId: audience,
			})),
		),
		externalPathname: ADMISSION_PATH,
		ingressKey: "test-ingress",
		servicePublicKey,
	};
}

function appWith(
	store: BetterSqliteCoordinatorStore,
	relayAdmission: CoordinatorRelayAdmissionRuntimeOptions | undefined,
) {
	return createCoordinatorApp({
		storeFactory: () => store,
		// Signature checks are covered by the shared authorizer. This seam keeps requests in-process.
		requestVerifier: async () => true,
		runtime: { adminSecret: () => null, now: () => new Date().toISOString() },
		relayAdmission: relayAdmission && {
			...relayAdmission,
			open: () => {
				throw new Error("the info route must not open the admission database");
			},
		},
	});
}

async function seedStore() {
	const store = new BetterSqliteCoordinatorStore(":memory:");
	vi.spyOn(store, "close").mockResolvedValue();
	// Revocation matches the device's public key, so only the revoked device uses this one.
	const enroll = (groupId: string, deviceId: string, publicKey = UNRELATED_PUBLIC_KEY) =>
		store.enrollDevice(groupId, {
			deviceId,
			publicKey,
			fingerprint: `${deviceId}-fp`,
		});
	for (const groupId of [...SERVED_GROUPS, "team-unserved"]) await store.createGroup(groupId);
	await enroll("team-a", "a-device");
	await enroll("team-b", "b-device");
	await enroll("team-unserved", "unserved-device");
	await enroll("team-archived", "archived-device");
	await store.archiveGroup("team-archived");
	await enroll("team-a", "disabled-device");
	await store.setDeviceEnabled("team-a", "disabled-device", false);
	await enroll("team-a", "revoked-device", CANONICAL_PUBLIC_KEY);
	await store.createDeviceRevocation({
		groupId: "team-a",
		deviceId: "revoked-device",
		publicKey: CANONICAL_PUBLIC_KEY,
		fingerprint: "revoked-device-fp",
	});
	return store;
}

let nonce = 0;

async function call(
	app: ReturnType<typeof createCoordinatorApp>,
	path: string,
	deviceId: string | null,
) {
	nonce += 1;
	const headers: Record<string, string> = deviceId
		? {
				"X-Opencode-Device": deviceId,
				"X-Opencode-Signature": "v2:test-signature",
				"X-Opencode-Timestamp": String(Math.floor(Date.now() / 1000)),
				"X-Opencode-Nonce": `test-nonce-${nonce}`,
			}
		: {};
	const response = await app.request(`${ORIGIN}${path}`, { headers });
	return { status: response.status, body: await response.json(), response };
}

describe("GET /v1/relay/info", () => {
	let store: BetterSqliteCoordinatorStore;

	beforeEach(async () => {
		store = await seedStore();
	});

	afterEach(() => {
		store.db.close();
		vi.restoreAllMocks();
	});

	it("returns the canonical service key and paths to an enrolled device in a served group", async () => {
		// Arrange: the configured key carries a comment that the advertised text drops.
		const app = appWith(store, await relayOptions(`${CANONICAL_PUBLIC_KEY} relay-service`));

		// Act
		const { status, body, response } = await call(
			app,
			"/v1/relay/info?group_id=team-a",
			"a-device",
		);

		// Assert
		expect(status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(body).toEqual({
			group_id: "team-a",
			service_public_key: CANONICAL_PUBLIC_KEY,
			relay_path: `/v1/relay/${relayRealmId(AUTHORITY_ID, "team-a")}`,
			admission_path: ADMISSION_PATH,
		});
	});

	it("advertises a key whose ID derives the namespace's relay audience", async () => {
		// Arrange
		const options = await relayOptions(CANONICAL_PUBLIC_KEY);
		const app = appWith(store, options);

		// Act
		const { body } = await call(app, "/v1/relay/info?group_id=team-b", "b-device");

		// Assert
		const keyId = await relayEd25519KeyId(body.service_public_key);
		expect(relayAudienceId(AUDIENCE_ORIGIN, keyId)).toBe(
			options.namespaces.get("team-b")?.relayAudienceId,
		);
	});

	it("requires a group ID like /v1/peers", async () => {
		const app = appWith(store, await relayOptions(CANONICAL_PUBLIC_KEY));
		const info = await call(app, "/v1/relay/info", "a-device");
		expect(info).toMatchObject({ status: 400, body: { error: "group_id_required" } });
	});

	// Each refusal must equal the /v1/peers response for the listed device and group.
	it.each([
		["another group's device", "team-b", "a-device", "team-b", "a-device"],
		["an unsigned request", "team-a", null, "team-a", null],
		["a disabled device", "team-a", "disabled-device", "team-a", "disabled-device"],
		["a revoked device", "team-a", "revoked-device", "team-a", "revoked-device"],
		[
			"a member of an archived group",
			"team-archived",
			"archived-device",
			"team-archived",
			"archived-device",
		],
		[
			"a member of an unserved group",
			"team-unserved",
			"unserved-device",
			"team-unserved",
			"a-device",
		],
	])(
		"refuses %s exactly as /v1/peers refuses",
		async (_name, group, device, peersGroup, peersDevice) => {
			// Arrange
			const app = appWith(store, await relayOptions(CANONICAL_PUBLIC_KEY));

			// Act
			const info = await call(app, `/v1/relay/info?group_id=${group}`, device);
			const peers = await call(app, `/v1/peers?group_id=${peersGroup}`, peersDevice);

			// Assert
			expect(info.status).toBeGreaterThanOrEqual(401);
			expect({ status: info.status, body: info.body }).toEqual({
				status: peers.status,
				body: peers.body,
			});
		},
	);

	it.each([
		["relay off", undefined],
		["no service key", { servicePublicKey: undefined }],
		["an invalid service key", { servicePublicKey: "ssh-ed25519 not-a-key" }],
		[
			"a key of the wrong type",
			{ servicePublicKey: CANONICAL_PUBLIC_KEY.replace("ssh-ed25519", "ssh-rsa") },
		],
		[
			"an inconsistent namespace map",
			{
				namespaces: new Map([
					[
						"team-a",
						{ authorityId: AUTHORITY_ID, groupId: "team-a", relayAudienceId: "a".repeat(64) },
					],
					[
						"team-b",
						{ authorityId: AUTHORITY_ID, groupId: "team-b", relayAudienceId: "b".repeat(64) },
					],
				]),
			},
		],
		[
			"an authority ID that is not hexadecimal",
			{
				namespaces: relayAdmissionNamespaces({
					authorityId: "not-hex",
					groupId: "team-a",
					relayAudienceId: "a".repeat(64),
				}),
			},
		],
	])("serves no group with %s", async (_name, override) => {
		// Arrange
		const options = override && { ...(await relayOptions(CANONICAL_PUBLIC_KEY)), ...override };
		const app = appWith(store, options);

		// Act
		const info = await call(app, "/v1/relay/info?group_id=team-a", "a-device");
		const nonMember = await call(app, "/v1/peers?group_id=team-unserved", "a-device");

		// Assert
		expect(info.status).toBe(401);
		expect({ status: info.status, body: info.body }).toEqual({
			status: nonMember.status,
			body: nonMember.body,
		});
	});
});

describe("Node coordinator relay info", () => {
	it("serves relay info with real device signatures when callers pass relayAdmission", async () => {
		// Arrange
		const dir = mkdtempSync(join(tmpdir(), "codemem-relay-info-"));
		const deviceDb = new Database(":memory:");
		const keysDir = join(dir, "device-keys");
		try {
			initTestSchema(deviceDb);
			const [deviceId, fingerprint] = ensureDeviceIdentity(deviceDb, { keysDir });
			const publicKey = loadPublicKey(keysDir);
			if (!publicKey) throw new Error("expected device public key");
			const dbPath = join(dir, "coordinator.sqlite");
			const setup = new BetterSqliteCoordinatorStore(dbPath);
			await setup.createGroup("team-a");
			await setup.enrollDevice("team-a", { deviceId, fingerprint, publicKey });
			await setup.close();
			const app = createBetterSqliteCoordinatorApp({
				dbPath,
				relayAdmission: await relayOptions(CANONICAL_PUBLIC_KEY),
			});
			const url = `${ORIGIN}/v1/relay/info?group_id=team-a`;
			const headers = buildAuthHeaders({
				deviceId,
				method: "GET",
				url,
				bodyBytes: Buffer.alloc(0),
				keysDir,
			});

			// Act
			const response = await app.request(url, { headers });

			// Assert
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				group_id: "team-a",
				service_public_key: CANONICAL_PUBLIC_KEY,
			});
		} finally {
			deviceDb.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
