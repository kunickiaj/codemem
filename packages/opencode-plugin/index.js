import {
	CodememPlugin,
	OpencodeMemPlugin,
} from "./.opencode/plugins/codemem.js";
import { setupOpenCodeV2 } from "./.opencode/lib/opencode-v2-adapter.js";

const CodememDualPlugin = {
	id: "codemem",
	server: CodememPlugin,
	setup: setupOpenCodeV2,
};

export default CodememDualPlugin;
export { CodememPlugin, OpencodeMemPlugin };
