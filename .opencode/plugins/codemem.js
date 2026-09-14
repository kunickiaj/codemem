import { CodememPlugin } from "../../packages/opencode-plugin/index.js";

// Keep source-checkout dogfooding automatic on OpenCode 1 without activating a
// second Codemem instance when OpenCode 2 also loads the configured npm package.
export default Object.freeze({
	id: "codemem-source-checkout-v1",
	server: CodememPlugin,
	setup: async () => undefined,
});
