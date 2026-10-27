import { describe, expect, expectTypeOf, it } from "vitest";
import {
	type CoordinatorAccountChangeCapabilitiesRead,
	type readCoordinatorAccountChangeCapabilities,
	VERSION,
} from "./index.js";

describe("core", () => {
	it("exports the capabilities result type for public consumers", () => {
		expectTypeOf<
			Awaited<ReturnType<typeof readCoordinatorAccountChangeCapabilities>>
		>().toEqualTypeOf<CoordinatorAccountChangeCapabilitiesRead>();
	});
	it("exports a version string", () => {
		expect(VERSION).toBe("0.47.0");
	});
});
