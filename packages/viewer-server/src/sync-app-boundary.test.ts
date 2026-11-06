import type { MemoryStore } from "@codemem/core";
import { expect, it, vi } from "vitest";

// A peer-only import must never evaluate the viewer composition root.
vi.mock("./index.js", () => {
	throw new Error("Viewer composition root must not load");
});
vi.mock("./shared-store.js", () => ({
	getStore: vi.fn(() => {
		throw new Error("Default store must remain unopened");
	}),
}));

async function createPeerClient(kind: "factory" | "dispatcher", storeFactory: () => MemoryStore) {
	if (kind === "factory") {
		const { createSyncApp } = await import("./sync-app.js");
		const app = createSyncApp({ storeFactory, syncChannelPeerPin: () => "test-pin" });
		return (target: string) => app.request(`https://peer.invalid${target}`);
	}
	const { createSyncChannelDispatcher } = await import("./sync-channel-dispatch.js");
	const dispatch = createSyncChannelDispatcher({ storeFactory });
	return async (target: string) => {
		const result = await dispatch({
			method: "GET",
			target,
			url: `https://peer.invalid${target}`,
			headers: {},
			bodyBytes: new Uint8Array(0),
			peerPin: "test-pin",
			signal: new AbortController().signal,
		});
		return new Response(new Uint8Array(result.bodyBytes), {
			status: result.status,
			headers: result.headers,
		});
	};
}

it.each(["factory", "dispatcher"] as const)(
	"imports and constructs the %s without the viewer root or an open store",
	async (kind) => {
		const storeFactory = vi.fn<() => MemoryStore>(() => {
			throw new Error("Construction must not open a store");
		});

		const client = await createPeerClient(kind, storeFactory);

		expect(client).toBeTypeOf("function");
		expect(storeFactory).not.toHaveBeenCalled();
	},
);

it.each(["factory", "dispatcher"] as const)(
	"uses the injected store for a protocol request and denies missing authentication in the %s",
	async (kind) => {
		const store = Object.freeze({}) as MemoryStore;
		const storeFactory = vi.fn(() => store);
		const client = await createPeerClient(kind, storeFactory);

		const response = await client("/v1/ops");

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "unauthorized" });
		expect(storeFactory).toHaveBeenCalledTimes(1);
	},
);

it.each(["factory", "dispatcher"] as const)(
	"excludes viewer routes before store access in the %s",
	async (kind) => {
		const storeFactory = vi.fn<() => MemoryStore>(() => {
			throw new Error("Viewer requests must not open a store");
		});
		const client = await createPeerClient(kind, storeFactory);

		const response = await client("/api/sync/peers");

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "not found" });
		expect(storeFactory).not.toHaveBeenCalled();
	},
);
