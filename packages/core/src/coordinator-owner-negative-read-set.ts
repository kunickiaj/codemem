import {
	type ControllerHistorySnapshot,
	captureControllerHistory,
} from "./coordinator-auth-controller-history.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import {
	type AuthReadSnapshot,
	type ReadSnapshotOptions,
	readSnapshot,
} from "./coordinator-auth-read-set.js";
import {
	classifyEvidence,
	type EvidenceRow,
	type EvidenceRows,
	type EvidenceSubject,
} from "./coordinator-device-ownership-evidence-classify.js";
import { BYTE_LIMIT } from "./coordinator-device-ownership-evidence-queries.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import {
	capturedCatalogState,
	type NegativeOwnerSubject,
	parseEvidenceRows,
	sourcePins,
} from "./coordinator-owner-negative-consistency.js";
import {
	anyNamespaceResolutionsRead,
	discoveredReads,
	evidenceReads,
	NEGATIVE_CATALOG_READ,
	retainedResolutionsRead,
	sourcesRead,
} from "./coordinator-owner-negative-reads.js";
import { sqlEq } from "./coordinator-sql-compare.js";

/**
 * Read-set form of prepareNegativeOwnerConsistency: the same reads, the same
 * classification, and guards in place of the statement that pinned them.
 *
 * Like that statement, the result never grants owner authority. It only says that no
 * retained legacy owner fact for the subject contradicts the producer's owner.
 */
export interface NegativeOwnerGuards {
	/** Re-run every read the decision used. They go in the batch that writes. */
	guards: AuthLinkStatement[];
	/**
	 * Re-run only the resolution catalog, the subject's retained resolutions and their
	 * original sources. A producer's own writes never change these, so they may run after
	 * them. They match the old pin's retained recheck.
	 */
	retainedGuards: AuthLinkStatement[];
}

type Backend = Pick<AuthLinkBackend, "first" | "all" | "readBatch">;
type EvidenceText = (string | null)[];

const both = (guards: AuthLinkStatement[]): NegativeOwnerGuards => ({
	guards,
	retainedGuards: guards,
});

/** null refuses. The catalog guard also covers the table appearing later. */
function catalogState(rows: unknown[]): "missing" | "ready" | null {
	const encoded = JSON.stringify(rows);
	const state = capturedCatalogState(encoded);
	if (state === "unsupported" || (state === "missing" && rows.length !== 0)) return null;
	return state;
}

/** Returns null when the subject's retained ownership forbids the owner or cannot be read. */
export async function readNegativeOwnerConsistency(
	backend: Backend,
	input: NegativeOwnerSubject,
	options: ReadSnapshotOptions = {},
): Promise<NegativeOwnerGuards | null> {
	try {
		const catalog = await readSnapshot<{ catalog: unknown[] }>(
			backend,
			{ catalog: NEGATIVE_CATALOG_READ },
			options,
		);
		const state = catalogState(catalog.rows.catalog);
		if (state === null) return null;
		// The missing-schema guard never names the absent table.
		if (state === "missing") return both([catalog.guards.catalog]);
		const keyId = await ed25519KeyIdForRevocation(input.publicKey);
		const retained = await readSnapshot<{ resolutions: unknown[] }>(
			backend,
			{ resolutions: retainedResolutionsRead(input, keyId) },
			options,
		);
		const fixed = { catalog: catalog.guards.catalog, retained: retained.guards.resolutions };
		// No retained fact for this subject keeps ordinary admission; the guards pin absence.
		if (retained.rows.resolutions.length === 0) return both([fixed.catalog, fixed.retained]);
		return await readResolvedOwnerConsistency(backend, input, keyId, fixed, options);
	} catch {
		return null;
	}
}

/**
 * The negative owner check for old internal callers that name no coordinator. It allows
 * only a device with no retained resolution anywhere, and never infers a namespace.
 */
export async function readUnknownNamespaceOwnerConsistency(
	backend: Backend,
	input: Pick<NegativeOwnerSubject, "deviceId" | "publicKey">,
): Promise<NegativeOwnerGuards | null> {
	try {
		const catalog = await readSnapshot<{ catalog: unknown[] }>(backend, {
			catalog: NEGATIVE_CATALOG_READ,
		});
		const state = catalogState(catalog.rows.catalog);
		if (state === null) return null;
		if (state === "missing") return both([catalog.guards.catalog]);
		const keyId = await ed25519KeyIdForRevocation(input.publicKey);
		const retained = await readSnapshot<{ resolutions: unknown[] }>(backend, {
			resolutions: anyNamespaceResolutionsRead(input.deviceId, keyId),
		});
		if (retained.rows.resolutions.length !== 0) return null;
		return both([catalog.guards.catalog, retained.guards.resolutions]);
	} catch {
		return null;
	}
}

