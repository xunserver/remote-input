import { randomUUID } from "node:crypto";

export type MessageSource = "websocket" | "hid";
export type MessageStatus = "queued" | "processing" | "succeeded" | "failed";

export type ReceivedMessage = {
  id: string;
  source: MessageSource;
  text: string;
  receivedAt: string;
  status: MessageStatus;
  error?: string;
};

export type MessageStoreEvent =
  | { type: "message"; message: ReceivedMessage }
  | { type: "cleared" };

export type MessageStoreListener = (event: MessageStoreEvent) => void;

/** Keeps a bounded, in-memory history and publishes immutable snapshots. */
export class MessageStore {
  private readonly messages: ReceivedMessage[] = [];
  private readonly listeners = new Set<MessageStoreListener>();

  constructor(private readonly capacity = 100) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new TypeError("MessageStore capacity must be a positive integer.");
    }
  }

  create(source: MessageSource, text: string): ReceivedMessage {
    const message: ReceivedMessage = {
      id: randomUUID(),
      source,
      text,
      receivedAt: new Date().toISOString(),
      status: "queued",
    };
    this.messages.push(message);
    if (this.messages.length > this.capacity) {
      this.messages.splice(0, this.messages.length - this.capacity);
    }
    this.emit({ type: "message", message: cloneMessage(message) });
    return cloneMessage(message);
  }

  update(
    id: string,
    update: Pick<ReceivedMessage, "status"> & { error?: string },
  ): ReceivedMessage | undefined {
    const index = this.messages.findIndex((message) => message.id === id);
    if (index < 0) return undefined;
    const current = this.messages[index]!;
    const next: ReceivedMessage = {
      id: current.id,
      source: current.source,
      text: current.text,
      receivedAt: current.receivedAt,
      status: update.status,
      ...(update.error === undefined ? {} : { error: update.error }),
    };
    this.messages[index] = next;
    this.emit({ type: "message", message: cloneMessage(next) });
    return cloneMessage(next);
  }

  snapshot(): ReceivedMessage[] {
    return this.messages.map(cloneMessage);
  }

  clear(): void {
    this.messages.length = 0;
    this.emit({ type: "cleared" });
  }

  subscribe(listener: MessageStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: MessageStoreEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

function cloneMessage(message: ReceivedMessage): ReceivedMessage {
  return { ...message };
}
