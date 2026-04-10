import { vi } from "vitest";

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
