import {
  maxClientNameLength,
  maxInputBytes,
  protocolVersion,
  type NotificationMessage,
  type OperationState,
  type OperationStatus,
  type PeerInfo,
  type PeerSummary,
  type ProtocolCapabilities,
  type ProtocolError,
  type ProtocolMessage,
  type ProtocolMethod,
  type ProtocolNotificationMap,
  type ProtocolNotificationName,
  type ProtocolRequestMap,
  type ProtocolResultMap,
  type RequestMessage,
  type SessionOpenResult,
} from "../definitions/messages.js";

/** 网络输入不满足当前协议版本或结构约束。 */
export class ProtocolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolValidationError";
  }
}

/** 将不可信值解析为经过完整运行时校验的协议消息。 */
export function parseProtocolMessage(value: unknown): ProtocolMessage {
  const message = requireRecord(value, "Protocol message");
  requireVersion(message.v);

  if (message.kind === "request") {
    const method = parseMethod(message.method);
    return {
      v: protocolVersion,
      kind: "request",
      requestId: requireNonEmptyString(message.requestId, "request.requestId"),
      method,
      body: parseRequestBody(method, message.body),
    } as RequestMessage;
  }

  if (message.kind === "response") {
    const requestId = requireNonEmptyString(message.requestId, "response.requestId");
    if (message.ok === true) {
      return { v: protocolVersion, kind: "response", requestId, ok: true, body: message.body };
    }
    if (message.ok === false) {
      return {
        v: protocolVersion,
        kind: "response",
        requestId,
        ok: false,
        error: parseProtocolError(message.error),
      };
    }
    throw new ProtocolValidationError("response.ok must be a boolean.");
  }

  if (message.kind === "notification") {
    const name = parseNotificationName(message.name);
    return {
      v: protocolVersion,
      kind: "notification",
      name,
      body: parseNotificationBody(name, message.body),
    } as NotificationMessage;
  }

  if (message.kind === "ping" || message.kind === "pong") {
    return {
      v: protocolVersion,
      kind: message.kind,
      heartbeatId: requireNonEmptyString(message.heartbeatId, `${message.kind}.heartbeatId`),
    };
  }

  throw new ProtocolValidationError("Unsupported protocol message kind.");
}

/** 按请求方法校验成功 Response 的 body。 */
export function parseResultBody<M extends ProtocolMethod>(method: M, value: unknown): ProtocolResultMap[M] {
  if (method === "session.open") {
    return parseSessionOpenResult(value) as ProtocolResultMap[M];
  }
  if (method === "input.submit") {
    const result = requireRecord(value, "input.submit result");
    return {
      operationId: requireNonEmptyString(result.operationId, "input.submit result.operationId"),
    } as ProtocolResultMap[M];
  }
  return parseOperationStatus(value, "operation.get result") as ProtocolResultMap[M];
}

function parseRequestBody<M extends ProtocolMethod>(method: M, value: unknown): ProtocolRequestMap[M] {
  const body = requireRecord(value, `${method} body`);
  if (method === "session.open") {
    const clientName = requireNonEmptyString(body.clientName, "session.open body.clientName");
    if (clientName.length > maxClientNameLength) {
      throw new ProtocolValidationError(`session.open body.clientName must not exceed ${maxClientNameLength} characters.`);
    }
    return { clientName } as ProtocolRequestMap[M];
  }
  if (method === "input.submit") {
    const text = requireString(body.text, "input.submit body.text");
    if (new TextEncoder().encode(text).byteLength > maxInputBytes) {
      throw new ProtocolValidationError(`input.submit body.text must not exceed ${maxInputBytes} UTF-8 bytes.`);
    }
    return {
      operationId: requireNonEmptyString(body.operationId, "input.submit body.operationId"),
      text,
    } as ProtocolRequestMap[M];
  }
  return {
    operationId: requireNonEmptyString(body.operationId, "operation.get body.operationId"),
  } as ProtocolRequestMap[M];
}

function parseSessionOpenResult(value: unknown): SessionOpenResult {
  const result = requireRecord(value, "session.open result");
  requireVersion(result.protocolVersion);
  return {
    protocolVersion,
    peer: parsePeerInfo(result.peer),
    capabilities: parseCapabilities(result.capabilities),
  };
}

function parseNotificationBody<N extends ProtocolNotificationName>(
  name: N,
  value: unknown,
): ProtocolNotificationMap[N] {
  if (name === "operation.status") {
    return parseOperationStatus(value, "operation.status body") as ProtocolNotificationMap[N];
  }
  const body = requireRecord(value, "session.peers body");
  if (!Array.isArray(body.peers)) {
    throw new ProtocolValidationError("session.peers body.peers must be an array.");
  }
  const peers = body.peers.map((peer, index) => parsePeerSummary(peer, index));
  const count = requireNonNegativeInteger(body.count, "session.peers body.count");
  if (count !== peers.length) {
    throw new ProtocolValidationError("session.peers body.count must equal body.peers.length.");
  }
  return { count, peers } as ProtocolNotificationMap[N];
}

