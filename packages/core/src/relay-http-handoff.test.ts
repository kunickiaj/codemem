import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { createPeerHttpExecutor } from "./peer-http-client.js";
import { servePeerHttpConnection } from "./peer-http-server.js";
import {
	captureServerWire,
	ORIGIN,
	requestWire,
	serverNoisePair,
	writeServerRequest,
} from "./peer-http-server-test-fixtures.js";
import { relayClientFixture, relayDeadline } from "./relay-peer-client-test-fixtures.js";

it.each(["GET", "POST"])("serves an early unread authenticated %s request", async (method) => {
	const pair = await serverNoisePair();
	const response = captureServerWire(pair.source);
	const dispatch = vi.fn(async () => ({ status: 200, bodyBytes: Buffer.from("{}") }));
	try {
		const readable = once(pair.target, "readable");
		const request = requestWire({ method });
		await writeServerRequest(pair.source, request);
		await readable;
		expect(pair.target.readableLength).toBe(request.length);
		expect(pair.target.readableFlowing).not.toBe(true);
		expect(pair.target.destroyed).toBe(false);
		const serving = servePeerHttpConnection(pair.targetOwner, { origin: ORIGIN, dispatch });
		pair.source.end();
		const wire = await response.complete;
		await serving;
		expect(wire.toString("latin1")).toMatch(/^HTTP\/1\.1 200 /);
		expect(dispatch).toHaveBeenCalledOnce();
	} finally {
		await pair.close();
	}
});

it.each(["prefix", "all", "flow-drain", "read-and-replace", "push", "unshift", "encoding"])(
	"rejects a target altered by %s before HTTP attachment",
	async (action) => {
		const pair = await serverNoisePair();
		const request = requestWire();
		const dispatch = vi.fn(async () => ({ status: 200, bodyBytes: Buffer.from("{}") }));
		try {
			const readable = once(pair.target, "readable");
			await writeServerRequest(pair.source, request);
			await readable;
			if (action === "prefix") pair.target.read(1);
			if (action === "all") {
				pair.target.read();
				expect(pair.target.readableLength).toBe(0);
			}
			if (action === "flow-drain") {
				const data = once(pair.target, "data");
				pair.target.resume();
				await data;
				pair.target.pause();
				expect(pair.target.readableLength).toBe(0);
			}
			if (action === "read-and-replace") {
				const bytes = pair.target.read(1);
				pair.target.push(bytes);
				expect(pair.target.readableLength).toBe(request.length);
			}
			if (action === "push") pair.target.push(Buffer.from("injected"));
			if (action === "unshift") pair.target.unshift(Buffer.from("injected"));
			if (action === "encoding") pair.target.setEncoding("utf8");
			await expect(
				servePeerHttpConnection(pair.targetOwner, { origin: ORIGIN, dispatch }),
			).rejects.toMatchObject({ code: "transport" });
			expect(dispatch).not.toHaveBeenCalled();
			expect(pair.targetOwner.dispose).toHaveBeenCalledOnce();
		} finally {
			await pair.close();
		}
	},
);

it.each(["unread", "consumed"])(
	"handles an early %s request through a real relay",
	async (state) => {
		const fixture = await relayClientFixture();
		const failure = vi.fn();
		const dispatch = vi.fn(async () => ({ status: 200, bodyBytes: Buffer.from("{}") }));
		const target = fixture.client("target", {
			onInboundFailure: failure,
			onInbound: async (connection, context) => {
				if (connection.duplex.readableLength === 0) await once(connection.duplex, "readable");
				if (state === "consumed") connection.duplex.read();
				await context.serve({ origin: ORIGIN, dispatch });
			},
		});
		try {
			await target.connect(new AbortController().signal, relayDeadline());
			const source = fixture.client("source");
			const factory = source.factory("target", fixture.identities.target.expectedPin);
			const execute = createPeerHttpExecutor({ factory });
			if (state === "unread") {
				await expect(execute("GET", `${ORIGIN}/sync/status`)).resolves.toEqual([200, {}]);
				expect(failure).not.toHaveBeenCalled();
				expect(factory.failureReason()).toBeUndefined();
				expect(dispatch).toHaveBeenCalledOnce();
				return;
			}
			await expect(execute("GET", `${ORIGIN}/sync/status`)).rejects.toMatchObject({
				code: "transport",
			});
			expect(factory.failureReason()).toBe("relay_aborted");
			expect(failure).toHaveBeenCalledWith({
				stage: "http",
				reason: "relay_record_invalid",
				httpCode: "transport",
			});
			expect(dispatch).not.toHaveBeenCalled();
		} finally {
			await fixture.dispose();
		}
	},
);

it.each(["malformed", "double"])(
	"rejects an early %s request through the wire audit",
	async (kind) => {
		const pair = await serverNoisePair();
		const dispatch = vi.fn(async () => ({ status: 200, bodyBytes: Buffer.from("{}") }));
		const wire =
			kind === "double"
				? Buffer.concat([requestWire(), requestWire()])
				: requestWire({ method: "DELETE" });
		try {
			const readable = once(pair.target, "readable");
			await writeServerRequest(pair.source, wire);
			await readable;
			const serving = servePeerHttpConnection(pair.targetOwner, { origin: ORIGIN, dispatch });
			pair.source.end();
			await expect(serving).rejects.toMatchObject({ code: "framing" });
			expect(dispatch).not.toHaveBeenCalled();
		} finally {
			await pair.close();
		}
	},
);

it("allows only one HTTP claim on a Noise duplex", async () => {
	const pair = await serverNoisePair();
	const dispatch = vi.fn(async () => ({ status: 200, bodyBytes: Buffer.from("{}") }));
	try {
		expect(pair.target.claimFreshPlaintext()).toBe(true);
		expect(pair.target.claimFreshPlaintext()).toBe(false);
		await expect(
			servePeerHttpConnection(pair.targetOwner, { origin: ORIGIN, dispatch }),
		).rejects.toMatchObject({ code: "transport" });
		expect(dispatch).not.toHaveBeenCalled();
		expect(pair.targetOwner.dispose).toHaveBeenCalledOnce();
	} finally {
		await pair.close();
	}
});
