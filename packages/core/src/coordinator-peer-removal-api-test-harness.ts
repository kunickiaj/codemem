import { expect, it, vi } from "vitest";
import {
	type CoordinatorRequestRateLimitOptions,
	type CoordinatorRequestVerifier,
	createCoordinatorApp,
} from "./coordinator-api.js";
import type { Store } from "./coordinator-auth-store-test-fixtures.js";
import {
	ENROLLMENT_REMOVAL_TRIGGER_NAMES,
	ENROLLMENT_REMOVAL_TRIGGER_STATEMENTS,
} from "./coordinator-device-removal.js";
import { removalDeviceKey } from "./coordinator-device-removal-test-harness.js";
import {
	deleteEnrollmentWithoutTombstone,
	seedEnrollment,
} from "./coordinator-enrollment-test-fixtures.js";
import { INVALIDATE_FILLED_KEYS } from "./coordinator-readiness-invalidation.js";

export interface PeerRemovalApiFixture {
	store: Store;
	prefix: string;
	exec(sql: string, ...values: (string | number | null)[]): Promise<void>;
	rows<T = Record<string, unknown>>(
		sql: string,
		...values: (string | number | null)[]
	): Promise<T[]>;
	measure(action: () => Promise<Response>): Promise<{ response: Response; sql: string[] }>;
	/** Count fresh D1 construction too, without relying on a warm store's caches. */
	freshStore?(): Store;
	verifyRequest: CoordinatorRequestVerifier;
	restoreRemovalStorage?(): Promise<void>;
	valueBound(action: () => Promise<Response>): Promise<{ response: Response; bytes: number[] }>;
}
/** Simulate D1's per-value limit without a service call; record exact serialized UTF-8 sizes. */
export function checkValueBytes(values: unknown[], bytes: number[]) {
	for (const value of values)
		if (typeof value === "string") {
			const size = new TextEncoder().encode(value).byteLength;
			bytes.push(size);
			if (size > 2_000_000) throw new Error("fixture D1 value limit");
		}
}
export const peerRemovalApiHarness = (
	fixture: (use: (value: PeerRemovalApiFixture) => Promise<void>) => Promise<void>,
) =>
	it.extend<{ fixture: PeerRemovalApiFixture }>({
		fixture: async ({ task: _task }, use) => fixture(use),
	});
type Test = ReturnType<typeof peerRemovalApiHarness>;
const PATH = "/v1/peers/revocations";
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) =>
	Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

async function signingKey() {
	const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
	if (!("privateKey" in keys)) throw new Error("Missing fixture key pair");
	const wire = new Uint8Array(51);
	new DataView(wire.buffer).setUint32(0, 11);
	wire.set(encoder.encode("ssh-ed25519"), 4);
	new DataView(wire.buffer).setUint32(15, 32);
	wire.set(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)), 19);
	const publicKey = `ssh-ed25519 ${btoa(String.fromCharCode(...wire))}`;
	return { keys, publicKey };
}
type PostOptions = { nonce?: string; badSignature?: boolean; caller?: string };
async function signedPost(
	c: {
		app: ReturnType<typeof createCoordinatorApp>;
		groupId: string;
		deviceId: string;
		key: Parameters<typeof crypto.subtle.sign>[1];
	},
	raw: string,
	options: PostOptions = {},
) {
	const path = `${PATH}?group_id=${c.groupId}`;
	const timestamp = String(Math.floor(Date.now() / 1000));
	const nonce = options.nonce ?? crypto.randomUUID();
	const canonical = encoder.encode(
		[
			"POST",
			path,
			timestamp,
			nonce,
			hex(await crypto.subtle.digest("SHA-256", encoder.encode(raw))),
		].join("\n"),
	);
	const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", c.key, canonical));
	return c.app.request(path, {
		method: "POST",
		body: raw,
		headers: {
			"Content-Type": "application/json",
			"X-Opencode-Device": options.caller ?? c.deviceId,
			"X-Opencode-Signature": options.badSignature
				? "v1:invalid"
				: `v1:${btoa(String.fromCharCode(...signature))}`,
			"X-Opencode-Timestamp": timestamp,
			"X-Opencode-Nonce": nonce,
		},
	});
}
async function api(
	f: PeerRemovalApiFixture,
	rate: CoordinatorRequestRateLimitOptions = {},
	deviceId = `${f.prefix}-caller`,
) {
	const { keys, publicKey } = await signingKey();
	const groupId = `${f.prefix}-group`;
	await f.store.createGroup(groupId);
	await f.store.enrollDevice(groupId, { deviceId, publicKey, fingerprint: "fixture" });
	const close = vi.spyOn(f.store, "close").mockResolvedValue();
	const fill = vi.spyOn(f.store, "fillEnrollmentKeyIds");
	const lookup = vi.spyOn(f.store, "lookupPeerRemovals");
	const verify = vi.fn(f.verifyRequest);
	const factory = vi.fn(() => f.store);
	const app = createCoordinatorApp({
		storeFactory: factory,
		runtime: { adminSecret: () => null, now: () => new Date().toISOString() },
		requestVerifier: verify,
		requestRateLimit: rate,
	});
	const post = (raw: string, options?: PostOptions) =>
		signedPost({ app, groupId, deviceId, key: keys.privateKey }, raw, options);
	return { groupId, deviceId, publicKey, close, fill, lookup, verify, factory, post };
}
const EMPTY = JSON.stringify({ peers: [] });
const failed = async (response: Response) => {
	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({ error: "peer_revocation_unavailable" });
};
const authority = (f: PeerRemovalApiFixture) =>
	Promise.all(
		[
			"enrolled_devices",
			"coordinator_device_removals",
			"coordinator_device_ownership_bindings",
			"coordinator_scope_memberships",
		].map((table) => f.rows(`SELECT * FROM ${table} ORDER BY rowid`)),
	);
