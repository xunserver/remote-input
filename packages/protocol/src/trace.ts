export type ProtocolTraceLevel = "summary" | "chunks";

export type ProtocolTraceValue = string | number | boolean | null;

export type ProtocolTraceDetails = Readonly<
  Record<string, ProtocolTraceValue>
>;

export type ProtocolTraceEvent = Readonly<{
  at: number;
  layer: "transport" | "session";
  event: string;
  details: ProtocolTraceDetails;
}>;

export type ProtocolTraceListener = (
  event: ProtocolTraceEvent,
) => void | PromiseLike<void>;

export function parseProtocolTraceLevel(
  value: string | undefined,
): ProtocolTraceLevel | undefined {
  if (
    value === undefined ||
    value === "" ||
    value === "0" ||
    value === "false" ||
    value === "off"
  ) {
    return undefined;
  }
  if (value === "1" || value === "true" || value === "summary") {
    return "summary";
  }
  if (value === "chunks") {
    return "chunks";
  }
  throw new RangeError(
    `Protocol trace level must be "summary", "chunks", or "off"; received ${JSON.stringify(value)}.`,
  );
}

export function createConsoleProtocolTracer(
  label: string,
): ProtocolTraceListener {
  let sequence = 0;
  return (traceEvent) => {
    sequence += 1;
    const sequenceText = String(sequence).padStart(4, "0");
    const atText = Number.isInteger(traceEvent.at)
      ? String(traceEvent.at)
      : traceEvent.at.toFixed(1);
    const layer = traceEvent.layer === "transport" ? "传输层" : "会话层";
    const message = formatConsoleTraceMessage(traceEvent);
    console.log(
      `[协议][${label}][${sequenceText}][t=${atText}][${layer}][${traceEvent.event}] ${message}`,
    );
  };
}

const eventLabels: Readonly<Record<string, string>> = {
  "state.changed": "连接状态变更",
  "transfer.queued": "消息进入发送队列",
  "transfer.started": "开始传输消息",
  "transfer.delivery": "消息交付状态变更",
  "transfer.completed": "传输完成",
  "transfer.failed": "传输失败",
  "transfer.reassembled": "所有 chunk 重组完成",
  "receiver.accept.start": "开始把报文交给 Session",
  "receiver.accept.done": "Session 已同步接收报文",
  "control.send": "尝试发送控制帧",
  "request.pending": "请求已加入 PendingMap",
  "request.delivery": "请求交付状态变更",
  "request.received": "收到 Session 请求",
  "response.received": "收到 Session 响应",
  "handler.scheduled": "Handler 已调度",
  "handler.started": "Handler 开始执行",
  "handler.completed": "Handler 执行完成",
  "response.send": "准备发送响应",
  "response.sent": "响应已交付",
  "response.sendFailed": "响应发送失败",
  "request.resolved": "请求 Promise 已成功完成",
  "request.rejected": "请求 Promise 已失败",
  "transport.disconnected": "Transport 连接断开",
  "transport.closed": "Transport 已关闭",
  "session.close": "Session 开始关闭",
};

const detailLabels: Readonly<Record<string, string>> = {
  generation: "连接代次",
  transferId: "传输ID",
  messageType: "报文类型",
  requestId: "请求ID",
  payloadBytes: "Session报文字节",
  chunkIndex: "chunk序号",
  chunkCount: "chunk总数",
  chunkBytes: "chunk内容字节",
  frameBytes: "DATA帧字节",
  attempt: "累计发送次数",
  acknowledgedChunks: "已确认chunk数",
  receivedChunks: "已暂存chunk数",
  totalPayloadBytes: "累计内容字节",
  inFlightChunks: "窗口占用",
  window: "窗口大小",
  queueTransfers: "队列传输数",
  queuedBytes: "队列字节",
  state: "状态",
  delivery: "投递状态",
  previous: "原投递状态",
  pendingCount: "Pending数量",
  deadlineAt: "截止时刻",
  peerEpoch: "对端代次",
  matchedPending: "匹配Pending",
  handlerRegistered: "已注册Handler",
  completed: "传输已完成",
  ok: "成功",
  errorCode: "错误码",
  reason: "原因",
  kind: "控制帧",
};

