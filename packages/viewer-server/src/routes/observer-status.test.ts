import { afterEach, describe, expect, it } from "vitest";
import { observerStatusRoutes } from "./observer-status";

const previousRawEvents = process.env.CODEMEM_RAW_EVENTS;

afterEach(() => {
	if (previousRawEvents == null) delete process.env.CODEMEM_RAW_EVENTS;
	else process.env.CODEMEM_RAW_EVENTS = previousRawEvents;
});

describe("observer status capture evidence", () => {
	it.each(["0", "false", "off"])("reports %s as paused raw-event capture", async (value) => {
		process.env.CODEMEM_RAW_EVENTS = value;
		const app = observerStatusRoutes({
			getObserver: () => null,
			getStore: () => null as never,
			getSweeper: () => null,
		});

		const response = await app.request("/api/observer-status");
		const body = (await response.json()) as Record<string, unknown>;

		expect(body.capture_enabled).toBe(false);
	});

	it("reports other explicit values as enabled like the capture runtime", async () => {
		process.env.CODEMEM_RAW_EVENTS = "on";
		const app = observerStatusRoutes({
			getObserver: () => null,
			getStore: () => null as never,
			getSweeper: () => null,
		});

		const response = await app.request("/api/observer-status");
		const body = (await response.json()) as Record<string, unknown>;

		expect(body.capture_enabled).toBe(true);
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