async function legacy(f: PeerRemovalApiFixture, count = 1) {
	await f.exec(
		`INSERT INTO enrolled_devices(group_id, device_id, public_key, fingerprint, enabled, created_at)
		SELECT ?, ? || value, 'opaque-key', 'fp', 1, 'then' FROM json_each(?)`,
		`${f.prefix}-legacy`,
		`${f.prefix}-legacy-`,
		JSON.stringify(Array.from({ length: count }, (_, i) => i)),
	);
}

export function registerPeerRemovalApiContract(test: Test) {
	registerRemovedCallerAdmission(test);
	registerCompleteReply(test);
	registerMixedReply(test);
	registerQueryBudget(test);
	registerFillProgress(test);
	registerLargeFill(test);
	registerDenials(test);
	registerRateAndReplay(test);
	registerReadFailures(test);
	registerStorageFailures(test);
	registerParsingAndRace(test);
	registerLookupRace(test);
	registerUnexpectedFailures(test);
	registerCallerSnapshot(test);
	registerUnsupportedCaller(test);
}

/** A peer enrolled in its own group, and the request that asks about it by its key. */
async function sharedPeer(f: PeerRemovalApiFixture, name: string) {
	const groupId = `${f.prefix}-${name}-group`;
	const peer = {
		groupId,
		deviceId: `${f.prefix}-${name}-peer`,
		...(await removalDeviceKey(`${f.prefix}-${name}`)),
	};
	await f.store.createGroup(groupId);
	await seedEnrollment(f.exec, peer);
	const body = JSON.stringify({
		peers: [{ device_id: peer.deviceId, public_key: peer.publicKey }],
	});
	return { groupId, peer, body };
}

