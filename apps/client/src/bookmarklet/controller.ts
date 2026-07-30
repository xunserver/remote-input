import type { BookmarkletView } from "./view";
import { createBookmarkletView } from "./view";
import type {
  BookmarkletController,
  BookmarkletMessage,
  ControllerMode,
  SelectionMessage,
} from "./types";

const hostId = "remote-input-bookmarklet-host";
const popupName = "remote-input-bookmarklet-popup";
const readinessTimeout = 5_000;

function isMessage(value: unknown): value is BookmarkletMessage {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  return (
    value.type === "remote-input:ready" ||
    value.type === "remote-input:close" ||
    value.type === "remote-input:selection"
  );
}

export function createController(
  bookmarkletPageUrl: URL,
): BookmarkletController {
  const senderOrigin = bookmarkletPageUrl.origin;
  let mode: ControllerMode = "loading";
  let view: BookmarkletView | null = null;
  let popupWindow: Window | null = null;
  let frameReady = false;
  let popupReady = false;
  let readinessTimer: number | undefined;
  let requestSequence = 0;
  let currentRequest: SelectionMessage | null = null;

  const isPopupOpen = (): boolean =>
    Boolean(popupWindow && !popupWindow.closed);

  const createRequest = (
    text: string,
    autoSend: boolean,
  ): SelectionMessage => ({
    autoSend,
    requestId: ++requestSequence,
    text: String(text),
    type: "remote-input:selection",
  });

  const postRequest = (target: Window | null): void => {
    if (target && currentRequest) {
      target.postMessage(currentRequest, senderOrigin);
    }
  };

  const hideOverlay = (): void => {
    if (view) view.host.hidden = true;
  };

  const showFallback = (): void => {
    if (!view || frameReady || isPopupOpen()) return;
    mode = "fallback";
    view.host.hidden = false;
    view.frame.hidden = true;
    view.fallback.classList.add("visible");
  };

  const showIframe = (): void => {
    if (!view) return;
    mode = "iframe";
    view.host.hidden = false;
    view.frame.hidden = false;
    view.fallback.classList.remove("visible");
  };

  const resetClosedPopup = (): void => {
    if (popupWindow?.closed) {
      popupWindow = null;
      popupReady = false;
    }
  };

  const openOrFocusPopup = (autoSend = false): void => {
    if (!view || !currentRequest) return;
    currentRequest.autoSend = autoSend;
    resetClosedPopup();
    if (isPopupOpen()) {
      mode = "popup";
      popupWindow?.focus();
      if (popupReady) postRequest(popupWindow);
      hideOverlay();
      return;
    }

    popupReady = false;
    popupWindow = window.open(bookmarkletPageUrl.href, popupName);
    if (popupWindow) {
      mode = "popup";
      view.fallbackText.textContent =
        "已打开独立发送页，后续点击书签会直接复用。";
      popupWindow.focus();
      hideOverlay();
    } else {
      mode = "fallback";
      view.host.hidden = false;
      view.fallbackText.textContent =
        "浏览器阻止了新页面，请允许此网站打开弹窗后再次点击。";
    }
  };

  const handleMessage = (event: MessageEvent<unknown>): void => {
    if (event.origin !== senderOrigin || !isMessage(event.data)) return;

    if (event.source === view?.frame.contentWindow) {
      if (event.data.type === "remote-input:ready") {
        frameReady = true;
        window.clearTimeout(readinessTimer);
        if (isPopupOpen() || mode === "popup") return;
        showIframe();
        postRequest(view.frame.contentWindow);
      } else if (event.data.type === "remote-input:close") {
        hideOverlay();
      }
      return;
    }

    if (popupWindow && event.source === popupWindow) {
      if (event.data.type === "remote-input:ready") {
        popupReady = true;
        mode = "popup";
        postRequest(popupWindow);
        hideOverlay();
      } else if (event.data.type === "remote-input:close") {
        popupReady = false;
        popupWindow = null;
        mode = "fallback";
      }
    }
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && mode === "iframe") hideOverlay();
  };

  const ensureView = (): void => {
    if (view) return;
    view = createBookmarkletView(hostId, bookmarkletPageUrl);
    view.host._remoteInputUpdate = (text, autoSend = true) =>
      open(text, autoSend);
    view.backdrop.addEventListener("click", (event) => {
      if (
        mode === "iframe" &&
        event.target &&
        !view?.panel.contains(event.target as Node)
      ) {
        hideOverlay();
      }
    });
    view.popupButton.addEventListener("click", () =>
      openOrFocusPopup(false),
    );
    view.frame.addEventListener("error", showFallback);
    readinessTimer = window.setTimeout(showFallback, readinessTimeout);
  };

  const open = (text = "", autoSend = true): void => {
    currentRequest = createRequest(text, autoSend);
    ensureView();
    resetClosedPopup();

    if (isPopupOpen()) {
      openOrFocusPopup(autoSend);
    } else if (mode === "fallback" || mode === "popup") {
      openOrFocusPopup(autoSend);
    } else {
      if (view) view.host.hidden = false;
      if (frameReady && view) {
        showIframe();
        postRequest(view.frame.contentWindow);
      }
    }
  };

  const dispose = (): void => {
    window.clearTimeout(readinessTimer);
    window.removeEventListener("message", handleMessage);
    window.removeEventListener("keydown", handleKeyDown, true);
    view?.host.remove();
    view = null;
    popupWindow = null;
  };

  window.addEventListener("message", handleMessage);
  window.addEventListener("keydown", handleKeyDown, true);

  return {
    dispose,
    get mode() {
      resetClosedPopup();
      return mode;
    },
    open,
    openPopup: openOrFocusPopup,
    version: 3,
  };
}
