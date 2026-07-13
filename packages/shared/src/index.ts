export const protocolVersion = 1 as const;

export type ServerInfo = {
  port: number;
  lanAddresses: string[];
};

export type PeerInfo = {
  id: string;
  type: string;
  name: string;
  metadata?: Record<string, unknown>;
};

export type PeerSummary = {
  id: string;
  name: string;
  remoteAddress?: string;
};

export type ProtocolCapabilities = {
  methods: string[];
  events: string[];
};

export type OperationState = "accepted" | "processing" | "succeeded" | "failed";

export type OperationStatus = {
  operationId: string;
  revision: number;
  state: OperationState;
  stage: string;
  progress: number;
  message: string;
};

export type SessionOpenParams = {
  clientName: string;
};

export type SessionOpenResult = {
  protocolVersion: typeof protocolVersion;
  peer: PeerInfo;
  capabilities: ProtocolCapabilities;
};

export type InputSubmitParams = {
  text: string;
};

export type InputSubmitResult = {
  operationId: string;
};

export type OperationGetParams = {
  operationId: string;
};

export type OperationGetResult = OperationStatus;

export type ProtocolRequestMap = {
  "session.open": SessionOpenParams;
  "input.submit": InputSubmitParams;
  "operation.get": OperationGetParams;
};

export type ProtocolResultMap = {
  "session.open": SessionOpenResult;
  "input.submit": InputSubmitResult;
  "operation.get": OperationGetResult;
};

export type ProtocolMethod = keyof ProtocolRequestMap;

export type ProtocolEventMap = {
  "operation.status": OperationStatus;
  "session.peers": {
    count: number;
    peers: PeerSummary[];
  };
};

export type ProtocolEventName = keyof ProtocolEventMap;

export type RequestMessage<M extends ProtocolMethod = ProtocolMethod> = M extends ProtocolMethod
  ? {
      v: typeof protocolVersion;
      kind: "request";
      id: string;
      method: M;
      body: ProtocolRequestMap[M];
    }
  : never;

export type ProtocolError = {
  code: string;
  message: string;
  retryable: boolean;
};

export type SuccessResponseMessage = {
  v: typeof protocolVersion;
  kind: "response";
  id: string;
  ok: true;
  body: unknown;
};

export type ErrorResponseMessage = {
  v: typeof protocolVersion;
  kind: "response";
  id: string;
  ok: false;
  error: ProtocolError;
};

export type ResponseMessage = SuccessResponseMessage | ErrorResponseMessage;

export type EventMessage<N extends ProtocolEventName = ProtocolEventName> = N extends ProtocolEventName
  ? {
      v: typeof protocolVersion;
      kind: "event";
      name: N;
      body: ProtocolEventMap[N];
    }
  : never;

export type ProtocolMessage = RequestMessage | ResponseMessage | EventMessage;

export class ProtocolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolValidationError";
  }
}

export function parseProtocolMessage(value: unknown): ProtocolMessage {
  const message = requireRecord(value, "Protocol message");
  requireVersion(message.v);

  if (message.kind === "request") {
    const method = parseMethod(message.method);
    return {
      v: protocolVersion,
      kind: "request",
      id: requireNonEmptyString(message.id, "request.id"),
      method,
      body: parseRequestBody(method, message.body),
    } as RequestMessage;
  }

  if (message.kind === "response") {
    const id = requireNonEmptyString(message.id, "response.id");
    if (message.ok === true) {
      return {
        v: protocolVersion,
        kind: "response",
        id,
        ok: true,
        body: message.body,
      };
    }

    if (message.ok === false) {
      return {
        v: protocolVersion,
        kind: "response",
        id,
        ok: false,
        error: parseProtocolError(message.error),
      };
    }

    throw new ProtocolValidationError("response.ok must be a boolean.");
  }

  if (message.kind === "event") {
    const name = parseEventName(message.name);
    return {
      v: protocolVersion,
      kind: "event",
      name,
      body: parseEventBody(name, message.body),
    } as EventMessage;
  }

  throw new ProtocolValidationError("Unsupported protocol message kind.");
}

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
    return {
      clientName: requireNonEmptyString(body.clientName, "session.open body.clientName"),
    } as ProtocolRequestMap[M];
  }

  if (method === "input.submit") {
    return {
      text: requireString(body.text, "input.submit body.text"),
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

function parseEventBody<N extends ProtocolEventName>(name: N, value: unknown): ProtocolEventMap[N] {
  if (name === "operation.status") {
    return parseOperationStatus(value, "operation.status body") as ProtocolEventMap[N];
  }

  const body = requireRecord(value, "session.peers body");
  if (!Array.isArray(body.peers)) {
    throw new ProtocolValidationError("session.peers body.peers must be an array.");
  }

  return {
    count: requireNonNegativeInteger(body.count, "session.peers body.count"),
    peers: body.peers.map((peer, index) => parsePeerSummary(peer, index)),
  } as ProtocolEventMap[N];
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
  if (!isStringArray(capabilities.methods) || !isStringArray(capabilities.events)) {
    throw new ProtocolValidationError("capabilities methods and events must be string arrays.");
  }

  return {
    methods: capabilities.methods,
    events: capabilities.events,
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
  if (value === "session.open" || value === "input.submit" || value === "operation.get") {
    return value;
  }

  throw new ProtocolValidationError("Unsupported protocol method.");
}

function parseEventName(value: unknown): ProtocolEventName {
  if (value === "operation.status" || value === "session.peers") {
    return value;
  }

  throw new ProtocolValidationError("Unsupported protocol event name.");
}

function requireVersion(value: unknown): asserts value is typeof protocolVersion {
  if (value !== protocolVersion) {
    throw new ProtocolValidationError(`Unsupported protocol version: ${String(value)}.`);
  }
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
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
    throw new ProtocolValidationError(`${name} cannot be empty.`);
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
  const result = requireNumber(value, name);
  if (!Number.isInteger(result) || result < 0) {
    throw new ProtocolValidationError(`${name} must be a non-negative integer.`);
  }

  return result;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isOperationState(value: unknown): value is OperationState {
  return value === "accepted" || value === "processing" || value === "succeeded" || value === "failed";
}