function registerCallerSnapshot(test: Test) {
	test("a key rotation between admission and lookup leaves the old key no key evidence", async ({
		fixture: f,
	}) => {
		const snapshot = f.store.lookupPeerRemovals.bind(f.store);
		const c = await api(f);
		// The old key is still enrolled in one other group; the replacement key in another.
		const old = await sharedPeer(f, "old-key");
		await f.store.enrollDevice(old.groupId, {
			deviceId: c.deviceId,
			publicKey: c.publicKey,
			fingerprint: "fixture",
		});
		const replacement = await removalDeviceKey(`${f.prefix}-replacement`);
		const other = await sharedPeer(f, "replacement");
		await seedEnrollment(f.exec, { groupId: other.groupId, deviceId: c.deviceId, ...replacement });
		const body = JSON.stringify({
			peers: [...JSON.parse(old.body).peers, ...JSON.parse(other.body).peers],
		});
		c.lookup.mockImplementationOnce(async (input) => {
			await deleteEnrollmentWithoutTombstone(
				f.exec,
				"group_id = ? AND device_id = ?",
				c.groupId,
				c.deviceId,
			);
			await seedEnrollment(f.exec, { groupId: c.groupId, deviceId: c.deviceId, ...replacement });
			return snapshot(input);
		});

		const reply = await (await c.post(body)).json();

		expect(reply).toMatchObject({
			enrolled: [old.peer.deviceId, other.peer.deviceId].sort(),
			key_evidence: { removed: [], enrolled: [] },
		});
	});

	test("archiving the authenticating group between admission and lookup leaves no key evidence", async ({
		fixture: f,
	}) => {
		const snapshot = f.store.lookupPeerRemovals.bind(f.store);
		const c = await api(f);
		const other = await sharedPeer(f, "other");
		await f.store.enrollDevice(other.groupId, {
			deviceId: c.deviceId,
			publicKey: c.publicKey,
			fingerprint: "fixture",
		});
		// While the authenticating group is current, the other shared group gives evidence.
		expect(await (await c.post(other.body)).json()).toMatchObject({
			key_evidence: { removed: [], enrolled: [other.peer.deviceId] },
		});
		c.lookup.mockImplementationOnce(async (input) => {
			await f.store.archiveGroup(c.groupId);
			return snapshot(input);
		});

		const reply = await (await c.post(other.body)).json();

		expect(reply).toMatchObject({
			enrolled: [other.peer.deviceId],
			key_evidence: { removed: [], enrolled: [] },
		});
	});
}

function registerUnsupportedCaller(test: Test) {
	test("a legacy caller whose ID the evidence does not support still gets the legacy reply", async ({
		fixture: f,
	}) => {
		const c = await api(f, {}, `${f.prefix}-${"long-legacy-id-".repeat(20)}`);
		expect(c.deviceId.length).toBeGreaterThan(256);
		const removed = {
			groupId: c.groupId,
			deviceId: `${f.prefix}-gone`,
			...(await removalDeviceKey(`${f.prefix}-gone`)),
		};
		await seedEnrollment(f.exec, removed);
		expect(await f.store.removeDevice(removed.groupId, removed.deviceId)).toBe(true);

		const response = await c.post(
			JSON.stringify({ peers: [{ device_id: removed.deviceId, public_key: removed.publicKey }] }),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			version: 1,
			revoked: [],
			removed: [removed.deviceId],
			enrolled: [],
			removal_seq: expect.any(Number),
			key_evidence: { removed: [], enrolled: [] },
		});
	});
}

