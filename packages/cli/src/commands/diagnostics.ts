import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import { createCaptureDiagnosticsCommand } from "./capture.js";
import { createExtractionDiagnosticsCommand, createMemoryDiagnosticsCommand } from "./memory.js";

export const diagnosticsCommand = new Command("diagnostics")
	.configureHelp(helpStyle)
	.description("Inspect capture failures and memory quality")
	.addCommand(createCaptureDiagnosticsCommand())
	.addCommand(createMemoryDiagnosticsCommand())
	.addCommand(createExtractionDiagnosticsCommand());
