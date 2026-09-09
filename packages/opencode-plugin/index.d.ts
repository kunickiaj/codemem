import type { Plugin as OpenCodeV1Plugin } from "@opencode-ai/plugin";

export type CodememV2Setup = (
	context: unknown,
) => Promise<(() => Promise<void> | void) | void> | (() => Promise<void> | void) | void;

export type CodememDualPlugin = {
	readonly id: string;
	readonly server: OpenCodeV1Plugin;
	readonly setup: CodememV2Setup;
};

export declare const CodememPlugin: OpenCodeV1Plugin;

/** @deprecated Use CodememPlugin. */
export declare const OpencodeMemPlugin: typeof CodememPlugin;

declare const plugin: CodememDualPlugin;
export default plugin;
