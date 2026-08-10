/**
 * Synthetic placeholder cwd used for sessions created during sync bootstrap.
 * Keep this in a dependency-free module so policy code can use it without
 * pulling the Node-only bootstrap runtime into Cloudflare Worker bundles.
 */
export const SYNC_BOOTSTRAP_CWD_PREFIX = "__sync_bootstrap__";
