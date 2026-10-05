import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { requestJson } from "./sync-http-client.js";

const ADMIN_SECRET = "synthetic-admin-secret";
const ADMIN_HEADERS = { "X-Codemem-Coordinator-Admin": ADMIN_SECRET };

interface ReceivedRequest {
	method: string | undefined;
	path: string | undefined;
	admin: string | string[] | undefined;
	connection: string | undefined;
}

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected loopback TCP address");
	return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
	if (!server.listening) return;
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
		server.closeAllConnections();
	});
}

// Owned loopback receivers replace both external origins. No coordinator app,
// live configuration, credentials, dispatcher changes, or timing sleeps.
async function withOrigins(
	options: { status: number; sameOrigin?: boolean },
	run: (fixture: {
		url: string;
		sourceRequests: ReceivedRequest[];
		sinkRequests: ReceivedRequest[];
	}) => Promise<void>,
): Promise<void> {
	const { status, sameOrigin = false } = options;
	const sourceRequests: ReceivedRequest[] = [];
	const sinkRequests: ReceivedRequest[] = [];
	const sink = createServer((req, res) => {
		sinkRequests.push({
			method: req.method,
			path: req.url,
			admin: req.headers["x-codemem-coordinator-admin"],
			connection: req.headers.connection,
		});
		req.resume();
		res.setHeader("Content-Type", "application/json");
		res.end('{"ok":true}');
	});
	let destination = "";
	const source = createServer((req, res) => {
		const received = {
			method: req.method,
			path: req.url,
			admin: req.headers["x-codemem-coordinator-admin"],
			connection: req.headers.connection,
		};
		req.resume();
		if (req.url === "/sink") {
			sinkRequests.push(received);
			res.setHeader("Content-Type", "application/json");
			res.end('{"ok":true}');
			return;
		}
		sourceRequests.push(received);
		res.statusCode = status;
		if (status !== 200) res.setHeader("Location", destination);
		res.setHeader("Content-Type", "application/json");
		res.end('{"ok":true}');
	});
	try {
		const sinkUrl = await listen(sink);
		const sourceUrl = await listen(source);
		destination = sameOrigin ? "/sink" : `${sinkUrl}/sink`;
		await run({ url: `${sourceUrl}/admin`, sourceRequests, sinkRequests });
	} finally {
		await Promise.all([close(source), close(sink)]);
	}
}

describe("requestJson admin redirect wire policy", () => {
	it.each(
		[301, 302, 303, 307, 308].flatMap((status) =>
			["GET", "POST"].map((method) => ({ status, method })),
		),
	)(
		"rejects cross-origin $status redirects for admin $method without contacting the sink",
		async ({ status, method }) => {
			// Arrange: the initial origin may receive its configured credential.
			await withOrigins({ status }, async ({ url, sourceRequests, sinkRequests }) => {
				// Act: capture failure before assertions so sink evidence is always checked.
				const failure = await requestJson(method, url, {
					headers: ADMIN_HEADERS,
					body: method === "POST" ? { action: "sample" } : undefined,
				}).then(
					() => undefined,
					(error: unknown) => error,
				);

				// Assert: not stripping the secret after following, but no follow at all.
				expect(sourceRequests).toHaveLength(1);
				expect(sourceRequests[0]).toMatchObject({ method, admin: ADMIN_SECRET });
				expect(sinkRequests).toEqual([]);
				expect(failure).toBeInstanceOf(TypeError);
				expect(String(failure)).not.toContain(ADMIN_SECRET);
				if (failure instanceof Error) {
					expect(String(failure.cause)).not.toContain(ADMIN_SECRET);
				}
			});
		},
	);

	it("rejects same-origin redirects rather than using an origin allowlist", async () => {
		// Arrange
		await withOrigins(
			{ status: 307, sameOrigin: true },
			async ({ url, sourceRequests, sinkRequests }) => {
				// Act
				const failure = await requestJson("POST", url, {
					headers: ADMIN_HEADERS,
					body: { action: "sample" },
				}).catch((error: unknown) => error);

				// Assert
				expect(sourceRequests).toHaveLength(1);
				expect(sinkRequests).toEqual([]);
				expect(failure).toBeInstanceOf(TypeError);
			},
		);
	});

	it("still accepts a nonredirect admin response", async () => {
		// Arrange
		await withOrigins({ status: 200 }, async ({ url, sourceRequests, sinkRequests }) => {
			// Act
			const result = await requestJson("POST", url, {
				headers: ADMIN_HEADERS,
				body: { action: "sample" },
			});

			// Assert
			expect(result).toEqual([200, { ok: true }]);
			expect(sourceRequests).toHaveLength(1);
			expect(sourceRequests[0]).toMatchObject({ method: "POST", admin: ADMIN_SECRET });
			expect(sinkRequests).toEqual([]);
		});
	});

	it.each<Record<string, string>>([
		{},
		{ "X-Codemem-Coordinator-Admin-Actor": "synthetic-audit-actor" },
		{ "X-Opencode-Signature": "v2:synthetic-signature" },
		{ "X-Codemem-Recipient": "peer-b", "X-Codemem-Signature": "v3:synthetic-signature" },
		{ Authorization: "Bearer synthetic-legacy-token" },
	])("still follows non-admin redirects with headers %j", async (headers) => {
		// Arrange
		await withOrigins({ status: 307 }, async ({ url, sourceRequests, sinkRequests }) => {
			// Act
			const result = await requestJson("POST", url, { headers, body: { action: "sample" } });

			// Assert: real fetch preserves POST for 307 and direct-peer isolation.
			expect(result).toEqual([200, { ok: true }]);
			expect(sourceRequests).toHaveLength(1);
			expect(sinkRequests).toHaveLength(1);
			expect(sinkRequests[0]).toMatchObject({ method: "POST", admin: undefined });
			if ("X-Codemem-Recipient" in headers) {
				expect(sourceRequests[0].connection).toBe("close");
				expect(sinkRequests[0].connection).toBe("close");
			}
		});
	});
});
