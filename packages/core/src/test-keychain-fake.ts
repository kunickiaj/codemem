/**
 * An in-memory keychain for tests that set CODEMEM_SYNC_KEY_STORE=keychain. It answers the
 * `security` and `secret-tool` commands that codemem runs, so the code under test takes its
 * real keychain path without reaching the developer's keychain.
 *
 * `installFakeKeychain()` registers it for the whole test process; call `uninstall()` after
 * the test. A lookup returns the stored value as written. It doesn't model the newline that
 * `security -w` adds, which the attestation witness tests cover with a runner of their own.
 */
import { type KeychainCommand, setTestKeychainRunner } from "./keychain-command.js";

export interface FakeKeychainCall {
	command: KeychainCommand;
	/** The subcommand, for example `find-generic-password` or `lookup`. */
	action: string;
	service: string;
	account: string;
}

export interface FakeKeychain {
	/** The stored value for `account` in `service`, or null. */
	get(service: string, account: string): string | null;
	set(service: string, account: string, value: string): void;
	/** Every command run against it, without the values. */
	calls: FakeKeychainCall[];
	uninstall(): void;
}

/** Thrown for a missing item, as the real tools exit non-zero. */
class FakeKeychainError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

/** The value after `flag` in `args`, for `-a account` and `service name` style pairs. */
function argAfter(args: string[], flag: string): string {
	const index = args.indexOf(flag);
	return index >= 0 ? (args[index + 1] ?? "") : "";
}

export function installFakeKeychain(): FakeKeychain {
	const entries = new Map<string, string>();
	const key = (service: string, account: string) => `${service}\u0000${account}`;
	const calls: FakeKeychainCall[] = [];
	const lookup = (service: string, account: string) => {
		const value = entries.get(key(service, account));
		if (value === undefined)
			throw new FakeKeychainError("The specified item could not be found.", 44);
		return value;
	};

	const security = (action: string, args: string[]): string => {
		const service = argAfter(args, "-s");
		const account = argAfter(args, "-a");
		calls.push({ command: "security", action, service, account });
		if (action === "find-generic-password") return lookup(service, account);
		if (action !== "add-generic-password") throw new FakeKeychainError(`unsupported: ${action}`, 1);
		// Without -U the real tool refuses to replace an item.
		if (entries.has(key(service, account)) && !args.includes("-U"))
			throw new FakeKeychainError("The specified item already exists in the keychain.", 45);
		entries.set(key(service, account), argAfter(args, "-w"));
		return "";
	};

	const secretTool = (action: string, args: string[], input?: string): string => {
		const service = argAfter(args, "service");
		const account = argAfter(args, "account");
		calls.push({ command: "secret-tool", action, service, account });
		if (action === "lookup") return lookup(service, account);
		if (action !== "store") throw new FakeKeychainError(`unsupported: ${action}`, 1);
		// `secret-tool store` reads the secret from standard input and replaces an item.
		entries.set(key(service, account), input ?? "");
		return "";
	};

	setTestKeychainRunner((command, [action = "", ...rest], input) =>
		command === "security" ? security(action, rest) : secretTool(action, rest, input),
	);
	return {
		get: (service, account) => entries.get(key(service, account)) ?? null,
		set: (service, account, value) => {
			entries.set(key(service, account), value);
		},
		calls,
		uninstall: () => setTestKeychainRunner(null),
	};
}
