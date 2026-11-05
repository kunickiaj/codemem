import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CANONICAL_PUBLIC_KEY,
	publicKeyFromWire,
	wireBytes,
} from "./coordinator-ed25519-key-id-test-fixtures.js";
import { readRelayClientSettings } from "./coordinator-sync-config.js";
import {
	RELAY_ADMISSION_PATH,
	type RelayCoordinatorEndpoint,
	relayCoordinatorEndpoint,
	relayGroupClientConfig,
	resolveRelayGroup,
	validateRelayInfo,
} from "./relay-client-config.js";
import { approveRelayServiceKey, readRelayServicePin } from "./relay-service-pin-store.js";
import { relayAuthorityId, relayRealmId } from "./relay-service-proof.js";
import type { RequestJsonExecutor } from "./sync-http-client.js";
import { ensureDeviceIdentity } from "./sync-identity.js";
import { initTestSchema } from "./test-utils.js";

const WORKER_URL = "https://codemem-coordinator-worker.kunickiaj.workers.dev";
const OTHER_KEY = (() => {
	const wire = wireBytes();
	wire[50] = (wire[50] ?? 0) ^ 1;
	return publicKeyFromWire(wire);
})();

function endpoint(): RelayCoordinatorEndpoint {
	const value = relayCoordinatorEndpoint(WORKER_URL);
	if (!value) throw new Error("fixture endpoint must be relay-capable");
	return value;
}

function infoBody(groupId: string, overrides: Record<string, unknown> = {}) {
	return {
		group_id: groupId,
		service_public_key: CANONICAL_PUBLIC_KEY,
		relay_path: `/v1/relay/${relayRealmId(endpoint().authorityId, groupId)}`,
		admission_path: RELAY_ADMISSION_PATH,
		...overrides,
	};
}

describe("relay coordinator derivation", () => {
	it("derives one authority for the coordinator URL with or without a trailing slash", () => {
		// Arrange.
		const expected = relayAuthorityId(WORKER_URL);
		// Act.
		const bare = relayCoordinatorEndpoint(WORKER_URL);
		const slash = relayCoordinatorEndpoint(`${WORKER_URL}/`);
		// Assert.
		expect(bare).toEqual(slash);
		expect(bare).toEqual({
			coordinatorId: WORKER_URL,
			origin: WORKER_URL,
			authorityId: expected,
			admissionUrl: `${WORKER_URL}/v1/relay/admission-check`,
			audienceOrigin: "wss://codemem-coordinator-worker.kunickiaj.workers.dev",
		});
	});

	it.each([
		"http://coordinator.example",
		"coordinator.example",
		"coordinator.example:443",
		"https://coordinator.example/prefix",
		"https://coordinator.example//",
		"https://coordinator.example/?x=1",
		"https://user:pass@coordinator.example",
		"",
	])("rejects %j for relay", (url) => {
		expect(relayCoordinatorEndpoint(url)).toBeNull();
	});

	it("binds the realm URL and audience to the configured origin and pinned key", () => {
		// Act.
		const config = relayGroupClientConfig(endpoint(), "team-a", CANONICAL_PUBLIC_KEY);
		// Assert: the audience uses the same key ID the peer client derives.
		const realm = relayRealmId(endpoint().authorityId, "team-a");
		expect(config.url).toBe(
			`wss://codemem-coordinator-worker.kunickiaj.workers.dev/v1/relay/${realm}`,
		);
		expect(config.externalPathname).toBe(RELAY_ADMISSION_PATH);
		expect(config.relayAudienceId).not.toBe(
			relayGroupClientConfig(endpoint(), "team-a", OTHER_KEY).relayAudienceId,
		);
		expect(config.relayAudienceId).toHaveLength(64);
	});
});

describe("relay info validation", () => {
	it("accepts the exact advertised body and canonicalizes the key", () => {
		const body = infoBody("team-a", { service_public_key: `${CANONICAL_PUBLIC_KEY} comment` });
		expect(validateRelayInfo(endpoint(), "team-a", 200, body)).toEqual({
			ok: true,
			servicePublicKey: CANONICAL_PUBLIC_KEY,
		});
	});

	it.each([
		["another group", 200, infoBody("team-b")],
		["an unparseable key", 200, infoBody("team-a", { service_public_key: "ssh-ed25519 AAAA" })],
		["a non-string key", 200, infoBody("team-a", { service_public_key: 7 })],
		["another realm path", 200, infoBody("team-a", { relay_path: "/v1/relay/other" })],
		[
			"a realm path for another group",
			200,
			infoBody("team-a", { relay_path: infoBody("team-b").relay_path }),
		],
		["another admission path", 200, infoBody("team-a", { admission_path: "/x/admission-check" })],
		["a refusal", 401, { error: "unknown_device" }],
		["an empty body", 200, null],
	])("disables the group for %s", (_name, status, body) => {
		const result = validateRelayInfo(endpoint(), "team-a", status, body);
		expect(result.ok).toBe(false);
	});
});

