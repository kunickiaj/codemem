import {
	CodememPlugin,
	OpencodeMemPlugin,
} from "./.opencode/plugins/codemem.js";

const CodememDualPlugin = {
	id: "codemem",
	server: CodememPlugin,
	setup() {},
};

export default CodememDualPlugin;
export { CodememPlugin, OpencodeMemPlugin };