function registerRemovedCallerAdmission(test: Test) {
	for (const blocked of [false, true]) {
		test(`a signed removed caller gets a denial without a nonce (blocked: ${blocked})`, async ({
			fixture: f,
		}) => {
			const c = await api(f);
			if (blocked)
				expect(
					await f.store.createDeviceRevocation({ ...c, fingerprint: "fixture" }),
				).toMatchObject({
					kind: "revoked",
				});
			expect(await f.store.removeDevice(c.groupId, c.deviceId)).toBe(true);
			const before = await authority(f);
			const invalid = await c.post(EMPTY, { badSignature: true });
			expect([invalid.status, await invalid.json()]).toEqual([401, { error: "unknown_device" }]);

			const valid = await c.post(EMPTY);
			expect([valid.status, await valid.json()]).toEqual([
				403,
				{ error: blocked ? "device_revoked" : "device_removed" },
			]);
			expect(c.fill).not.toHaveBeenCalled();
			expect(c.lookup).not.toHaveBeenCalled();
			expect(c.close).toHaveBeenCalledTimes(2);
			expect(await authority(f)).toEqual(before);
			expect(
				await f.rows("SELECT device_id FROM request_nonces WHERE device_id = ?", c.deviceId),
			).toEqual([]);
		});
	}

	test("does not disclose a removal lifted while the recorded signature is being verified", async ({
		fixture: f,
	}) => {
		const c = await api(f);
		expect(await f.store.removeDevice(c.groupId, c.deviceId)).toBe(true);
		c.verify.mockImplementationOnce(async (request) => {
			const valid = await f.verifyRequest(request);
			await f.exec(
				`UPDATE coordinator_device_removals SET lifted_at = 'fixture-lift',
			 lifted_by_invite_id = 'fixture-invite' WHERE group_id = ? AND device_id = ?`,
				c.groupId,
				c.deviceId,
			);
			return valid;
		});
		const response = await c.post(EMPTY);
		expect([response.status, await response.json()]).toEqual([401, { error: "unknown_device" }]);
		expect(c.verify).toHaveBeenCalledOnce();
		expect(c.lookup).not.toHaveBeenCalled();
		expect(
			await f.rows("SELECT device_id FROM request_nonces WHERE device_id = ?", c.deviceId),
		).toEqual([]);
	});
}
function registerCompleteReply(test: Test) {
	test("signed raw bytes yield the complete keyed, keyless and empty reply without evidence or unrequested IDs", async ({
		fixture: f,
	}) => {
		const c = await api(f);
		await f.store.enrollDevice(c.groupId, {
			deviceId: `${f.prefix}-removed`,
			publicKey: "opaque",
			fingerprint: "fp",
		});
		await f.store.removeDevice(c.groupId, `${f.prefix}-removed`);
		const raw = ` { "peers" : [ { "device_id" : "${f.prefix}-removed" }, { "device_id": "${c.deviceId}", "public_key": "${c.publicKey}" }, { "device_id": "${f.prefix}-opaque-alias", "public_key": "opaque" } ] }\n`;
		const response = await c.post(raw);
		expect(response.status).toBe(200);
		const [maximum] = await f.rows<{ seq: number }>(
			"SELECT MAX(removal_seq) AS seq FROM coordinator_device_removals",
		);
		expect(await response.json()).toEqual({
			version: 1,
			revoked: [],
			removed: [`${f.prefix}-opaque-alias`, `${f.prefix}-removed`].sort(),
			enrolled: [c.deviceId],
			removal_seq: maximum?.seq,
			// The caller asked about itself, enrolled in the group it signed for. The alias has
			// the removed key under another ID, so it is no key evidence for the alias.
			key_evidence: { removed: [], enrolled: [c.deviceId] },
		});
		expect(new TextDecoder().decode(c.verify.mock.calls[0]?.[0].bodyBytes)).toBe(raw);
		expect(c.fill.mock.calls).toEqual([[{ limit: 200 }]]);
		expect(c.close).toHaveBeenCalledTimes(1);
		const empty = await c.post(EMPTY);
		expect(await empty.json()).toEqual({
			version: 1,
			revoked: [],
			removed: [],
			enrolled: [],
			removal_seq: maximum?.seq,
			key_evidence: { removed: [], enrolled: [] },
		});
	});
}
function registerMixedReply(test: Test) {
	test("B15 the route reports removed and enrolled independently for a mixed historical-key claim, with revocation precedence", async ({
		fixture: f,
	}) => {
		const c = await api(f);
		await f.exec(
			`INSERT INTO coordinator_device_removals
			(removal_id, group_id, device_id, public_key, fingerprint, removed_at)
			VALUES ('history', 'elsewhere', ?, 'old-key', 'fp', 'then')`,
			c.deviceId,
		);
		const response = await c.post(JSON.stringify({ peers: [{ device_id: c.deviceId }] }));
		expect(await response.json()).toEqual({
			version: 1,
			revoked: [],
			removed: [c.deviceId],
			enrolled: [c.deviceId],
			removal_seq: 1,
			key_evidence: { removed: [], enrolled: [] },
		});
		await f.store.createDeviceRevocation({
			groupId: c.groupId,
			deviceId: c.deviceId,
			publicKey: c.publicKey,
			fingerprint: "fixture",
		});
		// Use a second signed caller. A revoked caller is refused before this endpoint's reads.
		const other = await api({ ...f, prefix: `${f.prefix}-other` });
		const blocked = await other.post(
			JSON.stringify({ peers: [{ device_id: c.deviceId, public_key: "other-key" }] }),
		);
		expect(await blocked.json()).toEqual({
			version: 1,
			revoked: [c.deviceId],
			removed: [],
			enrolled: [c.deviceId],
			removal_seq: 1,
			key_evidence: { removed: [], enrolled: [] },
		});
	});
}
function registerQueryBudget(test: Test) {
	test("the whole signed HTTP request takes 8 statements, or 11 with a legacy key fill, independent of peer count", async ({
		fixture: f,
	}) => {
		const c = await api(f);
		for (const count of [0, 1, 25]) {
			const body = JSON.stringify({
				peers: Array.from({ length: count }, (_, i) => ({ device_id: `id-${i}` })),
			});
			for (const oldRows of [0, 1]) await measureRequest(f, c, { body, oldRows });
		}
	});
}
async function measureRequest(
	f: PeerRemovalApiFixture,
	c: Awaited<ReturnType<typeof api>>,
	options: { body: string; oldRows: number },
) {
	if (options.oldRows) await legacy(f);
	if (f.freshStore) c.factory.mockImplementationOnce(f.freshStore);
	const { response, sql } = await f.measure(() => c.post(options.body));
	expect(response.status).toBe(200);
	expect(sql).toHaveLength(options.oldRows ? 11 : 8);
	expect(sql.filter((statement) => statement === INVALIDATE_FILLED_KEYS)).toHaveLength(
		options.oldRows,
	);
	expect(Math.max(...sql.map((query) => query.match(/\?/gu)?.length ?? 0))).toBe(6);
	if (options.oldRows)
		await deleteEnrollmentWithoutTombstone(f.exec, "group_id = ?", `${f.prefix}-legacy`);
}
function registerFillProgress(test: Test) {
	test("one bounded fill page per request returns unavailable until all legacy rows are filled", async ({
		fixture: f,
	}) => {
		const c = await api(f);
		await legacy(f, 201);
		await failed(await c.post(EMPTY));
		expect(c.fill.mock.calls).toEqual([[{ limit: 200 }]]);
		expect(await f.rows("SELECT 1 FROM enrolled_devices WHERE key_id IS NULL")).toHaveLength(1);
		const next = await c.post(EMPTY);
		expect(next.status).toBe(200);
		expect(await next.json()).toEqual({
			version: 1,
			revoked: [],
			removed: [],
			enrolled: [],
			removal_seq: 0,
			key_evidence: { removed: [], enrolled: [] },
		});
		expect(c.fill.mock.calls).toEqual([[{ limit: 200 }], [{ limit: 200 }]]);
		expect(c.close).toHaveBeenCalledTimes(2);
	});
}
function registerLargeFill(test: Test) {
	test("large legacy keys progress over byte-bounded fill pages under a simulated D1 value limit", async ({
		fixture: f,
	}) => {
		const c = await api(f);
		const key = `opaque ${'é"\\\n'.repeat(1500)}`;
		await f.exec(
			`INSERT INTO enrolled_devices(group_id, device_id, public_key, fingerprint, enabled, created_at)
			SELECT ?, ? || value, ?, 'fp', 1, 'then' FROM json_each(?)`,
			c.groupId,
			`${f.prefix}-large-`,
			key,
			JSON.stringify(Array.from({ length: 200 }, (_, i) => i)),
		);
		const samples: number[] = [];
		let previous = 200;
		for (const remaining of [118, 36, 0]) {
			const { response, bytes } = await f.valueBound(() => c.post(EMPTY));
			samples.push(Math.max(...bytes));
			expect(Math.max(...bytes)).toBeLessThanOrEqual(1_000_000);
			const rows = await f.rows("SELECT 1 FROM enrolled_devices WHERE key_id IS NULL");
			expect(rows).toHaveLength(remaining);
			expect(rows.length).toBeLessThan(previous);
			previous = rows.length;
			if (remaining) await failed(response);
			else
				expect(await response.json()).toEqual({
					version: 1,
					revoked: [],
					removed: [],
					enrolled: [],
					removal_seq: 0,
					key_evidence: { removed: [], enrolled: [] },
				});
		}
		expect(samples).toEqual([988011, 988085, 433801]);
		expect(c.fill.mock.calls).toEqual(Array.from({ length: 3 }, () => [{ limit: 200 }]));
	});
}
const DENIALS: Record<
	string,
	{
		status: number;
		code: string;
		body?: string;
		options?: PostOptions;
		noStore?: boolean;
		nonce?: number;
	}