/** A device with real signing keys and a coordinator that advertises `fixture.advertised`. */
function useRelayGroupFixture() {
	const fixture = {
		db: undefined as unknown as InstanceType<typeof Database>,
		keysDir: "",
		deviceId: "",
		advertised: CANONICAL_PUBLIC_KEY,
		request: vi.fn<RequestJsonExecutor>(),
		resolve: (settings = { enabled: true, serviceKey: "" }, database = fixture.db) =>
			resolveRelayGroup(database, {
				coordinatorUrl: `${WORKER_URL}/`,
				groupId: "team-a",
				deviceId: fixture.deviceId,
				keysDir: fixture.keysDir,
				settings,
				request: fixture.request,
			}),
	};
	beforeEach(() => {
		fixture.db = new Database(":memory:");
		initTestSchema(fixture.db);
		fixture.keysDir = mkdtempSync(join(tmpdir(), "codemem-relay-config-"));
		[fixture.deviceId] = ensureDeviceIdentity(fixture.db, { keysDir: fixture.keysDir });
		fixture.advertised = CANONICAL_PUBLIC_KEY;
		fixture.request.mockReset();
		fixture.request.mockImplementation(async (_method, url) => {
			const groupId = new URL(url).searchParams.get("group_id") ?? "";
			return [200, infoBody(groupId, { service_public_key: fixture.advertised })];
		});
	});
	afterEach(() => {
		fixture.db.close();
		rmSync(fixture.keysDir, { recursive: true, force: true });
	});
	return fixture;
}

describe("relay group resolution", () => {
	const fixture = useRelayGroupFixture();
	const { request, resolve } = fixture;

	it("sends a device-signed GET without following redirects and pins the first key", async () => {
		// Act.
		const result = await resolve();
		// Assert.
		const [method, url, options] = request.mock.calls[0] ?? [];
		expect(method).toBe("GET");
		expect(url).toBe(`${WORKER_URL}/v1/relay/info?group_id=team-a`);
		expect(options?.redirect).toBe("error");
		expect(options?.headers).toMatchObject({ "X-Opencode-Device": fixture.deviceId });
		expect(options?.headers?.["X-Opencode-Signature"]).toMatch(/^v2:/);
		expect(result).toEqual({
			status: "ready",
			config: relayGroupClientConfig(endpoint(), "team-a", CANONICAL_PUBLIC_KEY),
		});
		expect(readRelayServicePin(fixture.db, WORKER_URL, "team-a")).toMatchObject({
			pinnedKey: CANONICAL_PUBLIC_KEY,
			state: "pinned",
			candidateKey: null,
		});
	});

	it("keeps the pin unchanged when the same key is advertised again", async () => {
		await resolve();
		const before = readRelayServicePin(fixture.db, WORKER_URL, "team-a");
		expect((await resolve()).status).toBe("ready");
		expect(readRelayServicePin(fixture.db, WORKER_URL, "team-a")).toEqual(before);
	});

	it("fetches nothing when the device opts out", async () => {
		const settings = readRelayClientSettings({ sync_relay_enabled: false });
		expect(await resolve(settings)).toEqual({
			status: "disabled",
			groupId: "team-a",
			reason: "relay_opt_out",
		});
		expect(request).not.toHaveBeenCalled();
		expect(readRelayServicePin(fixture.db, WORKER_URL, "team-a")).toBeNull();
	});

	it("disables relay without pinning when the info is invalid or unreachable", async () => {
		request.mockResolvedValueOnce([200, infoBody("team-b")]);
		expect(await resolve()).toMatchObject({ status: "disabled", reason: "info_invalid" });
		request.mockRejectedValueOnce(new TypeError("redirect"));
		expect(await resolve()).toMatchObject({ status: "disabled", reason: "info_unavailable" });
		expect(readRelayServicePin(fixture.db, WORKER_URL, "team-a")).toBeNull();
	});
});

