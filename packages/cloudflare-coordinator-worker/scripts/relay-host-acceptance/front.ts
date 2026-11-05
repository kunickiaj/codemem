// The public origin devices use: TLS with the run's test CA. HTTP goes to the host's
// coordinator. Relay upgrades go through one keyless fault proxy per realm.
import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { createServer as httpsServer } from "node:https";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import {
	createRelayFaultProxy,
	type RelayFaultProxy,
	type RelayFaultRule,
} from "../../../core/src/relay-fault-proxy-test-fixtures.js";
import { relayRealmId } from "../../../core/src/relay-service-proof.js";
import { closeServer, GROUPS, type GroupId, listenLoopback, type RelayHostUnderTest } from "./common.js";

export interface Front {
	readonly port: number;
	/** Installs the host once it is running. Requests before that fail with 502. */
	attach(host: RelayHostUnderTest, authorityId: string): Promise<void>;
	proxy(groupId: GroupId): RelayFaultProxy;
	/** The fault rule for one realm's proxy, or undefined to pass every frame. */
	setFault(groupId: GroupId, rule: RelayFaultRule | undefined): void;
	close(): Promise<void>;
}

function forwardUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, upstream: string) {
	const [host, port] = upstream.split(":");
	const next = connect(Number(port), host, () => {
		const lines = [`${request.method} ${request.url} HTTP/1.1`];
		for (let i = 0; i < request.rawHeaders.length; i += 2)
			lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
		next.write(`${lines.join("\r\n")}\r\n\r\n`);
		if (head.length) next.write(head);
		next.pipe(socket);
		socket.pipe(next);
	});
	const end = () => {
		socket.destroy();
		next.destroy();
	};
	next.on("error", end);
	socket.on("error", end);
	socket.on("close", () => next.destroy());
	next.on("close", () => socket.destroy());
}

export async function startFront(tls: { key: Buffer; cert: Buffer }): Promise<Front> {
	let httpPort = 0;
	const proxies = new Map<GroupId, RelayFaultProxy>();
	const proxiesByPath = new Map<string, RelayFaultProxy>();
	const faults = new Map<GroupId, RelayFaultRule | undefined>();
	const server = httpsServer(tls, (request, response) => {
		const forward = httpRequest(
			{ host: "127.0.0.1", port: httpPort, path: request.url, method: request.method, headers: request.headers },
			(reply) => {
				response.writeHead(reply.statusCode ?? 502, reply.headers);
				reply.pipe(response);
			},
		);
		forward.on("error", () => {
			response.writeHead(502);
			response.end();
		});
		request.pipe(forward);
	});
	server.on("upgrade", (request, socket, head) => {
		const proxy = proxiesByPath.get(new URL(request.url ?? "/", "https://front").pathname);
		if (!proxy) {
			socket.destroy();
			return;
		}
		forwardUpgrade(request, socket, head, proxy.host);
	});
	const port = await listenLoopback(server as never);
	return {
		port,
		async attach(host, authorityId) {
			httpPort = host.httpPort;
			for (const groupId of GROUPS) {
				const proxy = await createRelayFaultProxy({
					upstreamUrl: host.relayUpstream(groupId),
					rule: (frame) => faults.get(groupId)?.(frame),
				});
				proxies.set(groupId, proxy);
				proxiesByPath.set(`/v1/relay/${relayRealmId(authorityId, groupId)}`, proxy);
			}
		},
		proxy(groupId) {
			const proxy = proxies.get(groupId);
			if (!proxy) throw new Error(`no proxy for ${groupId}`);
			return proxy;
		},
		setFault: (groupId, rule) => faults.set(groupId, rule),
		async close() {
			for (const proxy of proxies.values()) await proxy.close();
			await closeServer(server as never);
		},
	};
}
