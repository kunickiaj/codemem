import { afterEach, describe, expect, it } from "vitest";
import { observerStatusRoutes } from "./observer-status";

const previousRawEvents = process.env.CODEMEM_RAW_EVENTS;

afterEach(() => {
	if (previousRawEvents == null) delete process.env.CODEMEM_RAW_EVENTS;
	else process.env.CODEMEM_RAW_EVENTS = previousRawEvents;
});

describe("observer status capture evidence", () => {
	it("reports explicitly paused raw-event capture", async () => {
		process.env.CODEMEM_RAW_EVENTS = "0";
		const app = observerStatusRoutes({
			getObserver: () => null,
			getStore: () => null as never,
			getSweeper: () => null,
		});

		const response = await app.request("/api/observer-status");
		const body = (await response.json()) as Record<string, unknown>;

		expect(body.capture_enabled).toBe(false);
	});

	it("does not infer enabled capture when the viewer has no explicit evidence", async () => {
		delete process.env.CODEMEM_RAW_EVENTS;
		const app = observerStatusRoutes({
			getObserver: () => null,
			getStore: () => null as never,
			getSweeper: () => null,
		});

		const response = await app.request("/api/observer-status");
		const body = (await response.json()) as Record<string, unknown>;

		expect(body.capture_enabled).toBeNull();
	});
});
