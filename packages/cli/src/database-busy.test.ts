import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
	DATABASE_BUSY_MESSAGE,
	installDatabaseBusyHandler,
	isDatabaseBusyError,
} from "./database-busy.js";

function fakeProcess() {
	const emitter = new EventEmitter();
	const writes: string[] = [];
	const exit = vi.fn();
	const pendingFlushes: Array<() => void> = [];
	const target = {
		on: emitter.on.bind(emitter),
		exit,
		stderr: {
			write: (text: string, callback: () => void) => {
				writes.push(text);
				pendingFlushes.push(callback);
			},
		},
	};
	installDatabaseBusyHandler(target as never);
	const flush = () => {
		for (const callback of pendingFlushes.splice(0)) callback();
	};
	return { emitter, writes, exit, flush };
}

describe("database busy handler", () => {
	it("recognizes SQLite lock errors", () => {
		expect(
			isDatabaseBusyError(Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })),
		).toBe(true);
		expect(isDatabaseBusyError(new Error("other"))).toBe(false);
	});

	it.each(["uncaughtException", "unhandledRejection"])(
		"prints a plain message without a stack for %s",
		(event) => {
			const { emitter, writes, exit, flush } = fakeProcess();
			emitter.emit(event, Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }));
			expect(writes).toEqual([`${DATABASE_BUSY_MESSAGE}\n`]);
			expect(writes.join("")).not.toContain("    at ");
			expect(exit).not.toHaveBeenCalled();
			flush();
			expect(exit).toHaveBeenCalledWith(1);
		},
	);

	it("keeps the stack for unrelated errors", () => {
		const { emitter, writes, exit, flush } = fakeProcess();
		emitter.emit("uncaughtException", new Error("boom"));
		expect(writes.join("")).toContain("Error: boom");
		flush();
		expect(exit).toHaveBeenCalledWith(1);
	});
});
