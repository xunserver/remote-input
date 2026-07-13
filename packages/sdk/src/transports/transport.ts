export type TransportEvent =
  | { type: "open" }
  | { type: "message"; data: string }
  | { type: "close" }
  | { type: "error"; error?: unknown };

export type TransportListener = (event: TransportEvent) => void;

export interface InputTransport {
  readonly isOpen: boolean;
  connect(): void;
  disconnect(): void;
  send(data: string): void;
  subscribe(listener: TransportListener): () => void;
}