> = {
	"bad signature": { status: 401, code: "invalid_signature", options: { badSignature: true } },
	unknown: { status: 401, code: "unknown_device", options: { caller: "unknown" } },
	disabled: { status: 403, code: "device_disabled" },
	archived: { status: 409, code: "group_archived" },
	revoked: { status: 403, code: "device_revoked" },
	"group missing": { status: 401, code: "group_not_found" },
	"bad body": { status: 400, code: "peers_invalid", body: "{", nonce: 1 },
	oversize: { status: 413, code: "body_too_large", body: " ".repeat(65 * 1024), noStore: true },
	"invalid peers": {
		status: 400,
		code: "peers_invalid",
		body: JSON.stringify({ peers: [{ device_id: "id", public_key: null }] }),
		nonce: 1,
	},
};
async function denyCaller(
	f: PeerRemovalApiFixture,
	c: Awaited<ReturnType<typeof api>>,
	mode: string,
) {
	if (mode === "disabled") await f.store.setDeviceEnabled(c.groupId, c.deviceId, false);
	if (mode === "archived") await f.store.archiveGroup(c.groupId);
	if (mode === "revoked")
		await f.store.createDeviceRevocation({
			groupId: c.groupId,
			deviceId: c.deviceId,
			publicKey: c.publicKey,
			fingerprint: "fixture",
		});
	if (mode === "group missing") await f.exec("DELETE FROM groups WHERE group_id = ?", c.groupId);
}
function registerDenials(test: Test) {
	for (const [mode, denied] of Object.entries(DENIALS)) {
		test(`${mode} preserves auth bookkeeping but performs no fill or new authority writes`, async ({
			fixture: f,
		}) => {
			const c = await api(f);
			await legacy(f);
			await denyCaller(f, c, mode);
			const before = await authority(f);
			const response = await c.post(denied.body ?? EMPTY, { ...denied.options, nonce: "denied" });
			expect(response.status).toBe(denied.status);
			expect(await response.json()).toEqual({ error: denied.code });
			expect(c.fill).not.toHaveBeenCalled();
			expect(c.lookup).not.toHaveBeenCalled();
			expect(await authority(f)).toEqual(before);
			expect(c.close).toHaveBeenCalledTimes(denied.noStore ? 0 : 1);
			expect(
				await f.rows("SELECT nonce FROM request_nonces WHERE device_id = ?", c.deviceId),
			).toHaveLength(denied.nonce ?? 0);
		});
	}
}
function registerRateAndReplay(test: Test) {
	for (const mode of ["replay", "rate limit"] as const) {
		test(`${mode} does not repeat fill or authority work after auth`, async ({ fixture: f }) => {
			const c = await api(f, { mutationLimit: mode === "rate limit" ? 1 : 30 });
			expect((await c.post(EMPTY, { nonce: "first" })).status).toBe(200);
			await legacy(f);
			c.fill.mockClear();
			c.lookup.mockClear();
			const before = await authority(f);
			const response = await c.post(EMPTY, { nonce: mode === "replay" ? "first" : "second" });
			expect(response.status).toBe(mode === "replay" ? 401 : 429);
			expect(await response.json()).toMatchObject({
				error: mode === "replay" ? "nonce_replay" : "rate_limited",
			});
			expect(c.fill).not.toHaveBeenCalled();
			expect(c.lookup).not.toHaveBeenCalled();
			expect(await authority(f)).toEqual(before);
			expect(c.close).toHaveBeenCalledTimes(2);
			expect(
				await f.rows("SELECT nonce FROM request_nonces WHERE device_id = ?", c.deviceId),
			).toHaveLength(mode === "replay" ? 1 : 2);
		});
	}
}
/** Each store result breaks a legacy field, and each reply is the fixed unavailable one. */
async function rejectMalformedSnapshots(c: Awaited<ReturnType<typeof api>>) {
	const noKeys = { removed: [], enrolled: [] };
	c.lookup.mockResolvedValueOnce({
		revoked: ["unrequested"],
		removed: [],
		enrolled: [],
		removal_seq: 0,
		key_evidence: noKeys,
	});
	await failed(await c.post(EMPTY));
	c.lookup.mockResolvedValueOnce({
		revoked: [],
		removed: [],
		enrolled: [],
		removal_seq: -1,
		key_evidence: noKeys,
	});
	await failed(await c.post(EMPTY));
	c.lookup.mockResolvedValueOnce({
		revoked: [c.deviceId, c.deviceId],
		removed: [],
		enrolled: [],
		removal_seq: 0,
		key_evidence: noKeys,
	});
	await failed(await c.post(JSON.stringify({ peers: [{ device_id: c.deviceId }] })));
}

