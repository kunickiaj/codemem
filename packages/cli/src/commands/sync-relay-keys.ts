/**
 * `codemem sync relay-keys` lists relay service key pins, and `codemem sync approve-relay-key` approves a changed key.
 */

import * as p from "@clack/prompts";
import {
	type Database,
	MemoryStore,
	readCodememConfigFile,
	readCodememConfigFileAtPath,
	readCoordinatorSyncConfig,
	resolveDbPath,
} from "@codemem/core";
import {
	approveRelayServiceKey,
	canonicalRelayServiceKey,
	listRelayServicePins,
	type RelayServicePin,
	readRelayServicePin,
	relayCoordinatorEndpoint,
} from "@codemem/core/internal/relay-runtime";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import {
	addConfigOption,
	addDbOption,
	addJsonOption,
	emitJsonError,
	resolveDbOpt,
} from "../shared-options.js";

interface ListOptions {
	db?: string;
	dbPath?: string;
	json?: boolean;
}

interface ApproveOptions extends ListOptions {
	config?: string;
	key?: string;
}

/** Expected refusal with a stable error code and exit status. */
class RelayKeyRefusal extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly exitCode = 1,
	) {
		super(message);
	}
}

function pinJson(pin: RelayServicePin) {
	return {
		coordinator_id: pin.coordinatorId,
		group_id: pin.groupId,
		state: pin.state,
		pinned_key: pin.pinnedKey,
		first_seen_at: pin.firstSeenAt,
		candidate_key: pin.candidateKey,
		candidate_seen_at: pin.candidateSeenAt,
		last_candidate_key: pin.lastCandidateKey,
		last_candidate_seen_at: pin.lastCandidateSeenAt,
	};
}

function pinText(pin: RelayServicePin): string {
	const lines = [
		`${pin.groupId} (${pin.coordinatorId})`,
		`  state: ${pin.state === "pending_change" ? "paused, key change pending approval" : "pinned"}`,
		`  pinned key: ${pin.pinnedKey} (since ${pin.firstSeenAt})`,
	];
	if (pin.candidateKey)
		lines.push(`  candidate: ${pin.candidateKey} (seen ${pin.candidateSeenAt})`);
	if (pin.lastCandidateKey)
		lines.push(
			`  last candidate: ${pin.lastCandidateKey} (seen ${pin.lastCandidateSeenAt}, not approved)`,
		);
	return lines.join("\n");
}

function withStore<T>(opts: ListOptions, run: (db: Database) => T): T {
	const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
	try {
		return run(store.db);
	} finally {
		store.close();
	}
}

function reportFailure(opts: ListOptions, error: unknown): void {
	const refusal =
		error instanceof RelayKeyRefusal
			? error
			: new RelayKeyRefusal(
					"relay_keys_failed",
					error instanceof Error ? error.message : String(error),
				);
	if (opts.json) {
		emitJsonError(refusal.code, refusal.message, refusal.exitCode);
		return;
	}
	p.log.error(refusal.message);
	process.exitCode = refusal.exitCode;
}

function listPins(opts: ListOptions): void {
	const pins = withStore(opts, listRelayServicePins);
	if (opts.json) {
		console.log(JSON.stringify(pins.map(pinJson), null, 2));
		return;
	}
	p.intro("codemem sync relay-keys");
	if (pins.length === 0) {
		p.outro("No relay service keys pinned");
		return;
	}
	for (const pin of pins) p.log.message(pinText(pin));
	const pending = pins.filter((pin) => pin.state === "pending_change").length;
	p.outro(`${pins.length} pin(s), ${pending} pending approval`);
}

function configuredCoordinatorId(configPath?: string): string {
	const config = configPath ? readCodememConfigFileAtPath(configPath) : readCodememConfigFile();
	const endpoint = relayCoordinatorEndpoint(readCoordinatorSyncConfig(config).syncCoordinatorUrl);
	if (!endpoint)
		throw new RelayKeyRefusal(
			"coordinator_not_configured",
			"Relay needs sync_coordinator_url set to an https:// origin with no path.",
		);
	return endpoint.coordinatorId;
}

