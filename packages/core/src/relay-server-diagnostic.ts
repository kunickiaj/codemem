/** Fixed branch labels only. Never put peer-supplied text in a diagnostic. */
export const RELAY_DIAGNOSTIC_REASONS = {
	restore_known_socket: "registration_replaced",
	restore_device_conflict: "registration_replaced",
	binary_exception: "protocol",
	physical_close: "socket_teardown",
	engine_shutdown: "socket_teardown",
	setup_expired: "socket_teardown",
	challenge_expired: "socket_teardown",
	control_buffer_preflight: "buffer_limit",
	control_write_callback: "send_failed",
	control_buffer_after_send: "buffer_limit",
	control_send_exception: "send_failed",
	pending_control: "protocol",
	control_queue_limit: "buffer_limit",
	text_exception: "protocol",
	control_quota: "quota_unavailable",
	control_exception: "protocol",
	unexpected_control: "protocol",
	service_context: "protocol",
	service_proof: "socket_teardown",
	registration_context: "protocol",
	registration_denied: "socket_teardown",
	registration_key_replaced: "registration_replaced",
	registration_conflict: "registration_replaced",
	registration_buffer: "buffer_limit",
	registration_snapshot: "socket_teardown",
	registration_replaced: "registration_replaced",
	open_control_quota: "quota_unavailable",
	route_expired: "route_expired",
	route_control_nonparticipant: "protocol",
	peer_abort: "peer_abort",
	end_before_accepted: "protocol",
	duplicate_end: "protocol",
	invalid_route_control: "protocol",
	data_pending_socket: "protocol",
	data_nonparticipant: "protocol",
	data_route_limits: "route_limit",
	data_buffer_limit: "buffer_limit",
	orphan_outside_restore: "protocol",
	orphan_limit: "protocol",
	orphan_exception: "protocol",
	orphan_control_quota: "quota_unavailable",
	restored_route_lost: "restored_route_lost",
	traffic_reservation_exception: "quota_unavailable",
	traffic_quota: "quota_unavailable",
	forward_recipient_or_buffer: "recipient_unavailable",
	forward_buffer_preflight: "buffer_limit",
	data_write_callback: "send_failed",
	forward_buffer_after_send: "buffer_limit",
	data_send_exception: "send_failed",
	input_pressure_exception: "socket_teardown",
	worker_operator_disable: "socket_teardown",
	worker_config_missing_fetch: "socket_teardown",
	worker_config_missing_event: "socket_teardown",
	worker_peer_close: "socket_teardown",
	worker_peer_error: "socket_teardown",
	worker_accept_failed: "socket_teardown",
	worker_host_missing: "socket_teardown",
	worker_restore_failed: "socket_teardown",
	worker_control_oversize: "protocol",
	worker_data_oversize: "protocol",
	worker_close_grace: "socket_teardown",
} as const;

export type RelayDiagnosticSite = keyof typeof RELAY_DIAGNOSTIC_REASONS;
export interface RelayDiagnosticDirection {
	readonly queuedFrames: number;
	readonly queuedBytes: number;
	readonly writes: number;
	readonly credit: number;
	readonly nextGrant: number;
	readonly waiting: boolean;
	readonly ended: boolean;
	readonly pendingEnd: boolean;
	readonly endForwarded: boolean;
}
export interface RelayDiagnosticConnection {
	readonly phase: "service" | "signing" | "register" | "checking" | "ready";
	readonly pending: boolean;
	readonly closing: boolean;
	readonly physicalClosed: boolean;
	readonly restored: boolean;
	readonly held: number;
	readonly writes: number;
	readonly registrationRemainingMs: number | null;
}
export interface RelayServerDiagnostic {
	readonly event: "route_abort" | "orphan_abort";
	/** SHA256 of the existing lowercase session text, UTF-8 encoded, first 16 hex digits. */
	readonly trace: string;
	readonly reason: (typeof RELAY_DIAGNOSTIC_REASONS)[RelayDiagnosticSite];
	readonly site: RelayDiagnosticSite;
	readonly side: "source" | "target" | null;
	readonly accepted: boolean;
	readonly bytes: number;
	readonly frames: number;
	readonly queuedFrames: number;
	readonly pendingWrites: number;
	readonly waitingDirections: number;
	readonly remainingMs: number | null;
	/** Route-owned queued DATA plus outstanding DATA writes. Never reads adapter buffers. */
	readonly queuedBytes: number;
	/** Source-to-target, then target-to-source. Null when the original route is lost. */
	readonly directions: readonly [RelayDiagnosticDirection, RelayDiagnosticDirection] | null;
	readonly source: RelayDiagnosticConnection | null;
	readonly target: RelayDiagnosticConnection | null;
}