/** Each store result breaks only the key evidence, and each reply keeps the legacy fields. */
async function answerWithoutBrokenEvidence(c: Awaited<ReturnType<typeof api>>) {
	const noKeys = { removed: [], enrolled: [] };
	const legacyOnly = {
		version: 1,
		revoked: [],
		removed: [],
		enrolled: [],
		removal_seq: 0,
		key_evidence: noKeys,
	};
	c.lookup.mockResolvedValueOnce({
		revoked: [],
		removed: [],
		enrolled: [],
		removal_seq: 0,
	} as never);
	expect(await (await c.post(EMPTY)).json()).toEqual(legacyOnly);
	c.lookup.mockResolvedValueOnce({
		revoked: [],
		removed: [],
		enrolled: [],
		removal_seq: 0,
		key_evidence: { removed: ["unrequested"], enrolled: [] },
	});
	expect(await (await c.post(EMPTY)).json()).toEqual(legacyOnly);
	c.lookup.mockResolvedValueOnce({
		revoked: [],
		removed: [],
		enrolled: [],
		removal_seq: 0,
		key_evidence: { removed: [], enrolled: [c.deviceId] },
	});
	expect(
		await (await c.post(JSON.stringify({ peers: [{ device_id: c.deviceId }] }))).json(),
	).toEqual(legacyOnly);
}

