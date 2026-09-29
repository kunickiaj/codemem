import {
	CodememPlugin,
	OpencodeMemPlugin,
} from "./.opencode/plugins/codemem.js";
import { createOpenCodeV2Adapter } from "./.opencode/lib/opencode-v2-adapter.js";
import { createCodememRuntime } from "./.opencode/lib/runtime.js";

const CodememDualPlugin = {
	id: "codemem",
	server: CodememPlugin,
	setup: createOpenCodeV2Adapter({
		createRuntime: (options) => createCodememRuntime({ ...options, hostGeneration: "v2" }),
	}),
};

export default CodememDualPlugin;
export { CodememPlugin, OpencodeMemPlugin };
