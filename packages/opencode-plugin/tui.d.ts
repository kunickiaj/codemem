export type CodememTuiSetup = (
	context: unknown,
) => Promise<(() => Promise<void> | void) | void> | (() => Promise<void> | void) | void;

export interface CodememTuiPlugin {
	readonly id: string;
	readonly setup: CodememTuiSetup;
}

export declare function createCodememTuiPlugin(options?: {
	readonly maxSeenNotices?: number;
	readonly replayTimeoutMs?: number;
}): CodememTuiPlugin;

declare const plugin: CodememTuiPlugin;
export default plugin;
