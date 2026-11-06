import { request } from "node:http";
import type { AddressInfo } from "node:net";
import type { MemoryStore } from "@codemem/core";
import { serve } from "@hono/node-server";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./index.js";
import type { ViewerAuthorityOptions } from "./viewer-authority.js";

const PORT = 49152;
const AUTHORITY = `127.0.0.1:${PORT}`;
const ORIGIN = `http://${AUTHORITY}`;

function fixture(
	getListenerAddress: ViewerAuthorityOptions["getListenerAddress"] = () => ({
		host: "127.0.0.1",
		port: PORT,
	}),
) {
	// A rejected request must never reach a database or any mutation handler.
	const storeFactory = vi.fn<() => MemoryStore>(() => {
		throw new Error("Synthetic store is deliberately unavailable");
	});
	const app = createApp({
		storeFactory,
		accountLink: { getListenerAddress },
		viewerAuthority: { getListenerAddress },
	});
	const mutate = vi.fn(() => new Response(null, { status: 204 }));
	app.post("/authority-probe", mutate);
	return { app, storeFactory, mutate };
}

describe("viewer authority on a trusted loopback listener", () => {
	it.each([
		["127.0.0.1", "127.0.0.1"],
		["127.0.0.1", "localhost"],
		["127.0.0.2", "127.0.0.2"],
		["127.1", "127.0.0.1"],
		["127.1", "localhost"],
		["::ffff:127.0.0.1", "[::ffff:7f00:1]"],
		["::ffff:127.0.0.1", "localhost"],
		["::1", "[::1]"],
		["::1", "localhost"],
		["localhost", "127.0.0.1"],
		["localhost", "[::1]"],
		["localhost", "localhost"],
	])("allows %s listener alias %s without an Origin", async (host, alias) => {
		const { app, storeFactory } = fixture(() => ({ host, port: PORT }));
		const authority = `${alias}:${PORT}`;

		const response = await app.request(`http://${authority}/api/health`, {
			headers: { Host: authority },
		});

		expect(response.status).toBe(200);
		expect(storeFactory).toHaveBeenCalledOnce();
	});

	it.each(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"])(
		"rejects attacker authority on %s before routes and preflight",
		async (method) => {
			const { app, storeFactory, mutate } = fixture();

			const response = await app.request(`http://attacker.example.test:${PORT}/api/health`, {
				method,
				headers: { Host: `attacker.example.test:${PORT}`, Origin: ORIGIN },
			});

			expect(response.status).toBe(403);
			expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
			expect(storeFactory).not.toHaveBeenCalled();
			expect(mutate).not.toHaveBeenCalled();
		},
	);

	it.each([
		["missing Host", ORIGIN, undefined],
		["wrong Host port", ORIGIN, "127.0.0.1:49153"],
		["missing nondefault port", ORIGIN, "127.0.0.1"],
		["wrong URL port", "http://127.0.0.1:49153", AUTHORITY],
		["Host and URL aliases disagree", `http://localhost:${PORT}`, AUTHORITY],
		["attacker URL with local Host", `http://attacker.example.test:${PORT}`, AUTHORITY],
		["attacker Host with local URL", ORIGIN, `attacker.example.test:${PORT}`],
		["other loopback alias", `http://127.0.0.2:${PORT}`, `127.0.0.2:${PORT}`],
		["Host with credentials", ORIGIN, `user@${AUTHORITY}`],
		["Host with path", ORIGIN, `${AUTHORITY}/ignored`],
		["Host with comma", ORIGIN, `${AUTHORITY},attacker.example.test`],
		["Host with invalid port", ORIGIN, "127.0.0.1:not-a-port"],
		["raw numeric Host shorthand", ORIGIN, `127.1:${PORT}`],
	])("rejects %s", async (_name, url, host) => {
		const { app, storeFactory } = fixture();
		const headers = new Headers();
		if (host !== undefined) headers.set("Host", host);

		const response = await app.request(`${url}/api/health`, { headers });

		expect(response.status).toBe(403);
		expect(storeFactory).not.toHaveBeenCalled();
	});

	it.each(["GET", "HEAD", "OPTIONS"])("allows valid %s authority", async (method) => {
		const { app } = fixture();

		const response = await app.request(`${ORIGIN}/api/health`, {
			method,
			headers: { Host: AUTHORITY, Origin: ORIGIN },
		});

		expect(response.status).toBe(method === "OPTIONS" ? 204 : 200);
	});

	it.each([AUTHORITY, "attacker.example.test:49152"])(
		"ignores forwarding headers when the actual Host is %s",
		async (host) => {
			const { app } = fixture();
			const forwardedHost = host === AUTHORITY ? "attacker.example.test:49152" : AUTHORITY;

			const response = await app.request(`http://${host}/api/health`, {
				headers: {
					Host: host,
					Forwarded: `host="${forwardedHost}";proto=http`,
					"X-Forwarded-Host": forwardedHost,
					"X-Forwarded-Port": String(PORT),
					"X-Forwarded-Proto": "http",
				},
			});

			expect(response.status).toBe(host === AUTHORITY ? 200 : 403);
		},
	);

	it.each(["127.0.0.1", "127.0.0.1:80"])("accepts canonical HTTP port 80 Host %s", async (host) => {
		const { app } = fixture(() => ({ host: "127.0.0.1", port: 80 }));

		const response = await app.request("http://127.0.0.1:80/api/health", {
			headers: { Host: host },
		});

		expect(response.status).toBe(200);
	});
});