function formatConsoleTraceMessage(traceEvent: ProtocolTraceEvent): string {
  const details = traceEvent.details;
  switch (traceEvent.event) {
    case "chunk.send":
      return joinTraceParts(`尝试发送 ${formatChunkReference(details)}`, [
        formatDetail(details, "transferId", "传输ID"),
        formatAttempt(details, false),
        formatByteDetail(details, "frameBytes", "完整DATA帧"),
        formatWindow(details),
        formatDetail(details, "generation", "连接代次"),
      ]);
    case "chunk.received":
      return joinTraceParts(`收到 ${formatChunkReference(details)}`, [
        formatDetail(details, "transferId", "传输ID"),
        formatByteDetail(details, "chunkBytes", "内容"),
        formatDetail(details, "generation", "连接代次"),
      ]);
    case "chunk.cached":
      return joinTraceParts(`暂存 ${formatChunkReference(details)}`, [
        formatDetail(details, "transferId", "传输ID"),
        formatProgress(details, "receivedChunks", "已暂存"),
        formatByteDetail(details, "totalPayloadBytes", "累计内容"),
        formatDetail(details, "generation", "连接代次"),
      ]);
    case "chunk.duplicate":
      return joinTraceParts(`收到重复 ${formatChunkReference(details)}`, [
        formatDetail(details, "transferId", "传输ID"),
        formatDuplicateStage(details),
        formatDetail(details, "generation", "连接代次"),
      ]);
    case "ack.send":
      return joinTraceParts(
        `尝试发送 ${formatChunkReference(details)} 的 ACK`,
        [
          formatDetail(details, "transferId", "传输ID"),
          formatDetail(details, "generation", "连接代次"),
        ],
      );
    case "chunk.ack.received":
      return joinTraceParts(`收到 ${formatChunkReference(details)} 的 ACK`, [
        formatDetail(details, "transferId", "传输ID"),
        formatProgress(details, "acknowledgedChunks", "已确认"),
        formatAttempt(details, true),
        formatDetail(details, "generation", "连接代次"),
      ]);
    case "transfer.reassembled":
      return joinTraceParts("所有 chunk 重组完成", [
        formatDetail(details, "transferId", "传输ID"),
        formatDetail(details, "chunkCount", "chunk总数"),
        formatByteDetail(details, "payloadBytes", "Session报文"),
        formatDetail(details, "generation", "连接代次"),
      ]);
    case "transfer.completed":
      return joinTraceParts("全部 chunk 已收到 ACK，Transport.send() 可以完成", [
        formatDetail(details, "transferId", "传输ID"),
        formatDetail(details, "chunkCount", "chunk总数"),
        formatByteDetail(details, "frameBytes", "全部DATA帧"),
        formatDetail(details, "generation", "连接代次"),
      ]);
    default: {
      const eventLabel = eventLabels[traceEvent.event] ?? traceEvent.event;
      const formattedDetails = Object.entries(details).map(([key, value]) => {
        const detailLabel = detailLabels[key] ?? key;
        return `${detailLabel}=${formatDetailValue(key, value)}`;
      });
      return joinTraceParts(eventLabel, formattedDetails);
    }
  }
}

function formatChunkReference(details: ProtocolTraceDetails): string {
  const chunkIndex = readNumberDetail(details, "chunkIndex");
  const chunkCount = readNumberDetail(details, "chunkCount");
  const ordinal = chunkIndex === undefined ? "?" : String(chunkIndex + 1);
  return chunkCount === undefined
    ? `chunk ${ordinal}`
    : `chunk ${ordinal}/${chunkCount}`;
}

function formatAttempt(
  details: ProtocolTraceDetails,
  acknowledged: boolean,
): string | undefined {
  const attempt = readNumberDetail(details, "attempt");
  if (attempt === undefined) {
    return undefined;
  }
  return acknowledged
    ? `ACK到达时累计发送=${attempt}次`
    : `第${attempt}次尝试`;
}

function formatProgress(
  details: ProtocolTraceDetails,
  key: string,
  label: string,
): string | undefined {
  const current = readNumberDetail(details, key);
  if (current === undefined) {
    return undefined;
  }
  const chunkCount = readNumberDetail(details, "chunkCount");
  return chunkCount === undefined
    ? `${label}=${current}`
    : `${label}=${current}/${chunkCount}`;
}