describe("relay service key pins", () => {
	const fixture = useRelayGroupFixture();
	const { resolve } = fixture;

	it("pauses on a changed key across restarts until the user approves it", async () => {
		// Arrange: pin the first key in a file database, then advertise another.
		const path = join(fixture.keysDir, "pins.sqlite");
		const first = new Database(path);
		initTestSchema(first);
		await resolve(undefined, first);
		fixture.advertised = OTHER_KEY;
		const paused = await resolve(undefined, first);
		first.close();
		// Act: a restarted process sees the same changed key.
		const reopened = new Database(path);
		try {
			const afterRestart = await resolve(undefined, reopened);
			// Assert.
			const expected = {
				status: "paused",
				groupId: "team-a",
				pinnedKey: CANONICAL_PUBLIC_KEY,
				candidateKey: OTHER_KEY,
			};
			expect(paused).toEqual(expected);
			expect(afterRestart).toEqual(expected);
			expect(readRelayServicePin(reopened, WORKER_URL, "team-a")).toMatchObject({
				pinnedKey: CANONICAL_PUBLIC_KEY,
				state: "pending_change",
				candidateKey: OTHER_KEY,
			});
			const approve = (candidateKey: string) =>
				approveRelayServiceKey(reopened, {
					coordinatorId: WORKER_URL,
					groupId: "team-a",
					candidateKey,
				});
			expect(approve(CANONICAL_PUBLIC_KEY)).toBe(false);
			expect(approve(OTHER_KEY)).toBe(true);
			expect(await resolve(undefined, reopened)).toEqual({
				status: "ready",
				config: relayGroupClientConfig(endpoint(), "team-a", OTHER_KEY),
			});
		} finally {
			reopened.close();
		}
	});

	it("keeps a withdrawn candidate visible after the coordinator reverts", async () => {
		// Arrange: pin, then see a different key.
		await resolve();
		fixture.advertised = OTHER_KEY;
		await resolve();
		const pending = readRelayServicePin(fixture.db, WORKER_URL, "team-a");
		// Act: the coordinator goes back to the pinned key.
		fixture.advertised = CANONICAL_PUBLIC_KEY;
		const result = await resolve();
		// Assert.
		expect(result.status).toBe("ready");
		expect(readRelayServicePin(fixture.db, WORKER_URL, "team-a")).toMatchObject({
			state: "pinned",
			pinnedKey: CANONICAL_PUBLIC_KEY,
			candidateKey: null,
			lastCandidateKey: OTHER_KEY,
			lastCandidateSeenAt: pending?.candidateSeenAt,
		});
	});

	it("approves a pasted candidate with a comment or extra whitespace", async () => {
		await resolve();
		fixture.advertised = OTHER_KEY;
		await resolve();
		const approve = (candidateKey: string) =>
			approveRelayServiceKey(fixture.db, {
				coordinatorId: WORKER_URL,
				groupId: "team-a",
				candidateKey,
			});
		expect(approve("not a key")).toBe(false);
		expect(approve(`  ${OTHER_KEY.replace(" ", "   ")} ops@laptop \n`)).toBe(true);
		expect(readRelayServicePin(fixture.db, WORKER_URL, "team-a")).toMatchObject({
			state: "pinned",
			pinnedKey: OTHER_KEY,
			lastCandidateKey: null,
		});
	});

	it("uses and pins an operator key over the advertised key", async () => {
		// Arrange: a pending change exists for the advertised key.
		await resolve();
		fixture.advertised = OTHER_KEY;
		await resolve();
		// Act.
		const result = await resolve({ enabled: true, serviceKey: `${CANONICAL_PUBLIC_KEY} ops` });
		// Assert.
		expect(result).toEqual({
			status: "ready",
			config: relayGroupClientConfig(endpoint(), "team-a", CANONICAL_PUBLIC_KEY),
		});
		expect(readRelayServicePin(fixture.db, WORKER_URL, "team-a")).toMatchObject({
			state: "pinned",
			candidateKey: null,
		});
		expect(await resolve({ enabled: true, serviceKey: "not a key" })).toMatchObject({
			status: "disabled",
			reason: "service_key_invalid",
		});
	});
});

describe("relay client settings", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("turns relay on by default and maps the environment overrides", () => {
		expect(readRelayClientSettings({})).toEqual({ enabled: true, serviceKey: "" });
		vi.stubEnv("CODEMEM_SYNC_RELAY_ENABLED", "false");
		vi.stubEnv("CODEMEM_SYNC_RELAY_SERVICE_KEY", CANONICAL_PUBLIC_KEY);
		expect(readRelayClientSettings({ sync_relay_enabled: true })).toEqual({
			enabled: false,
			serviceKey: CANONICAL_PUBLIC_KEY,
		});
	});
});