describe("viewer authority uses the actual bound address", () => {
	it.each(["GET", "HEAD", "OPTIONS"])(
		"rejects hostile %s before handlers and preflight for custom DNS bound to loopback",
		async (method) => {
			// Arrange: emulate DNS resolution through trusted listener metadata, never real DNS.
			const { app, storeFactory, mutate } = fixture(() => ({
				host: "viewer.example.test",
				port: PORT,
				address: "127.0.0.1",
			}));
			const hostile = `attacker.example.test:${PORT}`;

			// Act
			const response = await app.request(`http://${hostile}/api/health`, {
				method,
				headers: { Host: hostile, Origin: ORIGIN },
			});

			// Assert: OPTIONS must not reach the CORS preflight response either.
			expect(response.status).toBe(403);
			expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
			expect(storeFactory).not.toHaveBeenCalled();
			expect(mutate).not.toHaveBeenCalled();
		},
	);

	it.each(["viewer.example.test", "127.0.0.1", "localhost"])(
		"allows intentional alias %s for custom DNS bound to loopback",
		async (alias) => {
			// Arrange
			const { app, storeFactory } = fixture(() => ({
				host: "viewer.example.test",
				port: PORT,
				address: "127.0.0.1",
			}));
			const authority = `${alias}:${PORT}`;

			// Act
			const response = await app.request(`http://${authority}/api/health`, {
				headers: { Host: authority },
			});

			// Assert
			expect(response.status).toBe(200);
			expect(storeFactory).toHaveBeenCalledOnce();
		},
	);

	it.each(["127.0.0.1", "[::1]", "localhost"])(
		"retains configured localhost alias %s with an actual IPv4 address",
		async (alias) => {
			// Arrange
			const { app } = fixture(() => ({ host: "localhost", port: PORT, address: "127.0.0.1" }));
			const authority = `${alias}:${PORT}`;

			// Act
			const response = await app.request(`http://${authority}/api/health`, {
				headers: { Host: authority },
			});

			// Assert
			expect(response.status).toBe(200);
		},
	);

	it.each(["0.0.0.0", "::", "192.0.2.10", "::ffff:192.0.2.1"])(
		"retains external behavior when the actual address is %s",
		async (address) => {
			// Arrange: classification follows the bound IP even for a configured local name.
			const { app, storeFactory } = fixture(() => ({ host: "localhost", port: PORT, address }));

			// Act
			const response = await app.request("http://external.example.test/api/health", {
				headers: { Host: "external.example.test" },
			});

			// Assert
			expect(response.status).toBe(200);
			expect(storeFactory).toHaveBeenCalledOnce();
		},
	);

	it.each(["", "localhost", "127.1", "127.0.0.1:49152", "[::1]", "invalid address"])(
		"fails closed for malformed actual address %j",
		async (address) => {
			// Arrange: a bad actual address must not enable external-listener behavior.
			const { app, storeFactory } = fixture(() => ({
				host: "viewer.example.test",
				port: PORT,
				address,
			}));

			// Act
			const response = await app.request(`${ORIGIN}/api/health`, { headers: { Host: AUTHORITY } });

			// Assert
			expect(response.status).toBe(403);
			expect(storeFactory).not.toHaveBeenCalled();
		},
	);
});