function formatWindow(details: ProtocolTraceDetails): string | undefined {
  const inFlight = readNumberDetail(details, "inFlightChunks");
  const window = readNumberDetail(details, "window");
  if (inFlight === undefined && window === undefined) {
    return undefined;
  }
  return `窗口占用=${inFlight ?? "?"}/${window ?? "?"}`;
}

function formatDuplicateStage(
  details: ProtocolTraceDetails,
): string | undefined {
  const completed = readTraceDetail(details, "completed");
  return typeof completed === "boolean"
    ? `阶段=${completed ? "已交付" : "组装中"}`
    : undefined;
}

function formatByteDetail(
  details: ProtocolTraceDetails,
  key: string,
  label: string,
): string | undefined {
  const value = readNumberDetail(details, key);
  return value === undefined ? undefined : `${label}=${value}B`;
}

function formatDetail(
  details: ProtocolTraceDetails,
  key: string,
  label: string,
): string | undefined {
  const value = readTraceDetail(details, key);
  return value === undefined
    ? undefined
    : `${label}=${formatDetailValue(key, value)}`;
}

function readNumberDetail(
  details: ProtocolTraceDetails,
  key: string,
): number | undefined {
  const value = readTraceDetail(details, key);
  return typeof value === "number" ? value : undefined;
}

function readTraceDetail(
  details: ProtocolTraceDetails,
  key: string,
): ProtocolTraceValue | undefined {
  return Object.hasOwn(details, key) ? details[key] : undefined;
}

function joinTraceParts(
  title: string,
  parts: readonly (string | undefined)[],
): string {
  const availableParts = parts.filter(
    (part): part is string => part !== undefined,
  );
  return availableParts.length === 0
    ? title
    : `${title}：${availableParts.join("，")}`;
}

function formatDetailValue(key: string, value: ProtocolTraceValue): string {
  if (value === null) {
    return "无";
  }
  if (typeof value === "boolean") {
    return value ? "是" : "否";
  }
  if (key === "chunkIndex" && typeof value === "number") {
    return String(value + 1);
  }
  if (key === "state" && typeof value === "string") {
    return translateValue(value, {
      idle: "空闲",
      connecting: "连接中",
      connected: "已连接",
      closing: "关闭中",
      closed: "已关闭",
    });
  }
  if ((key === "delivery" || key === "previous") && typeof value === "string") {
    return translateValue(value, {
      not_sent: "未发送",
      unknown: "已发送但未确认",
      delivered: "已确认送达",
    });
  }
  if (key === "messageType" && typeof value === "string") {
    return translateValue(value, {
      request: "请求",
      response: "响应",
      "invalid-session-message": "非法Session报文",
    });
  }
  if (key === "kind" && typeof value === "string") {
    return translateValue(value, {
      CLOSE: "CLOSE（关闭）",
      CLOSE_ACK: "CLOSE_ACK（关闭确认）",
    });
  }
  if (key === "reason" && typeof value === "string") {
    return translateValue(value, {
      "Transport was closed locally.": "本地Transport已关闭",
      "The remote peer closed the session.": "对端关闭了Session",
    });
  }
  return String(value);
}

function translateValue(
  value: string,
  translations: Readonly<Record<string, string>>,
): string {
  return translations[value] ?? value;
}

export function queueProtocolTrace(
  listener: ProtocolTraceListener | undefined,
  event: ProtocolTraceEvent,
): void {
  if (listener === undefined) {
    return;
  }
  try {
    const immutableEvent = Object.freeze({
      ...event,
      details: Object.freeze({ ...event.details }),
    });
    globalThis.queueMicrotask(() => {
      try {
        const result = listener(immutableEvent);
        // Consume a returned thenable as well as synchronous observer throws.
        if (result !== undefined) {
          void Promise.resolve(result).catch(() => undefined);
        }
      } catch {
        // Trace observers are strictly observational and cannot affect protocol state.
      }
    });
  } catch {
    // Dropping debug output is safer than changing protocol behavior.
  }
}
