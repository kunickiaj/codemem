import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeRelayControl } from "./relay-control-codec.js";
import type { RelayServerOptions } from "./relay-server.js";
import {
	bytes,
	control,
	data,
	deferred,
	SESSION,
	serverFixture,
	settle,
	testSigner,
} from "./relay-server-test-fixtures.js";

type Diagnostic = Parameters<NonNullable<RelayServerOptions["onDiagnostic"]>>[0];
let f: Awaited<ReturnType<typeof serverFixture>>;
let diagnostics: Diagnostic[];

async function fixture(
	limits: Parameters<typeof serverFixture>[0] = {},
	onDiagnostic: NonNullable<RelayServerOptions["onDiagnostic"]> = (event) => {
		diagnostics.push(event);
	},
) {
	// The shared fixture accepts registration hooks and forwards all supplied hooks to the engine.
	const hooks = { onRegistration: undefined, onDiagnostic };
	return serverFixture(limits, hooks);
}
const rejected = () => diagnostics.filter((event) => event.event === "route_rejected");
const rejection = (reason: string, sessionId = SESSION) => ({
	event: "route_rejected",
	sessionId,
	reason,
});

beforeEach(async () => {
	vi.useFakeTimers();
	diagnostics = [];
	f = await fixture();
});
afterEach(() => {
	f.dispose();
	vi.useRealTimers();
});

describe("relay route decision diagnostics", () => {
	it("reports route transitions without registration secrets or per-frame DATA events", async () => {
		// Arrange
		const a = await f.register();
		const b = await f.register("target");
		const open = await f.openPacket();
		expect(diagnostics).toEqual([]);
		// Act
		await a.events.text(bytes(encodeRelayControl(open)));
		await control(b.events, "ACCEPTED");
		a.events.binary(data(3));
		await settle();
		b.written();
		await control(a.events, "CLOSE", { mode: "end" });
		await control(b.events, "CLOSE", { mode: "end" });
		// Assert: exact objects exclude device/group IDs, keys, envelopes and payloads.
		expect(diagnostics).toEqual([
			{ event: "route_opened", sessionId: SESSION },
			{ event: "route_forwarded", sessionId: SESSION },
			{ event: "route_accepted", sessionId: SESSION },
			{ event: "route_closed", sessionId: SESSION, reason: "route_completed" },
		]);
		expect(b.texts.find((message) => message.type === "OPEN")).toEqual(open);
		expect(b.binaries).toEqual([data(3)]);
		expect(f.server.counters().routes).toBe(0);
	});
	it("reports an absent target while preserving the generic wire rejection", async () => {
		// Arrange
		const a = await f.register();
		const open = await f.openPacket();
		// Act
		await a.events.text(bytes(encodeRelayControl(open)));
		// Assert
		expect(rejected()).toEqual([rejection("target_registration_absent")]);
		expect(a.texts.at(-1)).toEqual({ v: 1, type: "REJECTED", session: SESSION, body: {} });
		expect(f.server.counters().routes).toBe(0);
	});
	it.each(["denied", "unavailable", "exception"])(
		"reports coordinator %s as admission_check_failed without exception contents",
		async (failure) => {
			// Arrange
			const a = await f.register();
			const b = await f.register("target");
			const open = await f.openPacket();
			if (failure === "exception") {
				f.coordinator.check.mockRejectedValueOnce(new Error("private coordinator URL and token"));
			} else {
				f.coordinator.check.mockResolvedValueOnce(
					failure === "denied" ? bytes('{"v":1,"eligible":false}') : (null as never),
				);
			}
			// Act
			await a.events.text(bytes(encodeRelayControl(open)));
			// Assert
			expect(rejected()).toEqual([rejection("admission_check_failed")]);
			expect(b.texts.some((message) => message.type === "OPEN")).toBe(false);
			expect(a.texts.at(-1)).toEqual({ v: 1, type: "REJECTED", session: SESSION, body: {} });
		},
	);
	it("reports a registered target key mismatch after a positive admission check", async () => {
		// Arrange: rotate trusted enrollment after the target registered with its original key.
		const a = await f.register();
		const b = await f.register("target");
		const rotated = testSigner(4);
		f.db
			.prepare("UPDATE enrolled_devices SET public_key = ?, fingerprint = ? WHERE device_id = ?")
			.run(rotated.publicKey, rotated.keyId, "target");
		const open = await f.openPacket({ targetKeyId: rotated.keyId });
		// Act
		await a.events.text(bytes(encodeRelayControl(open)));
		// Assert
		expect(rejected()).toEqual([rejection("target_key_mismatch")]);
		expect(b.texts.some((message) => message.type === "OPEN")).toBe(false);
		expect(f.server.counters().routes).toBe(0);
	});
	it("reports explicit target rejection without reporting acceptance", async () => {
		// Arrange
		const { a, b } = await f.route({ accepted: false });
		// Act
		await control(b.events, "REJECTED");
		// Assert
		expect(rejected()).toEqual([rejection("target_rejected")]);
		expect(diagnostics.some((event) => event.event === "route_accepted")).toBe(false);
		expect(a.texts.at(-1)).toEqual({ v: 1, type: "REJECTED", session: SESSION, body: {} });
		expect(f.server.counters().routes).toBe(0);
	});
});

