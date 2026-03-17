import { VERSION } from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";

export const versionCommand = new Command("version")
	.configureHelp(helpStyle)
	.description("Print codemem version")
	.action(() => {
		console.log(VERSION);
	});