describe("viewer authority listener lifecycle and embedding", () => {
	it("preserves configured DNS classification for callbacks without an actual address", async () => {
		// Arrange: older embedders provide only the configured hostname and port.
		const { app, storeFactory } = fixture(() => ({ host: "viewer.example.test", port: PORT }));

		// Act
		const response = await app.request("http://external.example.test/api/health", {
			headers: { Host: "external.example.test" },
		});

		// Assert
		expect(response.status).toBe(200);
		expect(storeFactory).toHaveBeenCalledOnce();
	});

	it.each([AUTHORITY, "attacker.example.test:49152"])(
		"uses the account listener fallback when viewer authority options are absent: %s",
		async (host) => {
			// Arrange: keep coverage of embedders that use the original account callback only.
			const app = createApp({
				accountLink: { getListenerAddress: () => ({ host: "127.0.0.1", port: PORT }) },
			});

			// Act
			const response = await app.request(`http://${host}/`, { headers: { Host: host } });

			// Assert
			expect(response.status).toBe(host === AUTHORITY ? 200 : 403);
		},
	);

	it.each([null, { host: "127.0.0.1", port: 0 }, { host: "127.0.0.1", port: 65536 }])(
		"fails closed when the listener is not usable: %j",
		async (address) => {
			const { app, storeFactory } = fixture(() => address);

			const response = await app.request(`${ORIGIN}/api/health`, { headers: { Host: AUTHORITY } });

			expect(response.status).toBe(403);
			expect(storeFactory).not.toHaveBeenCalled();
		},
	);

	it("fails closed when the configured listener callback throws", async () => {
		const { app, storeFactory } = fixture(() => {
			throw new Error("Synthetic listener failure");
		});

		const response = await app.request(`${ORIGIN}/api/health`, { headers: { Host: AUTHORITY } });

		expect(response.status).toBe(403);
		expect(storeFactory).not.toHaveBeenCalled();
		expect(await response.text()).not.toContain("Synthetic listener failure");
	});

	it.each(["127.0.0.2", "127.1", "::ffff:127.0.0.1"])(
		"does not exempt loopback bind %s from authority validation",
		async (host) => {
			const { app, storeFactory } = fixture(() => ({ host, port: PORT }));

			const response = await app.request(`http://attacker.example.test:${PORT}/api/health`, {
				headers: { Host: `attacker.example.test:${PORT}` },
			});

			expect(response.status).toBe(403);
			expect(storeFactory).not.toHaveBeenCalled();
		},
	);

	it.each([AUTHORITY, "attacker.example.test:49152"])(
		"allows a no-Origin CLI mutation only with valid authority: %s",
		async (host) => {
			const { app, mutate } = fixture();

			const response = await app.request(`http://${host}/authority-probe`, {
				method: "POST",
				headers: { Host: host },
			});

			expect(response.status).toBe(host === AUTHORITY ? 204 : 403);
			expect(mutate).toHaveBeenCalledTimes(host === AUTHORITY ? 1 : 0);
		},
	);

	it.each(["0.0.0.0", "::", "192.0.2.10", "::ffff:192.0.2.1"])(
		"preserves external-auth responsibility for explicit nonloopback bind %s",
		async (host) => {
			const { app } = fixture(() => ({ host, port: PORT }));

			const response = await app.request("http://viewer.example.test/api/health", {
				headers: { Host: "viewer.example.test" },
			});

			expect(response.status).toBe(200);
		},
	);

	it("preserves legacy embedding when no listener context is configured", async () => {
		const app = createApp({
			storeFactory: vi.fn(() => {
				throw new Error("No real store");
			}),
		});

		const response = await app.request("http://embedded.example.test/api/health");

		expect(response.status).toBe(200);
	});

	it.each([AUTHORITY, "attacker.example.test:49152"])(
		"supports explicit listener context without account routes: %s",
		async (host) => {
			const app = createApp({
				viewerAuthority: { getListenerAddress: () => ({ host: "127.0.0.1", port: PORT }) },
			});

			const response = await app.request(`http://${host}/`, { headers: { Host: host } });

			expect(response.status).toBe(host === AUTHORITY ? 200 : 403);
		},
	);
});

function requestLoopback(port: number, host: string) {
	return new Promise<number | undefined>((resolve, reject) => {
		const req = request(
			{ hostname: "127.0.0.1", port, path: "/api/health", headers: { Host: host } },
			(res) => {
				res.resume();
				res.on("end", () => resolve(res.statusCode));
			},
		);
		req.on("error", reject);
		req.end();
	});
}

it("uses the actual ephemeral listener port through the production Node adapter", async () => {
	let address: { host: string; port: number } | null = null;
	const { app } = fixture(() => address);
	const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
	try {
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const port = (server.address() as AddressInfo).port;
		address = { host: "127.0.0.1", port };

		const statuses = await Promise.all([
			requestLoopback(port, `127.0.0.1:${port}`),
			requestLoopback(port, `localhost:${port}`),
			requestLoopback(port, `attacker.example.test:${port}`),
			requestLoopback(port, `127.0.0.1:${port === 65535 ? port - 1 : port + 1}`),
		]);

		expect(statuses).toEqual([200, 200, 403, 403]);
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});
