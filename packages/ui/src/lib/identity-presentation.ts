// Keep machine-shaped cases synchronized with core/src/project-invite-identity.ts.
const UUID_LABEL = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const MACHINE_PREFIX_LABEL = /^(?:actor|device|identity|local):\S+$/iu;
const MACHINE_SLUG_LABEL = /^(?:actor|device|identity)[_-][a-z0-9][a-z0-9._:-]{4,}$/iu;
const PENDING_PERSON_LABEL = /^pending[_-]\S+$/iu;
const HEX_HOSTNAME_LABEL = /^[a-f0-9]{12,64}$/iu;

export const MACHINE_PRESENTATION_LABEL_FIXTURES = [
	"123e4567-e89b-12d3-a456-426614174000",
	"local:0ea043cc-c61c-427d-8b77-572331b9855c",
	"actor:peer",
	"device_abc123def",
	"pending_ab",
	"pending-brian",
	"pending_0123456789abcdef0123456789abcdef01234567",
	"a1b2c3d4e5f6",
] as const;

export function isMachinePresentationLabel(value: string): boolean {
	return [
		UUID_LABEL,
		MACHINE_PREFIX_LABEL,
		MACHINE_SLUG_LABEL,
		PENDING_PERSON_LABEL,
		HEX_HOSTNAME_LABEL,
	].some((pattern) => pattern.test(value));
}

export function humanPresentationLabel(value: unknown): string {
	if (typeof value !== "string") return "";
	if ([...value].some((character) => /[\p{Cc}\p{Cf}]/u.test(character))) return "";
	const label = value.replace(/\s+/gu, " ").trim();
	if (!label || [...label].length > 120 || isMachinePresentationLabel(label)) return "";
	return label;
}
