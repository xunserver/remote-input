import type { ProtocolMessage } from "./messages.js";

/**
 * 应用协议消息与 Transport 字节消息之间的编码边界。
 *
 * 实现必须把 `decode` 的输入视为不可信数据，并在返回前完成运行时校验。
 * 分片、重组、ACK 和重试属于具体 Transport，不属于 Codec。
 */
export interface MessageCodec {
  /** 将一个完整协议消息编码为一个完整字节消息。 */
  encode(message: ProtocolMessage): Uint8Array;

  /** 解码并校验一个完整字节消息；非法输入应抛出错误。 */
  decode(message: Uint8Array): ProtocolMessage;
}
