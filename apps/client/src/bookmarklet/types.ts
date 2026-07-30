export type BookmarkletMessage =
  | { type: "remote-input:close" }
  | { type: "remote-input:ready" }
  | {
      autoSend?: boolean;
      requestId?: number;
      text: string;
      type: "remote-input:selection";
    };

export type SelectionMessage = Extract<
  BookmarkletMessage,
  { type: "remote-input:selection" }
>;

export type BookmarkletBootstrapApi = {
  fallback?: (text: string, autoSend?: boolean) => void;
  loading?: boolean;
  messageListener?: boolean;
  open?: (text: string, autoSend?: boolean) => void;
  pending?: SelectionMessage | null;
  popup?: Window | null;
  popupReady?: boolean;
  queue?: string[];
  requestId?: number;
  version?: number;
};

export type ControllerMode = "fallback" | "iframe" | "loading" | "popup";

export type BookmarkletController = {
  dispose: () => void;
  readonly mode: ControllerMode;
  open: (text?: string, autoSend?: boolean) => void;
  openPopup: (autoSend?: boolean) => void;
  version: number;
};

export type BookmarkletWindow = Window &
  typeof globalThis & {
    __remoteInputBookmarklet?: BookmarkletBootstrapApi | BookmarkletController;
  };

export type BookmarkletHost = HTMLDivElement & {
  _remoteInputUpdate?: (text: string, autoSend?: boolean) => void;
};
