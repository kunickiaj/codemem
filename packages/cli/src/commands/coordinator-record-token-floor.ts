import { existsSync } from "node:fs";
import * as p from "@clack/prompts";
import {
	BetterSqliteCoordinatorStore,
	DEFAULT_COORDINATOR_DB_PATH,
	INVITE_TOKEN_LOOKUP_VERSION,
	InviteTokenRefusal,
	type InviteTokenSealProgress,
} from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import { addDbOption, addJsonOption, emitJsonError, resolveDbOpt } from "../shared-options.js";

interface Options {
	db?: string;
	dbPath?: string;
	json?: boolean;
}

/** Sealing batches before the command stops and asks for another run. */
const MAX_BATCHES = 1000;

function fail(options: Options, code: string, message: string) {
	if (options.json) return emitJsonError(code, message);
	p.log.error(message);
	process.exitCode = 1;
}

const REFUSALS: Readonly<Record<string, string>> = {
	coordinator_metadata_unavailable:
		"This coordinator database has no metadata table. Start `codemem coordinator serve` on it once, then try again.",
	invite_token_key_unavailable:
		"No invitation token key is available. Configure CODEMEM_INVITE_TOKEN_KEY, or let the coordinator create its key file.",
	invite_token_key_invalid: "The configured invitation token key is not a 32-byte key.",
};

function refusalMessage(error: InviteTokenRefusal): string {
	return REFUSALS[error.code] ?? error.message;
}

/** Seals the tokens stored before the floor, batch by batch, until none remain. */
async function sealStoredTokens(
	store: BetterSqliteCoordinatorStore,
): Promise<InviteTokenSealProgress> {
	let progress = await store.sealStoredInviteTokens(100);
	for (let batch = 1; batch < MAX_BATCHES; batch += 1) {
		const left =
			progress.remaining_plaintext_invites +
			progress.remaining_plaintext_join_requests +
			progress.remaining_spent_ciphertext;
		if (left === 0) break;
		progress = await store.sealStoredInviteTokens(100);
	}
	return progress;
}

/** Why this coordinator could not seal with its key, or null when it can. */
function keyRefusal(store: BetterSqliteCoordinatorStore): Promise<InviteTokenRefusal | null> {
	return store.prepareInviteTokenKey().then(
		() => null,
		(error: unknown) => {
			if (error instanceof InviteTokenRefusal) return error;
			throw error;
		},
	);
}

/** The coordinator store at `dbPath`, or null when the file is not a readable coordinator database. */
function openStore(dbPath: string): BetterSqliteCoordinatorStore | null {
	try {
		return new BetterSqliteCoordinatorStore(dbPath);
	} catch {
		return null;
	}
}

async function recordFloor(versionText: string, options: Options) {
	const version = Number(versionText);
	if (!/^\d+$/u.test(versionText.trim()) || !Number.isSafeInteger(version) || version < 1)
		return fail(
			options,
			"invalid_version",
			"Enter the lookup version as a whole number, such as 1.",
		);
	if (version > INVITE_TOKEN_LOOKUP_VERSION)
		return fail(
			options,
			"version_above_build",
			`This codemem release has invitation token lookup version ${INVITE_TOKEN_LOOKUP_VERSION}. It cannot record a higher floor.`,
		);
	const dbPath = resolveDbOpt(options) ?? DEFAULT_COORDINATOR_DB_PATH;
	if (!existsSync(dbPath))
		return fail(options, "coordinator_database_missing", `No coordinator database at ${dbPath}.`);
	const store = openStore(dbPath);
	if (!store)
		return fail(
			options,
			"coordinator_database_unreadable",
			`Could not open ${dbPath} as a coordinator database.`,
		);
	try {
		// The key comes first: a floor recorded without a usable key would stop new invitations.
		const keyRefused = await keyRefusal(store);
		if (keyRefused)
			return fail(
				options,
				keyRefused.code,
				`${refusalMessage(keyRefused)} The floor was not recorded.`,
			);
		const fence = await store.raiseInviteTokenLookupFloor(version);
		const progress = await sealStoredTokens(store);
		if (options.json) {
			console.log(JSON.stringify({ ok: true, ...fence, ...progress }, null, 2));
			return;
		}
		p.log.success(
			`Recorded invitation token lookup floor ${fence.min_serving_lookup_version}. This coordinator now encrypts invitation tokens.`,
		);
		p.log.info(
			`Sealed ${progress.sealed_invites} stored invitations in the last batch; ${progress.remaining_plaintext_invites} still hold their token.`,
		);
	} catch (error) {
		if (error instanceof InviteTokenRefusal)
			return fail(options, error.code, refusalMessage(error));
		return fail(
			options,
			"record_floor_failed",
			"Could not record the floor. Check the coordinator database.",
		);
	} finally {
		await store.close();
	}
}

export function buildCoordinatorRecordTokenFloorCommand() {
	const command = new Command("record-floor")
		.configureHelp(helpStyle)
		.description(
			"Confirm that no codemem release older than this invitation token lookup version opens the coordinator database, then encrypt its stored invitation tokens",
		)
		.argument(
			"<version>",
			`lookup version; at most ${INVITE_TOKEN_LOOKUP_VERSION} for this release`,
		);
	addDbOption(command);
	addJsonOption(command);
	return command.action(recordFloor);
}
