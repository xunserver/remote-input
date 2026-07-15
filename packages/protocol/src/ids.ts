let nextId = 0;

export type IdFactory = () => string;

export function createProtocolId(prefix: "request" | "operation" | "heartbeat"): string {
  nextId = (nextId + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}-${Date.now().toString(36)}-${nextId.toString(36)}`;
}

export function createRequestId(): string {
  return createProtocolId("request");
}

export function createOperationId(): string {
  return createProtocolId("operation");
}

export function createHeartbeatId(): string {
  return createProtocolId("heartbeat");
}
