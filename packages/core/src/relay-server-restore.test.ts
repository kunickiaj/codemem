import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeRelayControl } from "./relay-control-codec.js";
import { createRelayServer, type RelayServerSocket } from "./relay-server.js";
import {
	type RelayRegistrationSnapshot,
	readRelayRegistrationSnapshot,
	snapshotRelayRegistration,
} from "./relay-server-restore.js";
import {
	bytes,
	control,
	data,
	fakeSocket,
	SESSION,
	serverFixture,
	settle,
} from "./relay-server-test-fixtures.js";
import { relayRealmId } from "./relay-service-proof.js";

const REALM = "a".repeat(64);
const KEY = "b".repeat(64);

function snapshot(overrides: Partial<Record<keyof RelayRegistrationSnapshot, unknown>> = {}) {
	return {
		v: 1,
		realmId: REALM,
		deviceId: "source",
		keyId: KEY,
		acceptedAtUtcMs: 1_000_000,
		renewNotBeforeUtcMs: 1_720_000,
		restoreNotAfterUtcMs: 1_890_000,
		...overrides,
	};
}

describe("relay registration snapshot codec", () => {
	it("snapshots the remaining lease against UTC minus the 10 s guard", () => {
		// Arrange: started 2 s ago with 898 s of the 900 s lease left.
		const input = {
			realmId: REALM,
			deviceId: "source",
			keyId: KEY,
			startedMs: 50_000,
			expiresMs: 950_000,
			nowMs: 52_000,
			utcMs: 1_002_000,
		};
		// Act
		const result = snapshotRelayRegistration(input);
		// Assert
		expect(result).toEqual(snapshot());
		expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(1024);
	});
	it("rounds acceptance later and the restore bound earlier for fractional monotonic times", () => {
		// Arrange: renewal has no guard, so acceptance must never precede the real check start.
		for (const [startedMs, nowMs, utcMs] of [
			[50_000.9, 52_000.4, 1_002_000],
			[0.001, 0.999, 1_000_000.5],
			[123.456, 789.012, 1_000_000.25],
		]) {
			// Act
			const result = snapshotRelayRegistration({
				realmId: REALM,
				deviceId: "source",
				keyId: KEY,
				startedMs,
				expiresMs: startedMs + 900_000,
				nowMs,
				utcMs,
			});
			// Assert
			const startedUtc = utcMs - (nowMs - startedMs);
			expect(result?.acceptedAtUtcMs).toBeGreaterThanOrEqual(startedUtc);
			expect(result?.renewNotBeforeUtcMs).toBeGreaterThanOrEqual(startedUtc + 720_000);
			expect(result?.restoreNotAfterUtcMs).toBeLessThanOrEqual(startedUtc + 890_000);
		}
	});
	it("returns no snapshot when no more than the 10 s guard remains", () => {
		// Arrange
		const input = { realmId: REALM, deviceId: "source", keyId: KEY, startedMs: 0, utcMs: 1e6 };
		// Act and Assert
		expect(snapshotRelayRegistration({ ...input, expiresMs: 900_000, nowMs: 890_000 })).toBeNull();
		expect(
			snapshotRelayRegistration({ ...input, expiresMs: 900_000, nowMs: 889_999 }),
		).toMatchObject({ restoreNotAfterUtcMs: 1_000_001 });
	});
	it("returns no snapshot when the host UTC clock is unusable", () => {
		// Arrange
		const input = {
			realmId: REALM,
			deviceId: "source",
			keyId: KEY,
			startedMs: 0,
			expiresMs: 900_000,
			nowMs: 0,
		};
		// Act and Assert
		for (const utcMs of [Number.NaN, Number.POSITIVE_INFINITY, -1])
			expect(snapshotRelayRegistration({ ...input, utcMs })).toBeNull();
	});
	it("restores only the time left before restoreNotAfterUtcMs", () => {
		// Act: waking 100 s after acceptance must not restart the 900 s lease.
		const lease = readRelayRegistrationSnapshot(snapshot(), { realmId: REALM, utcMs: 1_100_000 });
		// Assert
		expect(lease).toEqual({
			deviceId: "source",
			keyId: KEY,
			remainingMs: 790_000,
			renewInMs: 620_000,
		});
	});
	it("fails closed at and after the restore bound", () => {
		// Act and Assert
		for (const utcMs of [1_890_000, 1_890_001, 9_000_000])
			expect(readRelayRegistrationSnapshot(snapshot(), { realmId: REALM, utcMs })).toBeNull();
		expect(
			readRelayRegistrationSnapshot(snapshot(), { realmId: REALM, utcMs: 1_889_999 }),
		).toMatchObject({ remainingMs: 1 });
	});
	it.each([
		["a foreign realm", snapshot({ realmId: "c".repeat(64) })],
		["a non-hex key", snapshot({ keyId: "z".repeat(64) })],
		["an empty device", snapshot({ deviceId: "" })],
		["an unknown version", snapshot({ v: 2 })],
		["an extra field", { ...snapshot(), route: SESSION }],
		["an undefined bound", { ...snapshot(), restoreNotAfterUtcMs: undefined }],
		["an extended lease", snapshot({ restoreNotAfterUtcMs: 1_900_000 })],
		["an early renewal bound", snapshot({ renewNotBeforeUtcMs: 1_000_000 })],
		["a fractional bound", snapshot({ restoreNotAfterUtcMs: 1_889_999.5 })],
		["an inverted lease", snapshot({ restoreNotAfterUtcMs: 999_999 })],
		[
			"a future acceptance",
			snapshot({
				acceptedAtUtcMs: 1_200_000,
				renewNotBeforeUtcMs: 1_920_000,
				restoreNotAfterUtcMs: 2_000_000,
			}),
		],
		["null", null],
		["a JSON string", JSON.stringify(snapshot())],
	])("rejects %s", (_name, value) => {
		// Act
		const lease = readRelayRegistrationSnapshot(value, { realmId: REALM, utcMs: 1_100_000 });
		// Assert
		expect(lease).toBeNull();
	});
	it("rejects every snapshot when the waking UTC clock is unusable", () => {
		// Act and Assert
		expect(
			readRelayRegistrationSnapshot(snapshot(), { realmId: REALM, utcMs: Number.NaN }),
		).toBeNull();
	});
});

