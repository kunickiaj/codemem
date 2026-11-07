export const DEFAULT_DRAIN_LIMIT: number;
export const DEFAULT_MAX_ENTRIES: number;
export const MAX_REJECTED_RAW_EVENT_INSPECTION_BYTES: number;
export const RAW_EVENT_SPOOL_CONFLICT_CODE: "raw_event_spool_conflict";
export const RAW_EVENT_SPOOL_FULL_CODE: "raw_event_spool_full";

export interface RejectedRawEventMetadata {
	receipt: string;
	bytes: number;
	status: 400 | 413;
	reason: "invalid_payload" | "payload_too_large";
}

export type RejectedRawEventInspection =
	| (RejectedRawEventMetadata & { validation: "valid"; serialized: string })
	| (RejectedRawEventMetadata & {
			validation: "invalid" | "read_limit_exceeded" | "changed_during_read";
	  });

export class RawEventSpoolInspectionError extends Error {
	code: string;
	constructor(code: string, message: string);
}

export function resolveSpoolDirectory(homeDir?: string): string;
export function listRejectedRawEventSpoolEntries(options: {
	homeDir?: string;
	validation: "metadata";
}): Promise<(RejectedRawEventMetadata & { validation: "not_checked" })[]>;
export function listRejectedRawEventSpoolEntries(options?: {
	homeDir?: string;
	validation?: "payload";
}): Promise<RejectedRawEventMetadata[]>;
export function inspectRejectedRawEventSpoolEntry(options: {
	receipt: string;
	homeDir?: string;
	maxBytes?: number;
}): Promise<RejectedRawEventInspection>;
export function writeRawEventSpoolEntry(options: {
	envelope: Record<string, unknown>;
	serialized?: string;
	homeDir?: string;
	maxEntries?: number;
}): Promise<{ eventId: string; serialized: string }>;
export function retainRejectedRawEventSpoolEntry(options: {
	eventId: string;
	status: 400 | 413;
	reason: "invalid_payload" | "payload_too_large";
	homeDir?: string;
}): Promise<RejectedRawEventMetadata>;
export function removeRawEventSpoolEntry(options: {
	eventId: string;
	homeDir?: string;
}): Promise<void>;
export function loadRawEventSpoolEntries(options?: { homeDir?: string; limit?: number }): Promise<{
	entries: { eventId: string; envelope: Record<string, unknown>; serialized: string }[];
	corruptCount: number;
}>;
