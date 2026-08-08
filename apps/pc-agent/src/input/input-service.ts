import type { MessageSource, MessageStore } from "../messages/message-store.js";
import type { InputQueue } from "./input-queue.js";
import type {
  InputStatus,
  RemoteInputCommand,
} from "@remote-input/sdk";

export type AcceptInput = (
  source: MessageSource,
  command: RemoteInputCommand,
  onStatus?: (status: InputStatus) => void,
) => Promise<void>;

export function createInputService(
  store: MessageStore,
  queue: InputQueue,
): AcceptInput {
  return async (source, command, onStatus) => {
    const message = store.create(
      source,
      "key" in command ? `[${command.key}]` : command.text,
    );
    await queue.enqueue(message, command, onStatus);
  };
}
