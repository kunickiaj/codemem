/**
 * Shared Commander help style configuration.
 *
 * Applied to every Command instance so subcommand --help
 * output gets the same colors as the root.
 */

import { styleText } from "node:util";
import type { HelpConfiguration } from "commander";

export const helpStyle: HelpConfiguration = {
	styleTitle: (str) => styleText("bold", str),
	styleCommandText: (str) => styleText("cyan", str),
	styleCommandDescription: (str) => str,
	styleDescriptionText: (str) => styleText("dim", str),
	styleOptionText: (str) => styleText("green", str),
	styleOptionTerm: (str) => styleText("green", str),
	styleSubcommandText: (str) => styleText("cyan", str),
	styleArgumentText: (str) => styleText("yellow", str),
};
