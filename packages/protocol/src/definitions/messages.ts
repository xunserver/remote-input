/** 当前应用协议版本。所有线上消息都必须显式携带该版本。 */
export const protocolVersion = 1 as const;

/** Codec 接受的单个完整协议消息上限，按编码后的字节数计算。 */
export const maxProtocolMessageBytes = 256 * 1024;

/** `input.submit` 文本上限，按 UTF-8 字节数而不是 JavaScript 字符数计算。 */
export const maxInputBytes = 64 * 1024;

/** 会话客户端名称的 JavaScript 字符串长度上限。 */
export const maxClientNameLength = 80;

/** 单个 Session 允许同时等待 Response 的 Request 数量上限。 */
export const maxPendingRequests = 128;

/** Server 对外公布的网络信息。 */
export type ServerInfo = {
  port: number;
  lanAddresses: string[];
};

/** `session.open` 后为当前连接分配的对端身份。 */
export type PeerInfo = {
  id: string;
  type: string;
  name: string;
  metadata?: Record<string, unknown>;
};

/** 面向其他客户端广播的最小 Peer 信息。 */
export type PeerSummary = {
  id: string;
  name: string;
  remoteAddress?: string;
};

/** 会话建立时由下游声明的协议能力。 */
export type ProtocolCapabilities = {
  methods: ProtocolMethod[];
  notifications: ProtocolNotificationName[];
};

/** 跨下游保持稳定的公共操作状态。具体执行阶段由 `stage` 表达。 */
export type OperationState = "accepted" | "processing" | "succeeded" | "failed";

/** 输入操作的可查询、可订阅状态快照。 */
export type OperationStatus = {
  /** 由提交方创建，并在请求、查询和通知之间保持不变。 */
  operationId: string;

  /** 同一 operation 的单调递增版本，用于丢弃重复或乱序状态。 */
  revision: number;
  state: OperationState;

  /** 下游自定义执行阶段，不应被公共 SDK 解释为固定设备阶段。 */
  stage: string;

  /** 百分比进度，取值范围由运行时校验为 0 到 100。 */
  progress: number;
  message: string;
};

/** 建立应用会话所需的客户端信息。 */
export type SessionOpenParams = {
  clientName: string;
};

/** 应用会话建立成功后协商得到的身份与能力。 */
export type SessionOpenResult = {
  protocolVersion: typeof protocolVersion;
  peer: PeerInfo;
  capabilities: ProtocolCapabilities;
};

export type InputSubmitParams = {
  /** 发送方生成的业务幂等标识；重试同一操作时必须复用。 */
  operationId: string;
  text: string;
};

/** 下游接受输入操作后返回的关联信息。 */
export type InputSubmitResult = {
  operationId: string;
};

/** 主动查询一个长期输入操作。 */
export type OperationGetParams = {
  operationId: string;
};

/** 协议方法到请求体的唯一类型映射。 */
export type ProtocolRequestMap = {
  "session.open": SessionOpenParams;
  "input.submit": InputSubmitParams;
  "operation.get": OperationGetParams;
};

/** 协议方法到成功响应体的唯一类型映射。 */
export type ProtocolResultMap = {
  "session.open": SessionOpenResult;
  "input.submit": InputSubmitResult;
  "operation.get": OperationStatus;
};

/** 当前协议支持的请求方法名。 */
export type ProtocolMethod = keyof ProtocolRequestMap;

/** 当前会话可见 Peer 列表的完整快照。 */
export type SessionPeersNotification = {
  count: number;
  peers: PeerSummary[];
};

/** 下游主动推送的通知名称到通知体的唯一类型映射。 */
export type ProtocolNotificationMap = {
  "operation.status": OperationStatus;
  "session.peers": SessionPeersNotification;
};

/** 当前协议支持的通知名。 */
export type ProtocolNotificationName = keyof ProtocolNotificationMap;

/**
 * 一次需要响应的协议调用。
 * `requestId` 只关联本次 Request/Response，不等同于长期业务 `operationId`。
 */
export type RequestMessage<M extends ProtocolMethod = ProtocolMethod> = M extends ProtocolMethod
  ? {
      v: typeof protocolVersion;
      kind: "request";
      requestId: string;
      method: M;
      body: ProtocolRequestMap[M];
    }
  : never;

/** 可跨端传递的结构化协议错误。 */
export type ProtocolError = {
  code: string;
  message: string;
  retryable: boolean;
};

/** 成功 Response；`requestId` 必须与原 Request 相同。 */
export type SuccessResponseMessage = {
  v: typeof protocolVersion;
  kind: "response";
  requestId: string;
  ok: true;
  body: unknown;
};

/** 失败 Response；`requestId` 必须与原 Request 相同。 */
export type ErrorResponseMessage = {
  v: typeof protocolVersion;
  kind: "response";
  requestId: string;
  ok: false;
  error: ProtocolError;
};

/** Request 的成功或失败响应。 */
export type ResponseMessage = SuccessResponseMessage | ErrorResponseMessage;

/** 单向协议通知。Notification 没有 `requestId`，接收端也不发送 Response。 */
export type NotificationMessage<N extends ProtocolNotificationName = ProtocolNotificationName> =
  N extends ProtocolNotificationName
    ? {
        v: typeof protocolVersion;
        kind: "notification";
        name: N;
        body: ProtocolNotificationMap[N];
      }
    : never;

/** Session 发起的活性探测。 */
export type PingMessage = {
  v: typeof protocolVersion;
  kind: "ping";
  heartbeatId: string;
};

/** 对 Ping 的响应，必须回显相同的 `heartbeatId`。 */
export type PongMessage = {
  v: typeof protocolVersion;
  kind: "pong";
  heartbeatId: string;
};

/** Codec 可以编码或解码的完整应用协议消息联合。 */
export type ProtocolMessage = RequestMessage | ResponseMessage | NotificationMessage | PingMessage | PongMessage;
