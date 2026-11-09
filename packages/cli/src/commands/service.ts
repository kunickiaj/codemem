import * as p from "@clack/prompts";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import { addConfigOption, addDbOption, addViewerHostOptions } from "../shared-options.js";
import { runServeInvocation } from "./serve.js";
import {
	type ResolvedServeInvocation,
	resolveStartServeInvocation,
	resolveStopRestartInvocation,
	type ServeMode,
	type StartServeOptions,
} from "./serve-invocation.js";
import { createStatusCommand, type StatusDependencies } from "./status.js";

export interface ServiceDependencies {
	runInvocation: (invocation: ResolvedServeInvocation) => Promise<void>;
	writeError: (message: string) => void;
	setExitCode: (code: number) => void;
	statusDependencies?: Partial<StatusDependencies>;
}

function createLifecycleCommand(mode: ServeMode, deps: ServiceDependencies): Command {
	const descriptions = {
		start: "Start the local service in the background",
		stop: "Stop the local service",
		restart: "Restart the local service in the background",
	};
	const command = new Command(mode).configureHelp(helpStyle).description(descriptions[mode]);
	addDbOption(command);
	addConfigOption(command);
	addViewerHostOptions(command);
	if (mode === "start") {
		command.option("-f, --foreground", "run the local service in the foreground");
	}
	return command.action(async (opts: StartServeOptions) => {
		let invocation: ResolvedServeInvocation;
		try {
			invocation =
				mode === "start"
					? resolveStartServeInvocation(opts)
					: resolveStopRestartInvocation(mode, opts);
		} catch (error) {
			deps.writeError(error instanceof Error ? error.message : String(error));
			deps.setExitCode(2);
			return;
		}
		try {
			await deps.runInvocation(invocation);
		} catch (error) {
			deps.writeError(error instanceof Error ? error.message : String(error));
			deps.setExitCode(1);
		}
	});
}

export function createServiceCommand(overrides: Partial<ServiceDependencies> = {}): Command {
	const deps: ServiceDependencies = {
		runInvocation: runServeInvocation,
		writeError: (message) => p.log.error(message),
		setExitCode: (code) => {
			process.exitCode = code;
		},
		...overrides,
	};
	const command = new Command("service")
		.configureHelp(helpStyle)
		.description("Manage the local service");
	for (const mode of ["start", "stop", "restart"] as const) {
		command.addCommand(createLifecycleCommand(mode, deps));
	}
	command.addCommand(createStatusCommand(deps.statusDependencies));
	return command;
}

export const serviceCommand = createServiceCommand();