async function readResolvedOwnerConsistency(
	backend: Backend,
	input: NegativeOwnerSubject,
	keyId: string | null,
	fixed: { catalog: AuthLinkStatement },
	options: ReadSnapshotOptions,
): Promise<NegativeOwnerGuards | null> {
	// The old evidence statement needed a backend that returns rows; keep refusing without one.
	const all = backend.all?.bind(backend);
	if (!all) throw new Error("ownership_evidence_reader_unavailable");
	// Classification uses this captured history. The evidence reads select the same rows
	// again; they must still equal it, and their guards then pin it to the write.
	const history =
		input.verifiedHistory ??
		(await captureControllerHistory(
			{
				coordinatorId: input.coordinatorId,
				deviceId: input.deviceId,
				publicKey: input.publicKey,
				fingerprint: input.fingerprint,
			},
			<T>(sql: string, values: string[]) => all<T>({ sql, values }),
		));
	const subject: EvidenceSubject = {
		coordinatorId: input.coordinatorId,
		deviceId: input.deviceId,
		publicKey: input.publicKey,
		fingerprint: input.fingerprint,
		groupId: input.enrollment?.groupId ?? "",
		// Legacy trusted seed callers can have opaque keys. They still receive
		// device checks; no canonical-key inference is made from opaque text.
		keyId: keyId ?? "",
	};
	const evidence = await readEvidence(backend, subject, history, options);
	// A change between capture and the evidence reads would be pinned but never classified.
	// A reviewed history is the caller's to check: the controller review compares it with
	// the live rows and guards that comparison, as its old statement did.
	if (!input.verifiedHistory && !sameHistory(evidence.rows, history)) return null;
	if (!(await ownerCompatible(evidence.rows, subject, input, history))) return null;
	// Unguarded: these reads only choose which sources to pin. The verdict read and its
	// guard check the chosen sources again, as the old pin did.
	const pin = await sourcePins(backend, evidence.rows.resolutions ?? []);
	const sources = await readSnapshot<{ sources: { matches: number | null }[] }>(
		backend,
		{ sources: sourcesRead(pin) },
		options,
	);
	const [verdict] = sources.rows.sources;
	if (sources.rows.sources.length !== 1 || !sqlEq(verdict?.matches ?? null, 1)) return null;
	// The retained guards pin the resolutions the evidence reads saw, not the earlier
	// retained read: a resolution added between the two would otherwise leave the full and
	// retained guards pinning different rows. The old pins both used the evidence rows.
	return {
		guards: [fixed.catalog, ...evidence.guards, sources.guards.sources],
		retainedGuards: [fixed.catalog, evidence.resolutionsGuard, sources.guards.sources],
	};
}

async function ownerCompatible(
	rows: EvidenceRows,
	subject: EvidenceSubject,
	input: NegativeOwnerSubject,
	history: ControllerHistorySnapshot,
): Promise<boolean> {
	const classificationRows = { ...rows };
	if (!input.enrollment)
		classificationRows.enrollment = [
			["", input.deviceId, input.publicKey, input.fingerprint, null, 1, null],
		];
	const classification = await classifyEvidence(
		classificationRows,
		subject,
		input.ownerIdentityId,
		history,
	);
	return ["compatible", "weak_label_review_required"].includes(classification.decision);
}

const rowSet = (rows: unknown[][]) => JSON.stringify(rows.map((row) => JSON.stringify(row)).sort());

/** Whether the evidence reads returned exactly the history that was captured and classified. */
function sameHistory(rows: EvidenceRows, history: ControllerHistorySnapshot): boolean {
	const captured = {
		history: history.records.map((r) => [
			r.group_id,
			r.candidate_ref,
			r.manifest_version,
			r.completed_at,
			r.created_at,
			r.manifest_json,
		]),
		historyKeys: history.keys.map((key) => [key.public_key, key.fingerprint]),
		historyDiscovery: history.discoveryKeys.map((key) => [key]),
	};
	return Object.entries(captured).every(
		([name, expected]) => rowSet(rows[name] ?? []) === rowSet(expected),
	);
}

/** Parsed rows and their exact text, as the old reader returned each category. */
function parseCategory(text: EvidenceText): { rows: EvidenceRow[]; text: string[] } {
	const rows = parseEvidenceRows(text.map((row) => ({ row })));
	return { rows, text: text.map(String) };
}

function discoveredIds(discovery: EvidenceRow[]) {
	// A NULL ID never matched the old `IN (SELECT id ...)`.
	const ids = (source: string) =>
		discovery.flatMap((row) => (row[0] === source && typeof row[1] === "string" ? [row[1]] : []));
	return { controllers: ids("controller"), invites: ids("invite") };
}

/**
 * Reads every evidence category, then the controllers and invites among the discovered
 * keys. Fails like the old reader on too many rows, too many bytes or malformed rows.
 */
async function readEvidence(
	backend: Backend,
	subject: EvidenceSubject,
	history: ControllerHistorySnapshot,
	options: ReadSnapshotOptions,
): Promise<{
	rows: EvidenceRows;
	guards: AuthLinkStatement[];
	/** The guard of the resolutions category alone. */
	resolutionsGuard: AuthLinkStatement;
}> {
	const first = await readSnapshot<Record<string, EvidenceText>>(
		backend,
		evidenceReads({ subject, history }),
		options,
	);
	const discovery = parseCategory(first.rows.discovery ?? []);
	const next = await readSnapshot<Record<string, EvidenceText>>(
		backend,
		discoveredReads(subject, discoveredIds(discovery.rows)),
		options,
	);
	const snapshots: AuthReadSnapshot<Record<string, EvidenceText>>[] = [first, next];
	const categories = snapshots.flatMap((snapshot) =>
		Object.entries(snapshot.rows).map(([name, text]) => [name, parseCategory(text)] as const),
	);
	const base = {
		subject: { ...subject, fragments: history.discoveryFragments },
		legacyHistory: history,
	};
	const encoded = JSON.stringify({
		...base,
		rows: Object.fromEntries(categories.map(([name, category]) => [name, category.text])),
	});
	if (new TextEncoder().encode(encoded).byteLength > BYTE_LIMIT)
		throw new Error("ownership_evidence_too_large");
	return {
		rows: Object.fromEntries(categories.map(([name, category]) => [name, category.rows])),
		guards: snapshots.flatMap((snapshot) => Object.values(snapshot.guards)),
		resolutionsGuard: requireGuard(first.guards.resolutions),
	};
}

function requireGuard(guard: AuthLinkStatement | undefined): AuthLinkStatement {
	if (!guard) throw new Error("ownership_evidence_unavailable");
	return guard;
}