let f: Awaited<ReturnType<typeof serverFixture>>;
const stored = new Map<RelayServerSocket, RelayRegistrationSnapshot | null>();
const woken: ReturnType<typeof createRelayServer>[] = [];
function wake() {
	// A new engine over the same coordinator, quota, and clock models a post-eviction instance.
	const server = createRelayServer(f.options);
	woken.push(server);
	return server;
}
function storedFor(socket: RelayServerSocket) {
	const value = stored.get(socket);
	if (!value) throw new Error("No stored registration");
	// Hosts persist through structured clone or JSON, never by reference.
	return JSON.parse(JSON.stringify(value)) as RelayRegistrationSnapshot;
}
async function restoredSource() {
	const a = await f.register();
	const socket = fakeSocket();
	const events = wake().restore(socket, storedFor(a));
	if (!events) throw new Error("Restore denied");
	return { socket, events };
}
function useRestoreFixture() {
	beforeEach(async () => {
		vi.useFakeTimers();
		stored.clear();
		f = await serverFixture({}, { onRegistration: (socket, value) => stored.set(socket, value) });
	});
	afterEach(() => {
		for (const server of woken.splice(0)) server.close();
		f.dispose();
		vi.useRealTimers();
	});
}

describe("relay server registration snapshots", () => {
	useRestoreFixture();
	it("hands the host a bounded snapshot before REGISTERED", async () => {
		// Act
		const socket = await f.register();
		// Assert
		const registered = socket.texts.find((message) => message.type === "REGISTERED");
		if (registered?.type !== "REGISTERED") throw new Error("Registration denied");
		const { remainingMs } = registered.body;
		expect(stored.get(socket)).toEqual({
			v: 1,
			realmId: relayRealmId(f.options.namespace.authorityId, f.options.namespace.groupId),
			deviceId: "source",
			keyId: f.source.keyId,
			acceptedAtUtcMs: f.clock.utcMs(),
			renewNotBeforeUtcMs: f.clock.utcMs() + 720_000,
			restoreNotAfterUtcMs: f.clock.utcMs() + remainingMs - 10_000,
		});
	});
	it("closes the socket instead of sending REGISTERED when the host cannot store it", async () => {
		// Arrange
		f.dispose();
		f = await serverFixture(
			{},
			{
				onRegistration: () => {
					throw new Error("attachment too large");
				},
			},
		);
		// Act
		const socket = await f.register();
		// Assert
		expect(socket.close).toHaveBeenCalledTimes(1);
		expect(socket.texts.some((message) => message.type === "REGISTERED")).toBe(false);
	});
	it("routes between restored sockets without a new registration", async () => {
		// Arrange
		const a = await f.register(),
			b = await f.register("target");
		const server = wake();
		const a2 = fakeSocket(),
			b2 = fakeSocket();
		// Act
		const aEvents = server.restore(a2, storedFor(a));
		server.restore(b2, storedFor(b));
		if (!aEvents) throw new Error("Restore denied");
		await aEvents.text(bytes(encodeRelayControl(await f.openPacket())));
		await settle();
		// Assert
		expect(server.counters()).toMatchObject({ sockets: 2, pendingSockets: 0, routes: 1 });
		expect(b2.texts.map((message) => message.type)).toEqual(["OPEN"]);
		expect(a2.close).not.toHaveBeenCalled();
	});
});

