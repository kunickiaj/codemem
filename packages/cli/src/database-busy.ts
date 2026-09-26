export const DATABASE_BUSY_MESSAGE =
	"The codemem database is busy: another codemem process is holding a write lock " +
	"(for example, maintenance after an upgrade). Try again in a minute; " +
	"`codemem maintenance status` shows running jobs.";

export function isDatabaseBusyError(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

type FatalProcess = Pick<NodeJS.Process, "on" | "exit"> & {
	stderr: { write(text: string, callback: () => void): unknown };
};

/**
 * Report a locked database with a plain message instead of a stack trace.
 * Other uncaught errors keep Node's default output and exit status.
 */
export function installDatabaseBusyHandler(target: FatalProcess = process): void {
	const report = (error: unknown): void => {
		let text = DATABASE_BUSY_MESSAGE;
		if (!isDatabaseBusyError(error)) {
			text = error instanceof Error ? (error.stack ?? error.message) : String(error);
		}
		// Exit only after stderr flushes; a piped stderr can otherwise drop the message.
		target.stderr.write(`${text}\n`, () => target.exit(1));
	};
	target.on("uncaughtException", report);
	target.on("unhandledRejection", report);
}