function parseOperationStatus(value: unknown, name: string): OperationStatus {
  const status = requireRecord(value, name);
  if (!isOperationState(status.state)) {
    throw new ProtocolValidationError(`${name}.state is invalid.`);
  }
  const progress = requireNumber(status.progress, `${name}.progress`);
  if (progress < 0 || progress > 100) {
    throw new ProtocolValidationError(`${name}.progress must be between 0 and 100.`);
  }
  return {
    operationId: requireNonEmptyString(status.operationId, `${name}.operationId`),
    revision: requireNonNegativeInteger(status.revision, `${name}.revision`),
    state: status.state,
    stage: requireString(status.stage, `${name}.stage`),
    progress,
    message: requireString(status.message, `${name}.message`),
  };
}

function parsePeerInfo(value: unknown): PeerInfo {
  const peer = requireRecord(value, "peer");
  if (peer.metadata !== undefined) {
    requireRecord(peer.metadata, "peer.metadata");
  }
  return {
    id: requireNonEmptyString(peer.id, "peer.id"),
    type: requireNonEmptyString(peer.type, "peer.type"),
    name: requireNonEmptyString(peer.name, "peer.name"),
    ...(peer.metadata === undefined ? {} : { metadata: peer.metadata as Record<string, unknown> }),
  };
}

function parsePeerSummary(value: unknown, index: number): PeerSummary {
  const peer = requireRecord(value, `session.peers body.peers[${index}]`);
  if (peer.remoteAddress !== undefined && typeof peer.remoteAddress !== "string") {
    throw new ProtocolValidationError(`session.peers body.peers[${index}].remoteAddress must be a string.`);
  }
  return {
    id: requireNonEmptyString(peer.id, `session.peers body.peers[${index}].id`),
    name: requireNonEmptyString(peer.name, `session.peers body.peers[${index}].name`),
    ...(peer.remoteAddress === undefined ? {} : { remoteAddress: peer.remoteAddress }),
  };
}

function parseCapabilities(value: unknown): ProtocolCapabilities {
  const capabilities = requireRecord(value, "capabilities");
  if (!Array.isArray(capabilities.methods) || !capabilities.methods.every(isProtocolMethod)) {
    throw new ProtocolValidationError("capabilities.methods must contain supported protocol methods.");
  }
  if (!Array.isArray(capabilities.notifications) || !capabilities.notifications.every(isNotificationName)) {
    throw new ProtocolValidationError("capabilities.notifications must contain supported protocol notifications.");
  }
  return {
    methods: [...capabilities.methods],
    notifications: [...capabilities.notifications],
  };
}

function parseProtocolError(value: unknown): ProtocolError {
  const error = requireRecord(value, "response.error");
  if (typeof error.retryable !== "boolean") {
    throw new ProtocolValidationError("response.error.retryable must be a boolean.");
  }
  return {
    code: requireNonEmptyString(error.code, "response.error.code"),
    message: requireString(error.message, "response.error.message"),
    retryable: error.retryable,
  };
}

function parseMethod(value: unknown): ProtocolMethod {
  if (!isProtocolMethod(value)) {
    throw new ProtocolValidationError("request.method is unsupported.");
  }
  return value;
}

function parseNotificationName(value: unknown): ProtocolNotificationName {
  if (!isNotificationName(value)) {
    throw new ProtocolValidationError("notification.name is unsupported.");
  }
  return value;
}

function isProtocolMethod(value: unknown): value is ProtocolMethod {
  return value === "session.open" || value === "input.submit" || value === "operation.get";
}

function isNotificationName(value: unknown): value is ProtocolNotificationName {
  return value === "operation.status" || value === "session.peers";
}

function requireVersion(value: unknown): void {
  if (value !== protocolVersion) {
    throw new ProtocolValidationError(`Protocol version must be ${protocolVersion}.`);
  }
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolValidationError(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new ProtocolValidationError(`${name} must be a string.`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, name: string): string {
  const result = requireString(value, name);
  if (!result) {
    throw new ProtocolValidationError(`${name} must not be empty.`);
  }
  return result;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProtocolValidationError(`${name} must be a finite number.`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ProtocolValidationError(`${name} must be a non-negative integer.`);
  }
  return value;
}

function isOperationState(value: unknown): value is OperationState {
  return value === "accepted" || value === "processing" || value === "succeeded" || value === "failed";
}
