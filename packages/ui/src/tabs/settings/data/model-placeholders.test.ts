import { expect, it } from "vitest";
import { EMPTY_FORM_STATE } from "./constants";
import { modelPlaceholder } from "./model-placeholders";

const defaults = {
	base: { openai: "base-openai", anthropic: "base-claude", custom: "custom-default" },
	claude: "local-claude",
	codex: "local-codex",
	simple: { openai: "simple-openai", anthropic: "simple-claude" },
	rich: { openai: "rich-openai", anthropic: "rich-claude" },
};
it("uses server defaults for each connection and tier", () => {
	const values = { ...EMPTY_FORM_STATE, observerRuntime: "api_key", observerProvider: "openai" };
	expect(modelPlaceholder(values, defaults)).toBe("base-openai");
	expect(modelPlaceholder(values, defaults, "rich")).toBe("rich-openai");
	expect(modelPlaceholder(values, defaults, "simple", "anthropic")).toBe("simple-claude");
	expect(modelPlaceholder({ ...values, observerRuntime: "claude_sidecar" }, defaults, "rich")).toBe(
		"rich-claude",
	);
	expect(modelPlaceholder({ ...values, observerRuntime: "codex_sidecar" }, defaults, "rich")).toBe(
		"rich-openai",
	);
	expect(
		modelPlaceholder(
			{ ...values, observerRuntime: "codex_sidecar", observerModel: "custom-model" },
			defaults,
			"simple",
		),
	).toBe("custom-model");
	expect(modelPlaceholder({ ...values, observerProvider: "custom" }, defaults, "simple")).toBe(
		"custom-default",
	);
	expect(modelPlaceholder(values, undefined)).toBe("");
});

it("keeps an inferred custom provider even when it has no default model", () => {
	const values = { ...EMPTY_FORM_STATE, observerProvider: "", observerModel: "custom/exact-model" };
	const customDefaults = { ...defaults, base: { ...defaults.base, custom: "" } };
	expect(modelPlaceholder(values, customDefaults, "simple")).toBe("custom/exact-model");
	expect(modelPlaceholder(values, customDefaults, "rich")).toBe("custom/exact-model");
});
