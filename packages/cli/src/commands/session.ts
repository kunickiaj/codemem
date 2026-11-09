import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import { createPiImportSessionsCommand } from "./pi-import-sessions.js";
import { createPiSessionSearchCommand } from "./pi-session-search.js";

export function createSessionCommand(): Command {
	return new Command("session")
		.configureHelp(helpStyle)
		.description("Import and search Pi conversations")
		.addCommand(createPiImportSessionsCommand().name("import"))
		.addCommand(createPiSessionSearchCommand().name("search"));
}

export const sessionCommand = createSessionCommand();
