import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { requestJson } from "./sync-http-client.js";

// A controlled loopback receiver replaces the external peer. Its separate event
// loop can expire idle sockets while the sender is blocked. The short actual
// deadline and longer advertised lifetime model a peer/proxy closing earlier
// than the client's pool expects, without waiting for production-scale timeouts.
const RECEIVER_SOURCE = `
import { createServer } from "node:http";
const requests = [];
const sockets = new WeakMap();
let nextSocket = 0;
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  requests.push({
    method: req.method,
    path: req.url,
    connection: req.headers.connection,
    socket: sockets.get(req.socket),
    body,
  });
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Keep-Alive", "timeout=10");
  res.end(JSON.stringify({ ok: true, requests }));
});
server.keepAliveTimeout = 80;
server.keepAliveTimeoutBuffer = 0;
server.on("connection", socket => sockets.set(socket, ++nextSocket));
server.listen(0, "127.0.0.1", () => process.send({ port: server.address().port }));
process.on("SIGTERM", () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
`;

interface ReceivedRequest {
	method: string;
	path: string;
	connection: string;
	socket: number;
	body: string;
}

describe("requestJson direct-peer socket isolation", () => {
	it("uses fresh closed connections for GET, scoped GET, and POST across sender stalls", async () => {
		// Arrange: no external service, global dispatcher changes, or fake clocks.
		const receiver = spawn(process.execPath, ["--input-type=module", "--eval", RECEIVER_SOURCE], {
			stdio: ["ignore", "ignore", "inherit", "ipc"],
		});
		try {
			const [ready] = await once(receiver, "message", { signal: AbortSignal.timeout(2_000) });
			const baseUrl = `http://127.0.0.1:${(ready as { port: number }).port}`;
			const headers = { "X-Codemem-Recipient": "peer-b" };
			const bodyBytes = new TextEncoder().encode('{ "ops": [] }\n');
			const stall = new Int32Array(new SharedArrayBuffer(4));

			// Act: the receiver keeps running during each synchronous sender stall.
			const first = await requestJson("GET", `${baseUrl}/sync`, { headers });
			Atomics.wait(stall, 0, 0, 200);
			const scoped = await requestJson("GET", `${baseUrl}/sync?scope=sample`, { headers });
			Atomics.wait(stall, 0, 0, 200);
			const post = await requestJson("POST", `${baseUrl}/sync`, { headers, bodyBytes });

			// Assert: wire policy and socket identity, not merely elapsed time/success.
			expect(first).toMatchObject([200, { ok: true }]);
			expect(scoped).toMatchObject([200, { ok: true }]);
			expect(post).toMatchObject([200, { ok: true }]);
			const requests = post[1]?.requests as ReceivedRequest[];
			expect(requests).toEqual([
				{ method: "GET", path: "/sync", connection: "close", socket: 1, body: "" },
				{ method: "GET", path: "/sync?scope=sample", connection: "close", socket: 2, body: "" },
				{
					method: "POST",
					path: "/sync",
					connection: "close",
					socket: 3,
					body: new TextDecoder().decode(bodyBytes),
				},
			]);
		} finally {
			if (receiver.exitCode === null && receiver.signalCode === null) {
				const exited = once(receiver, "exit");
				const forceExit = setTimeout(() => receiver.kill("SIGKILL"), 1_000);
				receiver.kill("SIGTERM");
				try {
					await exited;
				} finally {
					clearTimeout(forceExit);
				}
			}
		}
	}, 10_000);
});
