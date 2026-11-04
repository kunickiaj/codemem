import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DENIAL,
	type RouteFixture,
	routeFixture,
} from "./coordinator-relay-admission-route-test-fixtures.js";
import { readRelayAdmissionReply } from "./relay-admission-reply.js";
import { createRelayCoordinatorClient } from "./relay-coordinator-client.js";

const fixtures: RouteFixture[] = [];
const servers: Server[] = [];
async function setup() {
	const h = await routeFixture();
	fixtures.push(h);
	return h;
}
afterEach(async () => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve, reject) =>
						server.close((error) => (error ? reject(error) : resolve())),
					),
			),
	);
	for (const h of fixtures.splice(0)) h.db.close();
});
const checkRequest = (h: RouteFixture) => ({
	packet: h.f.request.packet,
	deviceHeader: "source",
	signal: new AbortController().signal,
});
const client = () =>
	createRelayCoordinatorClient({
		url: "https://coordinator.example/trusted/v1/relay/admission-check",
	});

async function listen(h: RouteFixture, redirect = false) {
	const received: { path: string; headers: Headers; body: Uint8Array }[] = [];
	const server = createServer(async (incoming, outgoing) => {
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
			const headers = new Headers();
			for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
				const name = incoming.rawHeaders[i];
				const value = incoming.rawHeaders[i + 1];
				if (name === undefined || value === undefined) throw new Error("invalid raw headers");
				headers.append(name, value);
			}
			const body = new Uint8Array(Buffer.concat(chunks));
			received.push({ path: incoming.url ?? "", headers, body });
			if (redirect) {
				outgoing.writeHead(302, { Location: "/redirect-target" });
				outgoing.end();
				return;
			}
			const response = await h.app.request(
				new Request(`http://127.0.0.1${incoming.url}`, { method: incoming.method, headers, body }),
			);
			outgoing.writeHead(response.status, Object.fromEntries(response.headers));
			outgoing.end(Buffer.from(await response.arrayBuffer()));
		} catch {
			outgoing.writeHead(500);
			outgoing.end();
		}
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing loopback address");
	const url = `http://127.0.0.1:${address.port}${h.f.request.externalPathname}`;
	return { received, url };
}

