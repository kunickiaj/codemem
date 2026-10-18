import { setupHistoricalStore } from "./coordinator-auth-historical-store-test-fixture.js";
import type { HistoricalAccountDefect } from "./coordinator-auth-historical-test-fixture.js";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import { commitWriterFixture as bindCommitWriter } from "./coordinator-owner-enrollment-commit-test-fixtures.js";
import {
	ownerStartFixture as bindOwnerStart,
	config,
	seedOwnerCallbackGroups,
} from "./coordinator-owner-enrollment-start-test-fixtures.js";
import { pendingOwner } from "./coordinator-owner-enrollment-test-harness.js";

export interface OwnerAccountHistoryOptions {
	authority?: "controller_attestation" | "device_claim";
	defect?: HistoricalAccountDefect;
}

// Core-only import boundary: portable browser/signing helpers must not pull in filesystem history.
export function ownerStartFixture(options: OwnerAccountHistoryOptions = {}) {
	const prepared = setupHistoricalStore("SQLite", {
		history: {
			authority: options.authority ?? "controller_attestation",
			defect: options.defect,
			issuer: config.issuer,
			revision: "b".repeat(64),
			bornAtMs: NOW - 1000,
		},
		authClock: () => NOW,
	});
	try {
		return bindOwnerStart(prepared);
	} catch (error) {
		prepared.close();
		throw error;
	}
}

/** Grants are independent historical controller receipts, including in device-claim exclusion tests. */
export const seedOwnerCallbackAuthority = seedOwnerCallbackGroups;

export async function commitWriterFixture(options: OwnerAccountHistoryOptions = {}) {
	const prepared = setupHistoricalStore("SQLite", {
		history: {
			authority: options.authority ?? "controller_attestation",
			defect: options.defect,
			issuer: pendingOwner.issuer,
			revision: "b".repeat(64),
			bornAtMs: NOW - 1000,
		},
		authClock: () => NOW,
	});
	try {
		return await bindCommitWriter(prepared);
	} catch (error) {
		prepared.close();
		throw error;
	}
}
