import { lstatSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Database } from "./db.js";
import { resolveGitRepositoryIdentity } from "./project.js";
import { cleanProjectIdentity } from "./project-identity.js";
import {
	loadRepositoryDiscoveryEvidence,
	type RepositoryWorkspaceEvidence,
	replaceRepositoryDiscoveryEvidence,
	repositoryDiscoveryRevision,
} from "./repository-discovery-index.js";
import {
	normalizeRepositoryWorkspaceIdentity,
	recordedRepositoryIdentitySetsByWorkspace,
	repositoryIdentityMapFromEvidence,
} from "./repository-mapping-aliases.js";

const POSITIVE_DISCOVERY_TTL_MS = 5_000;

interface DiscoverySnapshot {
	revision: number;
	rows: Array<RepositoryWorkspaceEvidence & { recordedIdentities: string[] }>;
	knownRecorded: Set<string>;
	anchors: Map<string, string>;
	expiresAt: number;
	identityMaps: Map<string, Map<string, string>>;
}

const snapshots = new WeakMap<Database, DiscoverySnapshot>();

function statFingerprint(path: string): string | null {
	try {
		const stat = statSync(path, { bigint: true });
		return `${stat.dev}:${stat.ino}:${stat.mtimeNs}`;
	} catch {
		return null;
	}
}

function gitMarkerState(path: string): "missing" | "present" | "uncertain" {
	try {
		lstatSync(join(path, ".git"));
		return "present";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "uncertain";
	}
}

function anchorFingerprint(path: string): string | null {
	const fingerprint = statFingerprint(path);
	if (!fingerprint) return null;
	let current = path;
	while (true) {
		if (gitMarkerState(current) !== "missing") return null;
		const parent = dirname(current);
		if (parent === current) return fingerprint;
		current = parent;
	}
}

function anchored(path: string | null): { path: string; mtimeNs: string } | null {
	if (!path) return null;
	const mtimeNs = anchorFingerprint(path);
	return mtimeNs ? { path, mtimeNs } : null;
}

function missingGitAnchor(cwd: string): { path: string; mtimeNs: string } | null {
	if (!isAbsolute(cwd)) return null;
	let path = resolve(cwd);
	let anchorPath: string | null = null;
	while (true) {
		if (statFingerprint(path) && !anchorPath) anchorPath = path;
		if (gitMarkerState(path) !== "missing") return null;
		const parent = dirname(path);
		if (parent === path) return anchored(anchorPath);
		path = parent;
	}
}

function inspectWorkspace(
	cwd: string,
	recordedIdentities: string[],
	checkedAtMs: number,
): RepositoryWorkspaceEvidence | null {
	if (recordedIdentities.length > 0) {
		return {
			cwd,
			recordedIdentitiesJson: JSON.stringify(recordedIdentities),
			filesystemIdentity: null,
			filesystemAnchor: null,
			anchorMtimeNs: null,
			checkedAtMs,
		};
	}
	const filesystemIdentity = normalizeRepositoryWorkspaceIdentity(
		resolveGitRepositoryIdentity(cwd)?.identity,
	);
	const anchor = filesystemIdentity ? null : missingGitAnchor(cwd);
	if (!filesystemIdentity && !anchor) return null;
	return {
		cwd,
		recordedIdentitiesJson: "[]",
		filesystemIdentity,
		filesystemAnchor: anchor?.path ?? null,
		anchorMtimeNs: anchor?.mtimeNs ?? null,
		checkedAtMs,
	};
}

function buildSnapshot(db: Database, revision: number): RepositoryWorkspaceEvidence[] | null {
	const recorded = recordedRepositoryIdentitySetsByWorkspace(db);
	const workspaces = db
		.prepare("SELECT DISTINCT cwd FROM sessions WHERE cwd IS NOT NULL AND TRIM(cwd) <> ''")
		.pluck()
		.all() as string[];
	const byCwd = new Map<string, RepositoryWorkspaceEvidence>();
	const now = Date.now();
	for (const workspace of workspaces) {
		const cwd = normalizeRepositoryWorkspaceIdentity(workspace);
		if (!cwd || byCwd.has(cwd)) continue;
		const row = inspectWorkspace(cwd, [...(recorded.get(cwd) ?? [])], now);
		if (!row) return null;
		byCwd.set(cwd, row);
	}
	const rows = [...byCwd.values()];
	return replaceRepositoryDiscoveryEvidence(db, revision, rows) ? rows : null;
}