describe("relay coordinator URL policy", () => {
	it.each([
		"https://coordinator.example/v1/relay/admission-check",
		"https://coordinator.example/prefix/v1/relay/admission-check",
		"http://127.0.0.1:1234/v1/relay/admission-check",
		"http://[::1]:1234/v1/relay/admission-check",
	])("accepts explicit endpoint %s without opening a connection", (url) => {
		// Arrange
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		// Act
		const result = createRelayCoordinatorClient({ url, allowLoopbackHttp: true });
		// Assert
		expect(typeof result.check).toBe("function");
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it.each([
		"invalid",
		"http://coordinator.example/v1/relay/admission-check",
		"http://localhost/v1/relay/admission-check",
		"https://user:password@coordinator.example/v1/relay/admission-check",
		"https://coordinator.example/v1/relay/admission-check?query=1",
		"https://coordinator.example/v1/relay/admission-check#fragment",
		"https://coordinator.example/wrong-path",
		"file:///v1/relay/admission-check",
	])("rejects endpoint %s", (url) => {
		// Arrange
		const options = { url, allowLoopbackHttp: true };
		// Act / Assert
		expect(() => createRelayCoordinatorClient(options)).toThrow();
	});
	it("requires explicit opt-in for loopback cleartext", () => {
		// Arrange
		const url = "http://127.0.0.1/v1/relay/admission-check";
		// Act / Assert
		expect(() => createRelayCoordinatorClient({ url })).toThrow(
			"Invalid relay coordinator endpoint",
		);
	});
});

describe("relay coordinator bounded reply handling", () => {
	it("posts exact signed bytes and v2 headers once and accepts a 1024-byte reply", async () => {
		// Arrange
		const h = await setup();
		const bytes = new Uint8Array(1024).fill(7);
		const fetchMock = vi.fn().mockResolvedValue(new Response(bytes));
		vi.stubGlobal("fetch", fetchMock);
		const request = checkRequest(h);
		// Act
		const reply = await client().check(request);
		// Assert
		expect(reply).toEqual(bytes);
		expect(fetchMock).toHaveBeenCalledOnce();
		const call = fetchMock.mock.calls[0];
		if (!call) throw new Error("missing fetch call");
		const [url, init] = call;
		expect(url).toBe("https://coordinator.example/trusted/v1/relay/admission-check");
		expect(init).toMatchObject({
			method: "POST",
			redirect: "error",
			signal: request.signal,
			body: h.f.bodyBytes,
		});
		expect(init.headers).toMatchObject({
			"X-Opencode-Device": "source",
			"X-Opencode-Timestamp": h.f.request.packet.timestamp,
			"X-Opencode-Nonce": h.f.nonce,
			"X-Opencode-Signature": h.f.request.packet.signature,
			"accept-encoding": "identity",
		});
	});
	it("sends through an injected fetcher instead of global fetch", async () => {
		// Arrange
		const h = await setup();
		const globalFetch = vi.fn();
		vi.stubGlobal("fetch", globalFetch);
		const fetcher = { fetch: vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2]))) };
		const request = checkRequest(h);
		// Act
		const reply = await createRelayCoordinatorClient({
			url: "https://coordinator.example/trusted/v1/relay/admission-check",
			fetcher,
		}).check(request);
		// Assert
		expect(reply).toEqual(new Uint8Array([1, 2]));
		expect(globalFetch).not.toHaveBeenCalled();
		expect(fetcher.fetch).toHaveBeenCalledOnce();
		expect(fetcher.fetch.mock.calls[0]?.[0]).toBe(
			"https://coordinator.example/trusted/v1/relay/admission-check",
		);
		expect(fetcher.fetch.mock.calls[0]?.[1]).toMatchObject({
			method: "POST",
			signal: request.signal,
			body: h.f.bodyBytes,
		});
	});
	it("denies when the injected fetcher rejects", async () => {
		// Arrange
		const h = await setup();
		const fetcher = { fetch: vi.fn().mockRejectedValue(new Error("binding unavailable")) };
		// Act
		const reply = await createRelayCoordinatorClient({
			url: "https://coordinator.example/v1/relay/admission-check",
			fetcher,
		}).check(checkRequest(h));
		// Assert
		expect(reply).toBeNull();
	});

	it.each(["oversize", "status", "absent-route", "read-error", "fetch-error", "no-body"])(
		"denies %s without retries and cancels readable reply streams",
		async (fault) => {
			// Arrange
			const h = await setup();
			const cancel = vi.fn();
			const stream = new ReadableStream<Uint8Array>({
				start(c) {
					if (fault === "read-error") c.error(new Error("private read detail"));
					else c.enqueue(new Uint8Array(1025));
				},
				cancel,
			});
			let status = 200;
			if (fault === "status") status = 503;
			if (fault === "absent-route") status = 404;
			const response = new Response(fault === "no-body" ? null : stream, { status });
			const fetchMock = vi.fn().mockResolvedValue(response);
			if (fault === "fetch-error")
				fetchMock.mockRejectedValue(new Error("private connection detail"));
			vi.stubGlobal("fetch", fetchMock);
			// Act
			const reply = await client().check(checkRequest(h));
			// Assert
			expect(reply).toBeNull();
			expect(fetchMock).toHaveBeenCalledOnce();
			if (["oversize", "status", "absent-route"].includes(fault))
				expect(cancel).toHaveBeenCalledOnce();
		},
	);

	it("does not fetch after cancellation or for a malformed packet", async () => {
		// Arrange
		const h = await setup();
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const aborted = checkRequest(h);
		aborted.signal = AbortSignal.abort();
		const malformed = checkRequest(h);
		malformed.packet = { ...malformed.packet, body: "invalid" };
		// Act
		const replies = [await client().check(aborted), await client().check(malformed)];
		// Assert
		expect(replies).toEqual([null, null]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("discards a reply when cancellation arrives during the response read", async () => {
		// Arrange
		const h = await setup();
		const controller = new AbortController();
		const stream = new ReadableStream<Uint8Array>({
			pull(c) {
				controller.abort();
				c.enqueue(new TextEncoder().encode(JSON.stringify(DENIAL)));
				c.close();
			},
		});
		const fetchMock = vi.fn().mockResolvedValue(new Response(stream));
		vi.stubGlobal("fetch", fetchMock);
		// Act
		const reply = await client().check({ ...checkRequest(h), signal: controller.signal });
		// Assert
		expect(reply).toBeNull();
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});

describe("loopback HTTP coordinator with actual signed SQLite decisions", () => {
	it("admits once and denies replay over HTTP without changing signed bytes or path", async () => {
		// Arrange
		const h = await setup();
		const { url, received } = await listen(h);
		const coordinator = createRelayCoordinatorClient({ url, allowLoopbackHttp: true });
		// Act
		const first = await coordinator.check(checkRequest(h));
		const second = await coordinator.check(checkRequest(h));
		// Assert
		expect(first).not.toBeNull();
		if (!(first instanceof Uint8Array) || !(second instanceof Uint8Array))
			throw new Error("missing HTTP reply bytes");
		expect(readRelayAdmissionReply(first, h.f.request.packet)).toMatchObject({
			decidedAtMs: 110_000,
			remainingMs: 45_000,
		});
		expect(JSON.parse(new TextDecoder().decode(second))).toEqual(DENIAL);
		expect(h.nonces()).toHaveLength(1);
		expect(received).toHaveLength(2);
		for (const request of received) {
			expect(request.path).toBe(h.f.request.externalPathname);
			expect(request.body).toEqual(h.f.bodyBytes);
			expect(request.headers.get("X-Opencode-Signature")).toBe(h.f.request.packet.signature);
		}
	});

	it("rejects a real HTTP redirect without following or retrying", async () => {
		// Arrange
		const h = await setup();
		const { url, received } = await listen(h, true);
		const coordinator = createRelayCoordinatorClient({ url, allowLoopbackHttp: true });
		// Act
		const result = await coordinator.check(checkRequest(h));
		// Assert
		expect(result).toBeNull();
		expect(received.map((r) => r.path)).toEqual([h.f.request.externalPathname]);
		expect(h.trace).toEqual([]);
	});
});
