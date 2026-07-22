export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_MESSAGE_BYTES = 256 * 1024;

/** Default UTF-8 byte limit for one DATA.payload chunk (64 KiB). */
export const CHUNK_PAYLOAD_BYTES = 64 * 1024;
/**
 * Maximum number of chunks permitted for one reassembled Session payload. The
 * splitter is code-point safe and can leave up to three bytes unused at a
 * boundary, so the bound uses a conservative effective chunk size.
 */
export const MAX_CHUNKS_PER_TRANSFER = Math.ceil(
  MAX_MESSAGE_BYTES / (CHUNK_PAYLOAD_BYTES - 3),
);
/** Default number of unacknowledged chunks for the active transfer. */
export const MAX_IN_FLIGHT_CHUNKS = 4;

export const MAX_QUEUED_MESSAGES = 128;
export const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
export const ACK_TIMEOUT_MS = 2_000;
export const MAX_SEND_ATTEMPTS = 3;
export const CLOSE_ACK_TIMEOUT_MS = 2_000;

export const DEFAULT_WEBSOCKET_PATH = "/ws";
