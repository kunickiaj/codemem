interface LabelDeviceInput {
	deviceId: string;
	fingerprint: string;
	labelRedactionIds?: readonly string[];
}

interface LabelProjectInput {
	projectRef: string;
	sourceProjectIdentity: string;
	sourceFingerprint: string;
	deterministicProjectIdentity: string | null;
	targetScopeId?: string | null;
}

interface PersistedLabelDevice {
	deviceId: string;
	fingerprint: string;
	existingIdentityId: string | null;
	targetIdentityId: string | null;
}

interface PersistedLabelProject {
	projectRef: string;
	sourceProjectIdentity: string;
	sourceFingerprint: string;
	resolvedProjectIdentity: string | null;
	targetScopeId: string | null;
}

const SAFE_LABEL_PATTERN = /^[\p{L}\p{N} '&,.()_-]*$/u;

function normalize(value: string): string {
	return value
		.normalize("NFKC")
		.replace(/\p{Cf}/gu, "")
		.replace(/\p{Cc}/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

function comparable(value: string): string {
	return normalize(value).toLowerCase();
}

export function humanGroupLabelAlias(groupId: string, displayName: string): string | null {
	const comparableGroupId = comparable(groupId);
	if (!/^[a-z]{2,24}$/u.test(comparableGroupId)) return null;
	return comparable(displayName) === comparableGroupId ? comparableGroupId : null;
}

export function safeLabel(
	value: string,
	fallback: string,
	forbiddenIds: ReadonlySet<string>,
): string {
	const normalized = normalize(value.slice(0, 512));
	const sanitized = normalized.slice(0, 120).trim();
	if (!sanitized || !SAFE_LABEL_PATTERN.test(sanitized)) return fallback;
	if (/[\p{L}\p{N}]\.[\p{L}\p{N}]/u.test(sanitized)) return fallback;
	if (/-----|\b(?:ssh|ecdsa|sk)-[\p{L}\p{N}-]+ /iu.test(sanitized)) return fallback;
	const comparison = normalized.toLowerCase();
	for (const forbiddenId of forbiddenIds) {
		if (comparison.includes(forbiddenId)) return fallback;
	}
	return sanitized;
}

export function setupLabelForbiddenIds(
	contextIds: ReadonlyArray<string>,
	groupId: string,
	humanGroupAlias: string | null,
	devices: ReadonlyArray<LabelDeviceInput>,
	projects: ReadonlyArray<LabelProjectInput>,
	persistedDevices: ReadonlyArray<PersistedLabelDevice>,
	persistedProjects: ReadonlyArray<PersistedLabelProject>,
): ReadonlySet<string> {
	return new Set(
		[
			...contextIds,
			...(humanGroupAlias ? [] : [groupId]),
			...devices.flatMap((device) => [
				device.deviceId,
				device.fingerprint,
				...(device.labelRedactionIds ?? []),
			]),
			...persistedDevices.flatMap((device) => [
				device.deviceId,
				device.fingerprint,
				device.existingIdentityId ?? "",
				device.targetIdentityId ?? "",
			]),
			...projects.flatMap((project) => [
				project.projectRef,
				project.sourceProjectIdentity,
				project.sourceFingerprint,
				project.deterministicProjectIdentity ?? "",
				project.targetScopeId ?? "",
			]),
			...persistedProjects.flatMap((project) => [
				project.projectRef,
				project.sourceProjectIdentity,
				project.sourceFingerprint,
				project.resolvedProjectIdentity ?? "",
				project.targetScopeId ?? "",
			]),
		]
			.map(comparable)
			.filter(Boolean),
	);
}
