import type { Rpc } from "@opencode/plugin/rpc";

export type CodememNotificationVariant = "info" | "success" | "warning" | "error";

export interface CodememNotification {
	readonly id: string;
	readonly message: string;
	readonly variant: CodememNotificationVariant;
}

export declare const CODEMEM_NOTIFICATION_RPC_ID: "codemem.notifications";
export declare const CodememNotifications: Rpc.PortableDefinition;