function registerReadFailures(test: Test) {
	test("fill and snapshot failures or malformed results expose only the fixed unavailable reply", async ({
		fixture: f,
	}) => {
		const c = await api(f);
		c.fill.mockRejectedValueOnce(new Error("private driver detail"));
		await failed(await c.post(EMPTY));
		expect(c.lookup).not.toHaveBeenCalled();
		c.lookup.mockRejectedValueOnce(new Error("device_removal_incomplete"));
		await failed(await c.post(EMPTY));
		c.lookup.mockResolvedValueOnce({ revoked: [] } as never);
		await failed(await c.post(EMPTY));
		await rejectMalformedSnapshots(c);
		await answerWithoutBrokenEvidence(c);
		expect(c.close).toHaveBeenCalledTimes(9);
	});
	test("a blocked legacy row cannot become an empty complete answer", async ({ fixture: f }) => {
		const c = await api(f);
		await legacy(f);
		await f.exec(
			`INSERT INTO coordinator_device_removals
			(removal_id, group_id, device_id, public_key, fingerprint, removed_at)
			VALUES ('blocked', 'old', ?, 'opaque-key', 'fp', 'then')`,
			`${f.prefix}-legacy-0`,
		);
		await failed(await c.post(EMPTY));
	});
}

function registerUnexpectedFailures(test: Test) {
	test("an auth-store failure is unavailable and performs no new fill work", async ({
		fixture: f,
	}) => {
		const c = await api(f);
		vi.spyOn(f.store, "getEnrollment").mockRejectedValueOnce(
			new Error("private auth driver detail"),
		);
		await failed(await c.post(EMPTY));
		expect(c.fill).not.toHaveBeenCalled();
		expect(c.lookup).not.toHaveBeenCalled();
		expect(c.close).toHaveBeenCalledTimes(1);
	});
	test("peer key hashing failures after auth and fill are masked as unavailable", async ({
		fixture: f,
	}) => {
		const snapshot = f.store.lookupPeerRemovals.bind(f.store);
		const c = await api(f);
		c.lookup.mockImplementationOnce(async (input) => {
			const digest = vi
				.spyOn(crypto.subtle, "digest")
				.mockRejectedValue(new Error("private hash detail"));
			try {
				return await snapshot(input);
			} finally {
				digest.mockRestore();
			}
		});
		await failed(
			await c.post(JSON.stringify({ peers: [{ device_id: "peer", public_key: c.publicKey }] })),
		);
		expect(c.fill.mock.calls).toEqual([[{ limit: 200 }]]);
		expect(c.close).toHaveBeenCalledTimes(1);
	});
}
function registerStorageFailures(test: Test) {
	test("a missing enrollment trigger cannot become an empty complete answer", async ({
		fixture: f,
	}) => {
		const c = await api(f);
		const sql = ENROLLMENT_REMOVAL_TRIGGER_STATEMENTS[0];
		if (!sql) throw new Error("Missing fixture trigger");
		await f.exec("DROP TRIGGER enrolled_devices_removal_insert");
		try {
			await failed(await c.post(EMPTY));
		} finally {
			await f.exec(sql);
		}
		expect(c.fill.mock.calls).toEqual([[{ limit: 200 }]]);
		expect(c.close).toHaveBeenCalledTimes(1);
	});
	test("pre-0048 storage answers unavailable after existing signed admission without filling or fabricating a reply", async ({
		fixture: f,
	}) => {
		const c = await api(f);
		for (const name of ENROLLMENT_REMOVAL_TRIGGER_NAMES) await f.exec(`DROP TRIGGER ${name}`);
		for (const sql of [
			"DROP TABLE coordinator_device_removals",
			"ALTER TABLE enrolled_devices DROP COLUMN key_id",
			"ALTER TABLE coordinator_invites DROP COLUMN issued_after_removal_seq",
			"ALTER TABLE coordinator_join_requests DROP COLUMN issued_after_removal_seq",
		])
			await f.exec(sql);
		try {
			await failed(await c.post(EMPTY));
			expect(c.fill).toHaveBeenCalledTimes(1);
			expect(c.lookup).not.toHaveBeenCalled();
			expect(c.close).toHaveBeenCalledTimes(1);
		} finally {
			await f.restoreRemovalStorage?.();
		}
	});
}

