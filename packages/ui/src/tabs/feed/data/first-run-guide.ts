export const FIRST_RUN_GUIDE_STORAGE_KEY = "codemem-first-run-guide-v1";
export const FIRST_RUN_GUIDE_CHANGED_EVENT = "codemem:first-run-guide-changed";

export type FirstRunStep = "capture" | "inspect" | "find" | "scope" | "settings-health";

export type FirstRunGuideRecord = {
	completed: FirstRunStep[];
	dismissed: boolean;
	showCompleted: boolean;
};

const EMPTY_RECORD: FirstRunGuideRecord = {
	completed: [],
	dismissed: false,
	showCompleted: false,
};

function isFirstRunStep(value: unknown): value is FirstRunStep {
	return ["capture", "inspect", "find", "scope", "settings-health"].includes(String(value));
}

export function readFirstRunGuideRecord(storage?: Storage): FirstRunGuideRecord {
	try {
		const raw = (storage ?? window.localStorage).getItem(FIRST_RUN_GUIDE_STORAGE_KEY);
		if (!raw) return { ...EMPTY_RECORD };
		const parsed = JSON.parse(raw) as Partial<FirstRunGuideRecord>;
		return {
			completed: Array.isArray(parsed.completed) ? parsed.completed.filter(isFirstRunStep) : [],
			dismissed: parsed.dismissed === true,
			showCompleted: parsed.showCompleted === true,
		};
	} catch {
		return { ...EMPTY_RECORD };
	}
}

function writeFirstRunGuideRecord(record: FirstRunGuideRecord, storage?: Storage): void {
	try {
		(storage ?? window.localStorage).setItem(FIRST_RUN_GUIDE_STORAGE_KEY, JSON.stringify(record));
	} catch {}
	window.dispatchEvent(new CustomEvent(FIRST_RUN_GUIDE_CHANGED_EVENT));
}

export function completeFirstRunStep(step: FirstRunStep, storage?: Storage): void {
	const record = readFirstRunGuideRecord(storage);
	if (record.completed.includes(step)) return;
	writeFirstRunGuideRecord(
		{ ...record, completed: [...record.completed, step], showCompleted: false },
		storage,
	);
}

export function dismissFirstRunGuide(storage?: Storage): void {
	writeFirstRunGuideRecord({ ...readFirstRunGuideRecord(storage), dismissed: true }, storage);
}

export function reopenFirstRunGuide(storage?: Storage): void {
	writeFirstRunGuideRecord(
		{ ...readFirstRunGuideRecord(storage), dismissed: false, showCompleted: true },
		storage,
	);
}

export function shouldShowFirstRunGuide(record: FirstRunGuideRecord): boolean {
	if (record.dismissed) return false;
	return record.completed.length < 5 || record.showCompleted;
}

export function focusFirstRunGuide(): void {
	queueMicrotask(() => document.getElementById("firstRunGuide")?.focus());
}