function pendingPin(db: Database, coordinatorId: string, groupId: string) {
	const pin = readRelayServicePin(db, coordinatorId, groupId);
	if (pin?.state !== "pending_change" || !pin.candidateKey)
		throw new RelayKeyRefusal(
			"nothing_pending",
			`No relay service key change is pending for group ${groupId}.`,
		);
	return { ...pin, candidateKey: pin.candidateKey };
}

function keysText(pin: { pinnedKey: string; candidateKey: string }): string {
	return `pinned key: ${pin.pinnedKey}\ncandidate:  ${pin.candidateKey}`;
}

/** The candidate the user approved: `--key`, or the shown candidate after an interactive confirmation. */
async function chosenCandidate(
	pin: { pinnedKey: string; candidateKey: string },
	opts: ApproveOptions,
): Promise<string | null> {
	if (opts.key !== undefined) {
		const key = canonicalRelayServiceKey(opts.key);
		if (!key) throw new RelayKeyRefusal("invalid_key", "--key is not an ssh-ed25519 key.", 2);
		if (key !== pin.candidateKey)
			throw new RelayKeyRefusal(
				"candidate_mismatch",
				`--key does not match the pending candidate. Nothing changed.\n${keysText(pin)}`,
			);
		return key;
	}
	if (opts.json || !process.stdin.isTTY || !process.stderr.isTTY)
		throw new RelayKeyRefusal(
			"key_required",
			`Pass the candidate with --key to approve it without a prompt.\n${keysText(pin)}`,
			2,
		);
	p.log.message(keysText(pin), { output: process.stderr });
	const approved = await p.confirm({
		message:
			"Trust the candidate relay service key? Check it with your coordinator operator first.",
		initialValue: false,
		output: process.stderr,
	});
	return approved === true ? pin.candidateKey : null;
}

async function approvePin(groupId: string, opts: ApproveOptions): Promise<void> {
	const coordinatorId = configuredCoordinatorId(opts.config);
	const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
	try {
		const pin = pendingPin(store.db, coordinatorId, groupId);
		const candidateKey = await chosenCandidate(pin, opts);
		if (!candidateKey) {
			p.log.info("Nothing changed.", { output: process.stderr });
			return;
		}
		// The store re-checks the candidate, so a key that changed again since display is refused.
		if (!approveRelayServiceKey(store.db, { coordinatorId, groupId, candidateKey }))
			throw new RelayKeyRefusal(
				"candidate_changed",
				"The pending candidate changed. Nothing changed; list the pins again.",
			);
		reportApproved(opts, { coordinatorId, groupId, previousKey: pin.pinnedKey, candidateKey });
	} finally {
		store.close();
	}
}

function reportApproved(
	opts: ApproveOptions,
	result: { coordinatorId: string; groupId: string; previousKey: string; candidateKey: string },
): void {
	if (opts.json) {
		console.log(
			JSON.stringify(
				{
					ok: true,
					coordinator_id: result.coordinatorId,
					group_id: result.groupId,
					pinned_key: result.candidateKey,
					previous_key: result.previousKey,
				},
				null,
				2,
			),
		);
		return;
	}
	p.log.success(`Pinned ${result.candidateKey} for group ${result.groupId}`);
	p.log.info("A running viewer resumes relay for this group after its next coordinator refresh.");
}

export const relayKeysCommand = new Command("relay-keys")
	.configureHelp(helpStyle)
	.description("List relay service key pins");
addDbOption(relayKeysCommand);
addJsonOption(relayKeysCommand);
relayKeysCommand.action((opts: ListOptions) => {
	try {
		listPins(opts);
	} catch (error) {
		reportFailure(opts, error);
	}
});

// A sibling of `relay-keys` rather than a subcommand, so the CLI stays at two levels.
export const approveRelayKeyCommand = new Command("approve-relay-key")
	.configureHelp(helpStyle)
	.description("Approve a changed relay service key for a group")
	.argument("<group>", "coordinator group id")
	.option("--key <candidate>", "the pending candidate key, exactly as listed");
addDbOption(approveRelayKeyCommand);
addConfigOption(approveRelayKeyCommand);
addJsonOption(approveRelayKeyCommand);
approveRelayKeyCommand.action(async (groupId: string, opts: ApproveOptions) => {
	try {
		await approvePin(groupId, opts);
	} catch (error) {
		reportFailure(opts, error);
	}
});
