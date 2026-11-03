import { afterEach, describe, expect, it } from "vitest";
import { decodeRelayCheckPacket } from "./relay-admission-codec.js";
import { readRelayAdmissionReply } from "./relay-admission-reply.js";
import { encodeRelayControl } from "./relay-control-codec.js";
import { integrationFixture } from "./relay-runtime.integration-test-fixtures.js";
import { data } from "./relay-server-test-fixtures.js";

let f: Awaited<ReturnType<typeof integrationFixture>> | undefined;
afterEach(async () => {
	await f?.dispose();
	f = undefined;
});

describe("relay server composition through HTTP admission and SQLite quota", () => {
	it("registers two WebSockets, checks three independent roles, and forwards ordered opaque DATA", async () => {
		// Arrange: this exercises relay composition, not a Noise handshake or full sync.
		f = await integrationFixture();
		const a = await f.register(),
			b = await f.register("target");
		const open = await f.signed.openPacket();
		const decoded = decodeRelayCheckPacket(open.body.checks[0]);
		if (decoded.kind !== "admission") throw new Error("Missing admission body");
		const sourcePacket = await f.signed.packet({ ...decoded.value, role: "source" });
		const sourceReply = await f.coordinator.check({
			packet: sourcePacket,
			deviceHeader: "source",
			signal: new AbortController().signal,
		});
		expect(sourceReply && readRelayAdmissionReply(sourceReply, sourcePacket)).not.toBeNull();
		// Act
		a.ws.send(encodeRelayControl(open));
		expect(await b.controlMessage()).toMatchObject({ type: "OPEN", session: open.session });
		const responderCheck = open.body.checks[1];
		const responderReply = await f.coordinator.check({
			packet: responderCheck,
			deviceHeader: "source",
			signal: new AbortController().signal,
		});
		expect(
			responderReply && readRelayAdmissionReply(responderReply, responderCheck),
		).not.toBeNull();
		b.control("ACCEPTED");
		expect(await a.controlMessage()).toMatchObject({ type: "ACCEPTED" });
		const frames = [data(1024, open.session, 149), data(65, open.session, 202)];
		for (const frame of frames) a.ws.send(frame);
		// Assert
		for (const frame of frames)
			expect(await b.next()).toEqual({ bytes: Buffer.from(frame), binary: true });
		expect(f.signed.coordinator.check).not.toHaveBeenCalled();
		expect(f.signed.quota.reserve).not.toHaveBeenCalled();
		expect(f.signed.db.prepare("SELECT COUNT(*) AS count FROM request_nonces").get()).toEqual({
			count: 5,
		});
		const admission = f.signed.db
			.prepare("SELECT units,granted,last_capacity FROM admission_budget_buckets")
			.all() as { units: number; granted: number; last_capacity: number }[];
		expect(admission.length).toBeGreaterThan(0);
		expect(
			admission.every((row) => row.units <= row.last_capacity - 60000 && row.granted === 1),
		).toBe(true);
		const traffic = f.quotaDb
			.prepare(
				"SELECT scope,balance,last_capacity FROM relay_quota_buckets WHERE purpose='traffic'",
			)
			.all() as { scope: string; balance: number; last_capacity: number }[];
		expect(traffic.map((row) => row.scope).sort()).toEqual([
			"device",
			"device",
			"pair",
			"realm",
			"service",
		]);
		expect(traffic.every((row) => row.balance < row.last_capacity)).toBe(true);
		expect(
			f.quotaDb
				.prepare("PRAGMA table_info(relay_quota_buckets)")
				.all()
				.map((row) => (row as { name: string }).name),
		).toEqual([
			"purpose",
			"scope",
			"subject",
			"balance",
			"refilled_at_ms",
			"last_rate",
			"last_capacity",
		]);
	});
});

describe("relay admission denial before DATA", () => {
	it.each(["root OPEN quota denied", "readiness paused"])(
		"rejects OPEN and forwards no DATA when %s",
		async (failure) => {
			// Arrange
			f = await integrationFixture();
			const a = await f.register(),
				b = await f.register("target");
			if (failure === "root OPEN quota denied")
				f.quotaDb
					.prepare(
						"UPDATE relay_quota_allocations SET rate=0,burst=0 WHERE purpose='open' AND scope='service'",
					)
					.run();
			else
				f.signed.db
					.prepare(
						"UPDATE relay_admission_readiness SET revision=revision+1,state='paused' WHERE scope='authority'",
					)
					.run();
			const received: unknown[] = [];
			b.ws.on("message", (message) => received.push(message));
			// Act
			a.ws.send(encodeRelayControl(await f.signed.openPacket()));
			expect(await a.controlMessage()).toMatchObject({ type: "REJECTED" });
			a.ws.send(data());
			await a.closed;
			await f.runtime.close();
			await b.closed;
			// Assert
			expect(received).toEqual([]);
			expect(f.runtime.counters()).toMatchObject({ sockets: 0, routes: 0, queuedBytes: 0 });
			expect(
				f.quotaDb
					.prepare("SELECT COUNT(*) AS count FROM relay_quota_buckets WHERE purpose='traffic'")
					.get(),
			).toEqual({ count: 0 });
		},
	);
});
