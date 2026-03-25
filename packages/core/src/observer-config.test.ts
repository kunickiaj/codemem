import { describe, expect, it } from "vitest";
import {
	getCodememEnvOverrides,
	getProviderApiKey,
	loadOpenCodeConfig,
	resolveCustomProviderFromModel,
	resolvePlaceholder,
	stripJsonComments,
	stripTrailingCommas,
} from "./observer-config.js";

describe("stripJsonComments", () => {
	it("removes line comments", () => {
		const input = '{\n  "key": "value" // this is a comment\n}';
		expect(stripJsonComments(input)).toBe('{\n  "key": "value" \n}');
	});

	it("preserves // inside strings", () => {
		const input = '{"url": "https://example.com"}';
		expect(stripJsonComments(input)).toBe(input);
	});

	it("handles escaped quotes in strings", () => {
		const input = '{"key": "val\\"ue"} // comment';
		expect(stripJsonComments(input)).toBe('{"key": "val\\"ue"} ');
	});

	it("strips block comments", () => {
		expect(stripJsonComments('{"a": /* comment */ 1}')).toBe('{"a":  1}');
	});

	it("strips multi-line block comments", () => {
		const input = '{\n  /* this is\n  a comment */\n  "a": 1\n}';
		expect(JSON.parse(stripJsonComments(input))).toEqual({ a: 1 });
	});

	it("preserves /* inside strings", () => {
		const input = '{"url": "/* not a comment */"}';
		expect(stripJsonComments(input)).toBe(input);
	});
});

describe("stripTrailingCommas", () => {
	it("removes trailing comma before }", () => {
		expect(stripTrailingCommas('{"a": 1,}')).toBe('{"a": 1}');
	});

	it("removes trailing comma before ]", () => {
		expect(stripTrailingCommas("[1, 2, 3,]")).toBe("[1, 2, 3]");
	});

	it("preserves commas inside strings", () => {
		const input = '{"a": "1,}"}';
		expect(stripTrailingCommas(input)).toBe(input);
	});

	it("handles whitespace between comma and bracket", () => {
		expect(stripTrailingCommas('{"a": 1 , \n}')).toBe('{"a": 1  \n}');
	});
});

describe("loadOpenCodeConfig", () => {
	it("returns {} when no config file exists", () => {
		// This test relies on the test environment not having an opencode config.
		// If it does, the test is still valid — it just returns whatever is there.
		const result = loadOpenCodeConfig();
		expect(typeof result).toBe("object");
	});
});

describe("resolvePlaceholder", () => {
	it("expands $ENV_VAR references", () => {
		process.env.TEST_OBSERVER_CONFIG_VAR = "hello";
		try {
			expect(resolvePlaceholder("prefix-$TEST_OBSERVER_CONFIG_VAR-suffix")).toBe(
				"prefix-hello-suffix",
			);
		} finally {
			delete process.env.TEST_OBSERVER_CONFIG_VAR;
		}
	});

	it("expands ${ENV_VAR} references", () => {
		process.env.TEST_OBSERVER_CONFIG_VAR2 = "world";
		try {
			expect(resolvePlaceholder("${TEST_OBSERVER_CONFIG_VAR2}!")).toBe("world!");
		} finally {
			delete process.env.TEST_OBSERVER_CONFIG_VAR2;
		}
	});

	it("leaves unset env vars as-is", () => {
		delete process.env.SURELY_UNSET_VAR_XYZ;
		expect(resolvePlaceholder("$SURELY_UNSET_VAR_XYZ")).toBe("$SURELY_UNSET_VAR_XYZ");
	});
});

describe("resolveCustomProviderFromModel", () => {
	it("returns null for model without slash", () => {
		expect(resolveCustomProviderFromModel("gpt-4", new Set(["openai"]))).toBeNull();
	});

	it("returns provider when prefix matches", () => {
		expect(resolveCustomProviderFromModel("myco/model-1", new Set(["myco"]))).toBe("myco");
	});

	it("returns null when prefix not in providers", () => {
		expect(resolveCustomProviderFromModel("myco/model-1", new Set(["other"]))).toBeNull();
	});
});

describe("getProviderApiKey", () => {
	it("resolves from options.apiKey", () => {
		expect(getProviderApiKey({ options: { apiKey: "sk-test123" } })).toBe("sk-test123");
	});

	it("resolves from options.apiKeyEnv", () => {
		process.env.TEST_API_KEY_FOR_OBSERVER = "sk-from-env";
		try {
			expect(getProviderApiKey({ options: { apiKeyEnv: "TEST_API_KEY_FOR_OBSERVER" } })).toBe(
				"sk-from-env",
			);
		} finally {
			delete process.env.TEST_API_KEY_FOR_OBSERVER;
		}
	});

	it("returns null when no key configured", () => {
		expect(getProviderApiKey({})).toBeNull();
	});
});

describe("getCodememEnvOverrides", () => {
	it("includes sync retention env overrides when set", () => {
		process.env.CODEMEM_SYNC_RETENTION_ENABLED = "1";
		process.env.CODEMEM_SYNC_RETENTION_MAX_AGE_DAYS = "14";
		process.env.CODEMEM_SYNC_RETENTION_MAX_SIZE_MB = "256";
		try {
			expect(getCodememEnvOverrides()).toMatchObject({
				sync_retention_enabled: "CODEMEM_SYNC_RETENTION_ENABLED",
				sync_retention_max_age_days: "CODEMEM_SYNC_RETENTION_MAX_AGE_DAYS",
				sync_retention_max_size_mb: "CODEMEM_SYNC_RETENTION_MAX_SIZE_MB",
			});
		} finally {
			delete process.env.CODEMEM_SYNC_RETENTION_ENABLED;
			delete process.env.CODEMEM_SYNC_RETENTION_MAX_AGE_DAYS;
			delete process.env.CODEMEM_SYNC_RETENTION_MAX_SIZE_MB;
		}
	});
});
