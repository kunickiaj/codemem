import { resolve } from "node:path";

export const uiAliases = {
	"@codemem/core/recipient-policy-contract": resolve(
		import.meta.dirname,
		"../core/src/recipient-policy-contract.ts",
	),
	react: "preact/compat",
	"react-dom": "preact/compat",
	"react-dom/test-utils": "preact/test-utils",
	"react/jsx-runtime": "preact/jsx-runtime",
};