describe("relay route reservation diagnostics", () => {
	it.each(["denied", "unknown"] as const)("reports %s OPEN quota", async (status) => {
		// Arrange
		const a = await f.register();
		const b = await f.register("target");
		const open = await f.openPacket();
		const reserve = f.quota.reserve.getMockImplementation();
		if (!reserve) throw new Error("Missing quota fixture");
		f.quota.reserve.mockImplementation((request, signal) =>
			request.purpose === "open" ? Promise.resolve(status) : reserve(request, signal),
		);
		// Act
		await a.events.text(bytes(encodeRelayControl(open)));
		// Assert
		expect(rejected()).toEqual([rejection("open_quota_rejected")]);
		expect(b.texts.some((message) => message.type === "OPEN")).toBe(false);
		expect(f.coordinator.check).toHaveBeenCalledTimes(2);
	});
	it.each([
		["duplicate_session", {}, SESSION],
		["route_capacity", { routes: 1 }, "2".repeat(32)],
		["device_route_capacity", { deviceRoutes: 1 }, "2".repeat(32)],
		["parallel_route", {}, "2".repeat(32)],
	] as const)("reports %s while preserving the existing route", async (reason, limits, session) => {
		// Arrange
		f.dispose();
		f = await fixture(limits);
		const { a, b } = await f.route();
		const open = await f.openPacket({}, session);
		// Act
		await a.events.text(bytes(encodeRelayControl(open)));
		a.events.binary(data());
		await settle();
		// Assert
		expect(rejected()).toEqual([rejection(reason, session)]);
		expect(f.server.counters().routes).toBe(1);
		expect(b.binaries).toEqual([data()]);
		expect(a.close).not.toHaveBeenCalled();
	});
	it.each([
		["sourceKeyId", "0".repeat(64), "source_binding_mismatch"],
		["groupId", "other", "admission_context_invalid"],
	] as const)("reports invalid %s before forwarding", async (field, value, reason) => {
		// Arrange
		const a = await f.register();
		const b = await f.register("target");
		const open = await f.openPacket({ [field]: value });
		// Act
		await a.events.text(bytes(encodeRelayControl(open)));
		// Assert
		expect(rejected()).toEqual([rejection(reason)]);
		expect(b.texts.some((message) => message.type === "OPEN")).toBe(false);
		expect(f.coordinator.check).toHaveBeenCalledTimes(2);
	});
	it("reports expiry without acceptance and removes the pending route once", async () => {
		// Arrange
		await f.route({ accepted: false });
		// Act
		f.clock.now = 45000;
		await vi.advanceTimersByTimeAsync(45000);
		// Assert
		expect(rejected()).toEqual([rejection("route_expired")]);
		expect(diagnostics.filter((event) => event.event === "route_accepted")).toHaveLength(0);
		expect(f.server.counters().routes).toBe(0);
	});
	it("reports unavailable source registration before spending OPEN quota", async () => {
		// Arrange
		const a = await f.register();
		const open = await f.openPacket();
		f.clock.now = 900000;
		// Act
		await a.events.text(bytes(encodeRelayControl(open)));
		// Assert
		expect(rejected()).toEqual([rejection("source_registration_unavailable")]);
		expect(f.quota.reserve.mock.calls.some(([request]) => request.purpose === "open")).toBe(false);
		expect(f.server.counters().routes).toBe(0);
	});
});

describe("diagnostic observer isolation", () => {
	it.each(["disabled", "throws", "rejects", "mutates"])(
		"preserves a generic rejection when the observer %s",
		async (mode) => {
			// Arrange
			f.dispose();
			const observer = vi.fn((event: Diagnostic) => {
				if (mode === "throws") throw new Error("private diagnostic exception");
				if (mode === "rejects") return Promise.reject(new Error("private async exception"));
				if (mode === "mutates") Object.assign(event, { sessionId: "0".repeat(32) });
			});
			f = mode === "disabled" ? await serverFixture() : await fixture({}, observer);
			const a = await f.register();
			const open = await f.openPacket();
			// Act
			await a.events.text(bytes(encodeRelayControl(open)));
			await settle();
			// Assert
			expect(a.texts.at(-1)).toEqual({ v: 1, type: "REJECTED", session: SESSION, body: {} });
			expect(f.server.counters().routes).toBe(0);
			expect(a.close).not.toHaveBeenCalled();
			if (mode !== "disabled") expect(observer).toHaveBeenCalled();
		},
	);
	it.each(["disabled", "throws", "rejects", "pending", "mutates"])(
		"preserves forwarding, acceptance and cleanup when the observer %s",
		async (mode) => {
			// Arrange
			f.dispose();
			const pending = deferred<void>();
			const observer = vi.fn((event: Diagnostic) => {
				if (mode === "throws") throw new Error("private diagnostic exception");
				if (mode === "rejects") return Promise.reject(new Error("private async exception"));
				if (mode === "pending") return pending.promise;
				if (mode === "mutates") {
					Object.assign(event, { event: "invalid", sessionId: "0".repeat(32), reason: "private" });
				}
			});
			f = mode === "disabled" ? await serverFixture() : await fixture({}, observer);
			const a = await f.register();
			const b = await f.register("target");
			const open = await f.openPacket();
			// Act
			await a.events.text(bytes(encodeRelayControl(open)));
			await control(b.events, "ACCEPTED");
			a.events.binary(data());
			await settle();
			b.written();
			await control(a.events, "CLOSE", { mode: "end" });
			await control(b.events, "CLOSE", { mode: "end" });
			pending.resolve();
			await settle();
			// Assert
			expect(b.texts.find((message) => message.type === "OPEN")).toEqual(open);
			expect(a.texts.find((message) => message.type === "ACCEPTED")).toEqual({
				v: 1,
				type: "ACCEPTED",
				session: SESSION,
				body: {},
			});
			expect(b.binaries).toEqual([data()]);
			expect(f.server.counters().routes).toBe(0);
			expect(a.close).not.toHaveBeenCalled();
			expect(b.close).not.toHaveBeenCalled();
			if (mode !== "disabled") expect(observer).toHaveBeenCalled();
		},
	);
});
