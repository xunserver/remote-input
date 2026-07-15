let nextId = 0;

/**
 * 创建带语义前缀的进程内关联 ID。
 * 该 ID 用于诊断和消息关联，不应用作凭证或安全随机数。
 */
export function createProtocolId(prefix: "request" | "operation" | "heartbeat"): string {
  nextId = (nextId + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}-${Date.now().toString(36)}-${nextId.toString(36)}`;
}

/** 创建一次 Request/Response 关联 ID。 */
export function createRequestId(): string {
  return createProtocolId("request");
}

/** 创建长期输入操作 ID。 */
export function createOperationId(): string {
  return createProtocolId("operation");
}

/** 创建一次 Ping/Pong 关联 ID。 */
export function createHeartbeatId(): string {
  return createProtocolId("heartbeat");
}
