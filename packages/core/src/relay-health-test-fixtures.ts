import { createPrivateKey, sign } from "node:crypto";
import { type Mock, vi } from "vitest";
import type { RelayHealthClockStamp, RelayHealthProbeOptions } from "./relay-health-probe.js";
import { cacheScope, cacheWireSnapshot } from "./scope-membership-cache-test-fixtures.js";
import { buildCanonicalRequest } from "./sync-auth.js";

export const healthScope = cacheScope();
export const healthCatalogue = { version: 1, items: [healthScope] };
export const healthMembers = cacheWireSnapshot();
const privateKey = createPrivateKey({
	key: Buffer.concat([
		Buffer.from("302e020100300506032b657004220420", "hex"),
		// RFC 8032 section 7.1 test vector, matching cacheWireSnapshot's public key.
		Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex"),
	]),
	format: "der",
	type: "pkcs8",
});
type HealthSigner = (input: Parameters<RelayHealthProbeOptions["sign"]>[0]) => Promise<Headers>;
export interface HealthFixture {
	options: RelayHealthProbeOptions;
	clock: Mock<() => RelayHealthClockStamp>;
	signer: Mock<HealthSigner>;
	fetcher: Mock<typeof fetch>;
	now: () => number;
	setNow: (value: number) => void;
}

export function healthFixture(): HealthFixture {
	let now = 120000;
	let nonce = 0;
	const clock = vi.fn(
		(): RelayHealthClockStamp => ({ utcMs: now, verified: true, maxErrorMs: 10, resolutionMs: 1 }),
	);
	const signer = vi.fn<HealthSigner>(async ({ url, method, body }): Promise<Headers> => {
		const target = new URL(url);
		const timestamp = String(Math.floor(now / 1000));
		const requestNonce = (++nonce).toString(16).padStart(32, "0");
		return new Headers({
			"X-Opencode-Device": "device-a",
			"X-Opencode-Timestamp": timestamp,
			"X-Opencode-Nonce": requestNonce,
			"X-Opencode-Signature": `v2:${sign(null, buildCanonicalRequest(method, target.pathname + target.search, timestamp, requestNonce, Buffer.from(body)), privateKey).toString("base64")}`,
		});
	});
	const fetcher = vi.fn<typeof fetch>(async (url) =>
		Response.json(String(url).includes("/members") ? healthMembers : healthCatalogue),
	);
	const options: RelayHealthProbeOptions = {
		coordinatorOrigin: "https://coordinator.example.test",
		groupId: "group-a",
		syntheticScopeId: "scope-a",
		probeDeviceId: "device-a",
		clock,
		sign: signer,
		fetch: fetcher,
	};
	return {
		options,
		clock,
		signer,
		fetcher,
		now: () => now,
		setNow: (value: number) => {
			now = value;
		},
	};
}
