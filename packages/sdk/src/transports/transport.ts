export type TransportState = "idle" | "connecting" | "connected" | "disconnected" | "error";

export type TransportEvent =
  | { type: "state"; state: TransportState }
  | { type: "message"; message: Uint8Array }
  | { type: "error"; error: unknown };

export type TransportListener = (event: TransportEvent) => void;

export interface DuplexTransport {
  readonly kind: string;
  readonly state: TransportState;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: Uint8Array): Promise<void>;
  subscribe(listener: TransportListener): () => void;
}
