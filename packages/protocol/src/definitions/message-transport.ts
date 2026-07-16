/** Transport 对 Session 暴露的连接状态。 */
export type TransportState = "idle" | "connecting" | "connected" | "disconnected" | "error";

/** Transport 向上层发布的状态、完整消息或错误事件。 */
export type TransportEvent =
  | { type: "state"; state: TransportState }
  | { type: "message"; message: Uint8Array }
  | { type: "error"; error: unknown };

/** 接收 Transport 事件的监听器。 */
export type TransportListener = (event: TransportEvent) => void;

/**
 * 可靠、有序且保留消息边界的双工字节消息通道。
 *
 * 物理链路可以不可靠，但实现必须在内部补齐分片、重组、ACK、重试和排序，
 * 使 Session 始终只处理完整的 `Uint8Array` 消息。
 */
export interface MessageTransport {
  /** 用于诊断和观测的实现类型，不参与协议序列化。 */
  readonly kind: string;
  readonly state: TransportState;

  /** 建立消息通道；完成时状态应为 `connected`。 */
  connect(): Promise<void>;

  /** 主动关闭通道；允许重复调用。 */
  disconnect(): Promise<void>;

  /**
   * 发送一个完整字节消息。
   *
   * Promise 完成表示对端 Transport 已确认收到完整消息；不代表远端 Session
   * 已解析消息，也不代表远端已处理或完成对应业务。
   */
  send(message: Uint8Array): Promise<void>;

  /** 订阅事件，并返回幂等的取消订阅函数。 */
  subscribe(listener: TransportListener): () => void;
}