function parseRecordedIdentities(row: RepositoryWorkspaceEvidence): string[] | null {
	if (!row.cwd || row.cwd !== normalizeRepositoryWorkspaceIdentity(row.cwd)) return null;
	try {
		const identities: unknown = JSON.parse(row.recordedIdentitiesJson);
		if (!Array.isArray(identities) || identities.some((identity) => typeof identity !== "string")) {
			return null;
		}
		return identities;
	} catch {
		return null;
	}
}

function recordAnchor(
	row: RepositoryWorkspaceEvidence,
	recordedIdentities: string[],
	anchors: Map<string, string>,
): boolean {
	if (!row.filesystemAnchor || !row.anchorMtimeNs) {
		return Boolean(row.filesystemIdentity || recordedIdentities.length > 0);
	}
	const previous = anchors.get(row.filesystemAnchor);
	if (previous && previous !== row.anchorMtimeNs) return false;
	anchors.set(row.filesystemAnchor, row.anchorMtimeNs);
	return true;
}

function parseSnapshot(
	revision: number,
	rows: RepositoryWorkspaceEvidence[],
): DiscoverySnapshot | null {
	const knownRecorded = new Set<string>();
	const anchors = new Map<string, string>();
	let expiresAt = Number.POSITIVE_INFINITY;
	const parsed = [] as DiscoverySnapshot["rows"];
	for (const row of rows) {
		const recordedIdentities = parseRecordedIdentities(row);
		if (!recordedIdentities) return null;
		for (const identity of recordedIdentities) knownRecorded.add(identity);
		if (row.filesystemIdentity)
			expiresAt = Math.min(expiresAt, row.checkedAtMs + POSITIVE_DISCOVERY_TTL_MS);
		if (!recordAnchor(row, recordedIdentities, anchors)) return null;
		parsed.push({ ...row, recordedIdentities });
	}
	return { revision, rows: parsed, knownRecorded, anchors, expiresAt, identityMaps: new Map() };
}

function stillFresh(snapshot: DiscoverySnapshot): boolean {
	if (Date.now() >= snapshot.expiresAt) return false;
	for (const [path, mtimeNs] of snapshot.anchors) {
		if (anchorFingerprint(path) !== mtimeNs) return false;
	}
	return true;
}

function currentSnapshot(db: Database, revision: number): DiscoverySnapshot | null {
	const cached = snapshots.get(db);
	if (cached?.revision === revision && stillFresh(cached)) return cached;
	const saved = cached?.revision === revision ? null : loadRepositoryDiscoveryEvidence(db);
	const restored = saved ? parseSnapshot(revision, saved) : null;
	if (restored && stillFresh(restored)) {
		snapshots.set(db, restored);
		return restored;
	}
	let rows: RepositoryWorkspaceEvidence[] | null;
	try {
		rows = buildSnapshot(db, revision);
	} catch {
		return null;
	}
	if (!rows) return null;
	const rebuilt = parseSnapshot(revision, rows);
	if (!rebuilt || !stillFresh(rebuilt)) return null;
	snapshots.set(db, rebuilt);
	return rebuilt;
}

export function repositoryIdentitiesFromIndexedEvidence(
	db: Database,
	knownRepositoryIdentities: Array<string | null | undefined>,
): { identities: Map<string, string>; known: Set<string> } | null {
	const revision = repositoryDiscoveryRevision(db);
	if (revision == null) return null;
	const snapshot = currentSnapshot(db, revision);
	if (!snapshot) return null;
	const known = new Set(snapshot.knownRecorded);
	for (const identity of knownRepositoryIdentities) {
		const normalized = normalizeRepositoryWorkspaceIdentity(cleanProjectIdentity(identity));
		if (normalized) known.add(normalized);
	}
	const key = JSON.stringify([...known].toSorted());
	let identities = snapshot.identityMaps.get(key);
	if (!identities) {
		identities = repositoryIdentityMapFromEvidence(snapshot.rows, known);
		snapshot.identityMaps.set(key, identities);
	}
	if (repositoryDiscoveryRevision(db) !== revision) return null;
	return { identities, known };
}
