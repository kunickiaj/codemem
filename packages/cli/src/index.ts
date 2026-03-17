#!/usr/bin/env node

/**
 * @codemem/cli — CLI entry point.
 *
 * Prototype commands for validating the TS store port:
 *   codemem-ts stats   → database statistics
 *   codemem-ts search  → FTS5 memory search
 *   codemem-ts pack    → context-aware memory pack
 */

import { VERSION } from "@codemem/core";
import { Command } from "commander";
import { mcpCommand } from "./commands/mcp.js";
import { packCommand } from "./commands/pack.js";
import { searchCommand } from "./commands/search.js";
import { serveCommand } from "./commands/serve.js";
import { statsCommand } from "./commands/stats.js";

const program = new Command();

program.name("codemem-ts").description("codemem TypeScript backend CLI").version(VERSION);

program.addCommand(serveCommand);
program.addCommand(mcpCommand);
program.addCommand(statsCommand);
program.addCommand(searchCommand);
program.addCommand(packCommand);

program.parse();
