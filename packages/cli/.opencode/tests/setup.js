import { beforeEach, vi } from "vitest";

const pluginRegistrationsKey = Symbol.for("codemem.opencode-plugin.registrations");

beforeEach(() => {
	Reflect.deleteProperty(globalThis, pluginRegistrationsKey);
});

const schemaBuilder = () => ({
	optional: () => schemaBuilder(),
});

vi.mock("@opencode-ai/plugin", () => ({
	tool: Object.assign((definition) => definition, {
		schema: {
			number: () => schemaBuilder(),
		},
	}),
}));