function registerParsingAndRace(test: Test) {
	test("the snapshot, not the fill counters, decides readiness", async ({ fixture: f }) => {
		const c = await api(f);
		await legacy(f);
		c.fill.mockResolvedValueOnce({
			filled: 0,
			blocked: 0,
			skipped: 0,
			remaining: false,
			next: null,
		});
		await failed(await c.post(EMPTY));
		expect(c.lookup).toHaveBeenCalledTimes(1);
	});
	test("all existing malformed peer shapes stay invalid without new fill writes", async ({
		fixture: f,
	}) => {
		const c = await api(f);
		await legacy(f);
		const invalid = [
			{},
			{ peers: Array.from({ length: 26 }, () => ({ device_id: "id" })) },
			...[null, [], "id", {}, { device_id: " padded " }].map((peer) => ({ peers: [peer] })),
			...["", 1, null, "x".repeat(4097), "x\u0000y"].map((public_key) => ({
				peers: [{ device_id: "id", public_key }],
			})),
		];
		for (const body of invalid) expect((await c.post(JSON.stringify(body))).status).toBe(400);
		expect(c.fill).not.toHaveBeenCalled();
		expect(c.lookup).not.toHaveBeenCalled();
	});
}
function registerLookupRace(test: Test) {
	test("a removal and fixture lift between fill and snapshot produce consistent flags and sequence", async ({
		fixture: f,
	}) => {
		const snapshot = f.store.lookupPeerRemovals.bind(f.store);
		const c = await api(f);
		const deviceId = `${f.prefix}-peer`;
		await f.store.enrollDevice(c.groupId, { deviceId, publicKey: "opaque", fingerprint: "fp" });
		c.lookup.mockImplementationOnce(async (input) => {
			await f.store.removeDevice(c.groupId, deviceId);
			return snapshot(input);
		});
		const body = JSON.stringify({ peers: [{ device_id: deviceId }] });
		expect(await (await c.post(body)).json()).toEqual({
			version: 1,
			revoked: [],
			removed: [deviceId],
			enrolled: [],
			removal_seq: 1,
			key_evidence: { removed: [], enrolled: [] },
		});
		c.lookup.mockImplementationOnce(async (input) => {
			await f.exec(
				`UPDATE coordinator_device_removals SET lifted_at = 'later', lifted_by_invite_id = 'fixture'
				WHERE device_id = ?`,
				deviceId,
			);
			return snapshot(input);
		});
		expect(await (await c.post(body)).json()).toEqual({
			version: 1,
			revoked: [],
			removed: [],
			enrolled: [],
			removal_seq: 1,
			key_evidence: { removed: [], enrolled: [] },
		});
	});
}
