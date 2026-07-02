export const SERVICE_UUID = "9e7b0001-4f2a-4d3b-9c2a-0d6c9a120001";
export const CONTROL_UUID = "9e7b0002-4f2a-4d3b-9c2a-0d6c9a120001";
export const DATA_UUID = "9e7b0003-4f2a-4d3b-9c2a-0d6c9a120001";
export const STATUS_UUID = "9e7b0004-4f2a-4d3b-9c2a-0d6c9a120001";

export const VERSION = 2;
export const CONTROL_START = 1;
export const CONTROL_COMMIT = 2;
export const CONTROL_CONFIG = 3;
export const DATA_FRAME = 16;
export const MAX_TEXT_BYTES = 128 * 1024;
export const DATA_PAYLOAD_BYTES = 180;
export const DEFAULT_KEY_DELAY_MS = 20;
export const MIN_KEY_DELAY_MS = 1;
export const MAX_KEY_DELAY_MS = 200;

export const STATES = ["idle", "receiving", "typing", "done", "error"] as const;

export type RemoteInputState = (typeof STATES)[number];
