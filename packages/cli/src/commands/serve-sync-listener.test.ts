import { expect, it, vi } from "vitest";
import { syncListenerOptions } from "./serve.js";

it("shares one listener limiter between the sync routes and the guarded server", () => {
	const limiter = { check: () => ({ allowed: true, retryAfterS: 0 }) };
	const createServer = vi.fn();
	const serverModule = {
		createSyncListenerLimiter: vi.fn(() => limiter),
		createSyncApp: vi.fn(() => ({ fetch: vi.fn() })),
		createGuardedSyncServer: vi.fn(() => createServer),
	};
	const storeFactory = vi.fn();

	const options = syncListenerOptions(
		serverModule as unknown as Parameters<typeof syncListenerOptions>[0],
		{ storeFactory } as unknown as Parameters<typeof syncListenerOptions>[1],
		{ syncHost: "127.0.0.1", syncPort: 7337 },
	);

	expect(serverModule.createSyncListenerLimiter).toHaveBeenCalledOnce();
	expect(serverModule.createSyncApp).toHaveBeenCalledWith(
		expect.objectContaining({ syncRequestRateLimit: { limiter } }),
	);
	expect(serverModule.createGuardedSyncServer).toHaveBeenCalledWith(
		expect.objectContaining({ limiter, directNoise: expect.objectContaining({ storeFactory }) }),
	);
	expect(options).toMatchObject({ hostname: "127.0.0.1", port: 7337, createServer });
});