describe("restored relay sockets", () => {
	useRestoreFixture();
	it("fails closed when the restore bound has passed", async () => {
		// Arrange
		const a = await f.register();
		const value = storedFor(a);
		f.clock.now += value.restoreNotAfterUtcMs - f.clock.utcMs();
		// Act
		const events = wake().restore(fakeSocket(), value);
		// Assert
		expect(events).toBeNull();
	});
	it("fails closed for tampered metadata without adopting the socket", async () => {
		// Arrange
		const a = await f.register();
		const server = wake();
		const socket = fakeSocket();
		// Act
		const events = server.restore(socket, {
			...storedFor(a),
			restoreNotAfterUtcMs: storedFor(a).restoreNotAfterUtcMs + 60_000,
		});
		// Assert
		expect(events).toBeNull();
		expect(server.counters().sockets).toBe(0);
	});
	it("disconnects a socket the engine already tracks", async () => {
		// Arrange
		const a = await f.register();
		// Act
		const events = f.server.restore(a, storedFor(a));
		// Assert
		expect(events).toBeNull();
		expect(a.close).toHaveBeenCalledTimes(1);
	});
	it("closes both sockets when two restored sockets claim one device", async () => {
		// Arrange
		const a = await f.register();
		const server = wake();
		const first = fakeSocket(),
			second = fakeSocket();
		const restored = server.restore(first, storedFor(a));
		// Act
		const events = server.restore(second, storedFor(a));
		// Assert
		expect(restored).not.toBeNull();
		expect(events).toBeNull();
		expect(first.close).toHaveBeenCalledTimes(1);
	});
	it.each([
		[719_999, true],
		[720_000, false],
	])("renewal %i ms after acceptance closes a restored socket: %s", async (now, closes) => {
		// Arrange: a restored socket may renew exactly when the original socket could.
		const a = await f.register();
		const value = storedFor(a);
		f.clock.now = now;
		const socket = fakeSocket();
		const events = wake().restore(socket, value);
		if (!events) throw new Error("Restore denied");
		// Act
		await control(events, "SERVICE_CHALLENGE", { audienceId: f.options.namespace.relayAudienceId });
		// Assert
		expect(socket.close).toHaveBeenCalledTimes(closes ? 1 : 0);
		expect(socket.texts.some((message) => message.type === "SERVICE_PROOF")).toBe(!closes);
	});
	it("answers DATA for a lost route with one paid CLOSE abort per session", async () => {
		// Arrange
		const { socket, events } = await restoredSource();
		const controls = () =>
			f.quota.reserve.mock.calls.filter(([request]) => request.purpose === "control").length;
		const before = controls();
		// Act
		events.binary(data(8));
		events.binary(data(8));
		await settle();
		// Assert
		expect(socket.texts).toEqual([
			{ v: 1, type: "CLOSE", session: SESSION, body: { mode: "abort" } },
		]);
		expect(controls()).toBe(before + 1);
		expect(socket.close).not.toHaveBeenCalled();
	});
	it("disconnects a restored socket that names more lost sessions than device routes", async () => {
		// Arrange
		const { socket, events } = await restoredSource();
		// Act
		for (let i = 0; i < 5; i++) events.binary(data(8, i.toString(16).repeat(32)));
		await settle();
		// Assert
		expect(socket.close).toHaveBeenCalledTimes(1);
	});
	it("closes a restored socket when control quota cannot pay for the CLOSE abort", async () => {
		// Arrange
		const { socket, events } = await restoredSource();
		f.credits.control = 0;
		// Act
		events.binary(data(8));
		await settle();
		// Assert
		expect(socket.texts).toEqual([]);
		expect(socket.close).toHaveBeenCalledTimes(1);
	});
	it("disconnects on unknown DATA once the longest route lifetime has passed", async () => {
		// Arrange
		const { socket, events } = await restoredSource();
		f.clock.now += 60_000;
		// Act
		events.binary(data(8));
		await settle();
		// Assert
		expect(socket.texts).toEqual([]);
		expect(socket.close).toHaveBeenCalledTimes(1);
	});
	it("counts a closing claimant so a third socket cannot take the device", async () => {
		// Arrange: the conflict closes both sockets, and the first is still tearing down.
		const a = await f.register();
		const server = wake();
		const first = fakeSocket();
		server.restore(first, storedFor(a));
		server.restore(fakeSocket(), storedFor(a));
		const third = fakeSocket();
		// Act
		const events = server.restore(third, storedFor(a));
		// Assert
		expect(first.close).toHaveBeenCalledTimes(1);
		expect(events).toBeNull();
		expect(server.counters().sockets).toBe(1);
	});
	it("stops admitting routes at the restored registration's restore bound", async () => {
		// Arrange
		const a = await f.register(),
			b = await f.register("target");
		const value = storedFor(a);
		const server = wake();
		const a2 = fakeSocket();
		const events = server.restore(a2, value);
		server.restore(fakeSocket(), storedFor(b));
		if (!events) throw new Error("Restore denied");
		f.clock.now += value.restoreNotAfterUtcMs - f.clock.utcMs();
		// Act
		await events.text(bytes(encodeRelayControl(await f.openPacket())));
		await settle();
		// Assert
		expect(server.counters().routes).toBe(0);
		expect(a2.texts).toEqual([{ v: 1, type: "REJECTED", session: SESSION, body: {} }]);
	});
});
