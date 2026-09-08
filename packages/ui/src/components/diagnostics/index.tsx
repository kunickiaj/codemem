import { render } from "preact";
import { useEffect } from "preact/hooks";
import { loadDiagnosticEvents } from "../../lib/api/diagnostics";
import {
	type DiagnosticsDrawerDependencies,
	type OpenDiagnosticsDrawerOptions,
	useDiagnosticsDrawer,
} from "./use-diagnostics-drawer";
import { DiagnosticsDrawerView } from "./view";

export {
	getViewerConnectionEvents,
	recordViewerConnectionEvent,
} from "./viewer-connection-events";

type DrawerCommands = {
	open: (options?: OpenDiagnosticsDrawerOptions) => void;
	refresh: () => Promise<void>;
	close: () => void;
};

let commands: DrawerCommands | null = null;

function DiagnosticsDrawerHost({ dependencies }: { dependencies: DiagnosticsDrawerDependencies }) {
	const controller = useDiagnosticsDrawer(dependencies.loadEvents ?? loadDiagnosticEvents);
	useEffect(() => {
		const registeredCommands = {
			open: controller.open,
			refresh: controller.refresh,
			close: controller.close,
		};
		commands = registeredCommands;
		return () => {
			if (commands === registeredCommands) commands = null;
		};
	}, [controller.open, controller.refresh, controller.close]);
	return <DiagnosticsDrawerView controller={controller} />;
}

export function mountDiagnosticsDrawer(
	mount: HTMLElement,
	dependencies: DiagnosticsDrawerDependencies = {},
): void {
	render(<DiagnosticsDrawerHost dependencies={dependencies} />, mount);
}

export function openDiagnosticsDrawer(options: OpenDiagnosticsDrawerOptions = {}): void {
	commands?.open(options);
}

export function closeDiagnosticsDrawer(afterClose?: () => void): void {
	commands?.close();
	if (afterClose) queueMicrotask(afterClose);
}

export async function coordinatedRefreshDiagnosticsDrawer(): Promise<void> {
	await commands?.refresh();
}

export function initDiagnosticsEntryPoints(): void {
	document.getElementById("healthOpenDiagnostics")?.addEventListener("click", (event) => {
		openDiagnosticsDrawer({ trigger: event.currentTarget as HTMLElement });
	});
	document.getElementById("syncOpenDiagnostics")?.addEventListener("click", (event) => {
		openDiagnosticsDrawer({
			subsystem: "sync",
			trigger: event.currentTarget as HTMLElement,
		});
	});
	document.getElementById("viewerReconnectDiagnostics")?.addEventListener("click", (event) => {
		openDiagnosticsDrawer({
			subsystem: "viewer",
			trigger: event.currentTarget as HTMLElement,
		});
	});
}

export type { DiagnosticsDrawerDependencies, OpenDiagnosticsDrawerOptions };
