/** Separate proof domain from initial account linking. Safe for runtime clients. */
export const AUTH_ACCOUNT_CHANGE_PURPOSE = "coordinator-account-change-v1";
export type CoordinatorAccountChangeIntent = "refresh" | "disconnect";
