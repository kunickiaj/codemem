import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createSyncApp } from "./sync-app.js";
import { createSyncChannelDispatcher, type SyncChannelRequest } from "./sync-channel-dispatch.js";
import {
	channelStore,
	json,
	nonceCount,
	SCOPE,
	signedRequest,
} from "./sync-channel-dispatch-test-fixtures.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

async function fixture() {
	const f = await channelStore();
	cleanups.push(f.cleanup);
	const relay = createSyncChannelDispatcher({ storeFactory: f.storeFactory });
	const noise = createSyncChannelDispatcher({ storeFactory: f.storeFactory, mode: "noise-direct" });
	const plainApp = createSyncApp({ storeFactory: f.storeFactory });
	const plain = async (dto: SyncChannelRequest) => {
		const headers = new Headers(dto.headers);
		for (const name of ["host", "content-length", "connection"]) headers.delete(name);
		const body = dto.method === "POST" ? new Uint8Array(dto.bodyBytes) : undefined;
		const response = await plainApp.fetch(
			new Request(dto.url, { method: dto.method, headers, body }),
		);
		return { status: response.status, bodyBytes: new Uint8Array(await response.arrayBuffer()) };
	};
	const admitted = (dto: SyncChannelRequest): SyncChannelRequest => ({
		...dto,
		peerDeviceId: f.peerDeviceId,
	});
	return { ...f, relay, noise, plain, admitted };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const unscopedReads = ["/v1/status", "/v1/ops", "/v1/snapshot"];

it.each(unscopedReads)(
	"serves unscoped %s over noise-direct as the plain listener does",
	async (target) => {
		const f = await fixture();

		const plain = await f.plain(signedRequest(f, { target }));
		const noise = await f.noise(f.admitted(signedRequest(f, { target })));

		// Same answer, whether it is data, a reset or a request error. The relay refuses all three.
		expect(noise.status).toBe(plain.status);
		expect(json(noise)).toEqual(json(plain));
		if (target === "/v1/status") expect(noise.status).toBe(200);
	},
);

it.each(unscopedReads)(
	"refuses unscoped %s over the relay without naming a boundary",
	async (target) => {
		const f = await fixture();

		const response = await f.relay(signedRequest(f, { target }));

		expect(response.status).toBe(409);
		expect(json(response)).toMatchObject({ error: "reset_required", reason: "missing_scope" });
		expect(json(response)).not.toHaveProperty("ops");
		expect(json(response)).not.toHaveProperty("items");
		expect(json(response)).not.toHaveProperty("authorized_scopes");
	},
);

it("refuses an unscoped push over the relay and stores nothing", async () => {
	const f = await fixture();
	const bodyBytes = Buffer.from(JSON.stringify({ ops: [], sync_capability: "scoped" }));
	const before = f.store.db.prepare("SELECT COUNT(*) FROM replication_ops").pluck().get();

	const response = await f.relay(
		signedRequest(f, { method: "POST", target: "/v1/ops", bodyBytes }),
	);

	expect(response.status).toBe(409);
	expect(json(response)).toMatchObject({ error: "reset_required", reason: "missing_scope" });
	expect(f.store.db.prepare("SELECT COUNT(*) FROM replication_ops").pluck().get()).toBe(before);
});

const wrongChannel: Array<[string, (f: Fixture, dto: SyncChannelRequest) => SyncChannelRequest]> = [
	["another device ID", (_f, dto) => ({ ...dto, peerDeviceId: "someone-else" })],
	["no admitted device", (_f, dto) => ({ ...dto, peerDeviceId: undefined })],
	[
		"another key",
		(f, dto) => ({ ...dto, peerDeviceId: f.peerDeviceId, peerPin: f.localPublicKey }),
	],
];

it.each(wrongChannel)(
	"refuses a noise-direct request from %s before using its nonce",
	async (_name, change) => {
		const f = await fixture();
		const target = `/v1/status?scope_id=${SCOPE}`;

		const response = await f.noise(change(f, signedRequest(f, { target })));

		expect(response.status).toBe(401);
		expect(json(response)).toEqual({ error: "unauthorized" });
		expect(nonceCount(f)).toBe(0);
	},
);

it("refuses a relay request whose channel proved another key", async () => {
	const f = await fixture();
	const dto = {
		...signedRequest(f, { target: `/v1/status?scope_id=${SCOPE}` }),
		peerPin: f.localPublicKey,
	};

	const response = await f.relay(dto);

	expect(response.status).toBe(401);
	expect(nonceCount(f)).toBe(0);
});

it.each(["/v1/status", "/v1/snapshot"])(
	"never tries bootstrap-grant auth for %s over a channel, unlike the plain listener",
	async (target) => {
		const f = await fixture();
		const config = join(dirname(f.store.dbPath), "config.json");
		writeFileSync(
			config,
			JSON.stringify({
				sync_coordinator_url: "http://127.0.0.1:1",
				sync_coordinator_groups: ["g1"],
			}),
		);
		vi.stubEnv("CODEMEM_CONFIG", config);
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled"));
		// A device this store never pinned, presenting a grant as a bootstrap worker would.
		const stranger = (dto: SyncChannelRequest): SyncChannelRequest => ({
			...dto,
			peerDeviceId: "unpinned-worker",
			headers: {
				...dto.headers,
				"X-Opencode-Device": "unpinned-worker",
				"X-Codemem-Bootstrap-Grant": "grant-1",
			},
		});

		const relay = await f.relay(stranger(signedRequest(f, { target })));
		const noise = await f.noise(stranger(signedRequest(f, { target })));
		expect(fetch).not.toHaveBeenCalled();
		const plain = await f.plain(stranger(signedRequest(f, { target })));

		expect(relay.status).toBe(401);
		expect(noise.status).toBe(401);
		expect(plain.status).toBe(401);
		expect(fetch).toHaveBeenCalled();
	},
);
