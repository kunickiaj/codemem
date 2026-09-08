export const DIAGNOSTIC_SEVERITIES = ["info", "warning", "error"] as const;
export const DIAGNOSTIC_SUBSYSTEMS = [
	"viewer",
	"observer",
	"capture",
	"sync",
	"storage",
	"maintenance",
] as const;

export const DIAGNOSTIC_RECOVERY_HREFS = ["#health", "#advanced/sync/diagnostics"] as const;

const MAX_EVENT_COUNT = 100;
const MAX_ID_LENGTH = 128;
const MAX_TIMESTAMP_LENGTH = 64;
const MAX_CODE_LENGTH = 128;
const MAX_MESSAGE_LENGTH = 2_000;
const MAX_LABEL_LENGTH = 256;
const MAX_COMMAND_LENGTH = 2_000;
const MAX_TECHNICAL_DETAIL_LENGTH = 2_000;
const MAX_CURSOR_LENGTH = 2_048;

export type DiagnosticEventSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number];
export type DiagnosticEventSubsystem = (typeof DIAGNOSTIC_SUBSYSTEMS)[number];
export type DiagnosticRecoveryHref = (typeof DIAGNOSTIC_RECOVERY_HREFS)[number];

export type DiagnosticEvent = {
	id: string;
	occurred_at: string;
	severity: DiagnosticEventSeverity;
	subsystem: DiagnosticEventSubsystem;
	code: string;
	message: string;
	recovery?: { label: string; href?: DiagnosticRecoveryHref; command?: string };
	correlation?: { kind: "session" | "device" | "operation"; label: string };
	technical_detail?: { available: boolean; text?: string };
};

export type DiagnosticEventsResponse = {
	contract_version: 1;
	items: DiagnosticEvent[];
	next_cursor: string | null;
	redacted: boolean;
	generated_at: string;
};

export type LoadDiagnosticEventsOptions = {
	limit?: number;
	cursor?: string;
	severity?: DiagnosticEventSeverity[];
	subsystem?: DiagnosticEventSubsystem[];
	includeTechnical?: boolean;
	signal?: AbortSignal;
};

export class DiagnosticEventsRequestError extends Error {
	constructor(
		readonly status: number,
		statusText: string,
	) {
		super(`Diagnostics request failed: ${status} ${statusText}`);
		this.name = "DiagnosticEventsRequestError";
	}
}

function buildDiagnosticParams(options: LoadDiagnosticEventsOptions): string {
	const params = new URLSearchParams();
	if (typeof options.limit === "number") params.set("limit", String(options.limit));
	if (options.cursor) params.set("cursor", options.cursor);
	if (options.severity?.length) params.set("severity", options.severity.join(","));
	if (options.subsystem?.length) params.set("subsystem", options.subsystem.join(","));
	params.set("includeTechnical", options.includeTechnical ? "1" : "0");
	return params.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function isBoundedString(value: unknown, maximum: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function isTimestamp(value: unknown): value is string {
	return isBoundedString(value, MAX_TIMESTAMP_LENGTH) && Number.isFinite(Date.parse(value));
}

export function isDiagnosticRecoveryHref(value: unknown): value is DiagnosticRecoveryHref {
	return (
		typeof value === "string" && DIAGNOSTIC_RECOVERY_HREFS.includes(value as DiagnosticRecoveryHref)
	);
}

function isRecovery(value: unknown): value is NonNullable<DiagnosticEvent["recovery"]> {
	if (!isRecord(value) || !hasOnlyKeys(value, ["label", "href", "command"])) return false;
	if (!isBoundedString(value.label, MAX_LABEL_LENGTH)) return false;
	if (value.href !== undefined && !isDiagnosticRecoveryHref(value.href)) return false;
	return value.command === undefined || isBoundedString(value.command, MAX_COMMAND_LENGTH);
}

function isCorrelation(value: unknown): value is NonNullable<DiagnosticEvent["correlation"]> {
	if (!isRecord(value) || !hasOnlyKeys(value, ["kind", "label"])) return false;
	if (!isBoundedString(value.label, MAX_LABEL_LENGTH)) return false;
	return value.kind === "session" || value.kind === "device" || value.kind === "operation";
}

function isTechnicalDetail(
	value: unknown,
): value is NonNullable<DiagnosticEvent["technical_detail"]> {
	if (!isRecord(value) || !hasOnlyKeys(value, ["available", "text"])) return false;
	if (typeof value.available !== "boolean") return false;
	if (value.text === undefined) return true;
	return value.available && isBoundedString(value.text, MAX_TECHNICAL_DETAIL_LENGTH);
}

function isDiagnosticEvent(value: unknown): value is DiagnosticEvent {
	if (!isRecord(value)) return false;
	if (
		!hasOnlyKeys(value, [
			"id",
			"occurred_at",
			"severity",
			"subsystem",
			"code",
			"message",
			"recovery",
			"correlation",
			"technical_detail",
		])
	) {
		return false;
	}
	if (!isBoundedString(value.id, MAX_ID_LENGTH) || !isTimestamp(value.occurred_at)) return false;
	if (!DIAGNOSTIC_SEVERITIES.includes(value.severity as DiagnosticEventSeverity)) return false;
	if (!DIAGNOSTIC_SUBSYSTEMS.includes(value.subsystem as DiagnosticEventSubsystem)) return false;
	if (!isBoundedString(value.code, MAX_CODE_LENGTH)) return false;
	if (!isBoundedString(value.message, MAX_MESSAGE_LENGTH)) return false;
	if (value.recovery !== undefined && !isRecovery(value.recovery)) return false;
	if (value.correlation !== undefined && !isCorrelation(value.correlation)) return false;
	return value.technical_detail === undefined || isTechnicalDetail(value.technical_detail);
}

function parseDiagnosticEventsResponse(value: unknown): DiagnosticEventsResponse | null {
	if (!isRecord(value) || value.contract_version !== 1) return null;
	if (!Array.isArray(value.items) || value.items.length > MAX_EVENT_COUNT) return null;
	let nextCursor: string | null = null;
	if (value.next_cursor !== null) {
		if (!isBoundedString(value.next_cursor, MAX_CURSOR_LENGTH)) return null;
		nextCursor = value.next_cursor;
	}
	if (typeof value.redacted !== "boolean" || !isTimestamp(value.generated_at)) return null;
	return {
		contract_version: 1,
		items: value.items.filter(isDiagnosticEvent),
		next_cursor: nextCursor,
		redacted: value.redacted,
		generated_at: value.generated_at,
	};
}

export async function loadDiagnosticEvents(
	options: LoadDiagnosticEventsOptions = {},
): Promise<DiagnosticEventsResponse> {
	const query = buildDiagnosticParams(options);
	const response = await fetch(`/api/diagnostics/events?${query}`, {
		cache: "no-store",
		method: "GET",
		signal: options.signal,
	});
	if (!response.ok) {
		throw new DiagnosticEventsRequestError(response.status, response.statusText);
	}
	const parsed = parseDiagnosticEventsResponse(await response.json());
	if (!parsed) throw new Error("Unsupported diagnostics response");
	return parsed;
}
