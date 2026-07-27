import type { MessageSource, MessageStore } from "../messages/message-store.js";
import type { InputQueue } from "./input-queue.js";

export type AcceptText = (source: MessageSource, text: string) => Promise<void>;

export function createInputService(
  store: MessageStore,
  queue: InputQueue,
): AcceptText {
  return async (source, text) => {
    const message = store.create(source, text);
    await queue.enqueue(message);
  };
}
