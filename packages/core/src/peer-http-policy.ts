export const PEER_HTTP_LIMITS = Object.freeze({
	headerBytes: 16384,
	requestBytes: 1048576,
	responseBytes: 16777216,
	exchangeMs: 60000,
	cleanupMs: 1500,
});

export type PeerHttpExchangeErrorCode =
	| "framing"
	| "response_too_large"
	| "deadline"
	| "cancelled"
	| "transport"
	| "cleanup";

const MESSAGES: Record<PeerHttpExchangeErrorCode, string> = {
	framing: "Invalid peer HTTP framing",
	response_too_large: "Peer HTTP response exceeds the size limit",
	deadline: "Peer HTTP exchange deadline exceeded",
	cancelled: "Peer HTTP exchange cancelled",
	transport: "Peer HTTP transport failed",
	cleanup: "Peer HTTP cleanup failed",
};

export class PeerHttpExchangeError extends Error {
	constructor(readonly code: PeerHttpExchangeErrorCode) {
		super(MESSAGES[code]);
		this.name = "PeerHttpExchangeError";
	}
}
