import { buildDirectPeerAuthHeaders } from "@codemem/core";
import { afterEach, expect, it, vi } from "vitest";
import { promotePeerToNoiseRequired } from "../../core/src/sync-transport-policy.js";
import type { InMemoryRequestRateLimiter } from "./request-rate-limit.js";
import { createSyncApp } from "./sync-app.js";
import { channelStore, nonceCount, ORIGIN } from "./sync-channel-dispatch-test-fixtures.js";

const cleanups: (() => unknown)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

/** A plain listener with Noise on, whose known peer is recorded as noise_required. */
async function listener() {
	const f = await channelStore();
	cleanups.push(f.cleanup);
	promotePeerToNoiseRequired(f.store.db, f.peerDeviceId, "authenticated_exchange");
	const check = vi.fn<InMemoryRequestRateLimiter["check"]>(() => ({
		allowed: true,
		retryAfterS: 0,
	}));
	const app = createSyncApp({
		storeFactory: f.storeFactory,
		mode: { kind: "plain-direct", noiseActive: true },
		syncRequestRateLimit: { limiter: { check } as unknown as InMemoryRequestRateLimiter },
	});
	const send = async (method: string, target: string, headers: Record<string, string>) => {
		const response = await app.fetch(new Request(`${ORIGIN}${target}`, { method, headers }));
		return { status: response.status, body: await response.text() };
	};
	return { ...f, check, send };
}

/** Headers that claim a device but carry a signature nobody could verify. */
const claiming = (deviceId: string) => ({
	"X-Opencode-Device": deviceId,
	"X-Opencode-Signature": "v3:forged",
	"X-Opencode-Timestamp": String(Math.floor(Date.now() / 1000)),
	"X-Opencode-Nonce": "nonce-1",
});

it.each([
	["GET", "/v1/unknown"],
	["POST", "/v1/status"],
	["GET", "/v1/noise"],
])(
	"answers %s %s identically for a Noise-required and an unknown device, without the limiter",
	async (method, target) => {
		const l = await listener();

		const required = await l.send(method, target, claiming(l.peerDeviceId));
		const unknown = await l.send(method, target, claiming("unknown-device"));

		expect(required).toEqual({ status: 404, body: JSON.stringify({ error: "not found" }) });
		expect(unknown).toEqual(required);
		expect(l.check).not.toHaveBeenCalled();
	},
);

it.each(["/v1/status", "/v1/ops", "/v1/snapshot?generation=1&snapshot_id=x&limit=1"])(
	"answers an unverifiable %s identically for a Noise-required and an unknown device",
	async (target) => {
		const l = await listener();

		const required = await l.send("GET", target, claiming(l.peerDeviceId));
		const unknown = await l.send("GET", target, claiming("unknown-device"));

		expect(required.status).toBe(401);
		expect(unknown).toEqual(required);
		expect(l.check.mock.calls.map(([key]) => key)).toEqual([
			`GET:anon:${target.split("?")[0]}`,
			`GET:anon:${target.split("?")[0]}`,
		]);
	},
);

it("refuses the verified Noise-required device without recording its nonce", async () => {
	const l = await listener();
	const url = `${ORIGIN}/v1/ops`;
	const headers = buildDirectPeerAuthHeaders({
		deviceId: l.peerDeviceId,
		recipientId: l.localDeviceId,
		method: "GET",
		url,
		bodyBytes: Buffer.alloc(0),
		keysDir: l.peerKeysDir,
	});

	const refused = await l.send("GET", "/v1/ops", headers);

	expect(refused.status).toBe(401);
	expect(nonceCount(l)).toBe(0);
});
