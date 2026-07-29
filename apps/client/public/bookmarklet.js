(() => {
  "use strict";

  const apiKey = "__remoteInputBookmarklet";
  const hostId = "remote-input-bookmarklet-host";
  const queryKey = "remote-input-bookmarklet";
  const script = document.currentScript;
  const loaderUrl = new URL(script?.src || window.location.href);
  // GitHub Pages redirects the legacy project URL to the custom domain, but
  // HTMLScriptElement.src keeps the originally requested URL. Normalize that
  // legacy address so iframe navigation and postMessage always use the actual
  // final origin. Existing installed bookmarks therefore keep working.
  const senderUrl =
    loaderUrl.origin === "https://xunserver.github.io" &&
    loaderUrl.pathname.startsWith("/remote-input/")
      ? new URL("https://blog.xunserver.cn/remote-input/")
      : new URL(".", loaderUrl);
  senderUrl.searchParams.set(queryKey, "1");
  senderUrl.searchParams.set(
    "_",
    loaderUrl.searchParams.get("_") || String(Date.now()),
  );
  senderUrl.hash = "";
  const senderOrigin = senderUrl.origin;
  const previousApi = window[apiKey];
  const queuedSelections = Array.isArray(previousApi?.queue)
    ? previousApi.queue.slice()
    : [];
  const popupName = "remote-input-bookmarklet-popup";

  function element(tagName, className, text) {
    const target = document.createElement(tagName);
    if (className) target.className = className;
    if (text) target.textContent = text;
    return target;
  }

  function createController() {
    let mode = "loading";
    let host = null;
    let frame = null;
    let panel = null;
    let fallback = null;
    let fallbackText = null;
    let popupWindow = null;
    let frameReady = false;
    let popupReady = false;
    let readinessTimer;
    let requestSequence = 0;
    let currentRequest = null;

    const isPopupOpen = () => Boolean(popupWindow && !popupWindow.closed);
    const createRequest = (text, autoSend) => ({
      autoSend,
      requestId: ++requestSequence,
      text: String(text),
      type: "remote-input:selection",
    });
    const postRequest = (target) => {
      if (target && currentRequest) {
        target.postMessage(currentRequest, senderOrigin);
      }
    };
    const hideOverlay = () => {
      if (host) host.hidden = true;
    };
    const showFallback = () => {
      if (!host || !frame || !fallback || frameReady || isPopupOpen()) return;
      mode = "fallback";
      host.hidden = false;
      frame.hidden = true;
      fallback.classList.add("visible");
    };
    const showIframe = () => {
      if (!host || !frame || !fallback) return;
      mode = "iframe";
      host.hidden = false;
      frame.hidden = false;
      fallback.classList.remove("visible");
    };
    const resetClosedPopup = () => {
      if (popupWindow?.closed) {
        popupWindow = null;
        popupReady = false;
      }
    };
    const openOrFocusPopup = (autoSend = false) => {
      if (!host || !fallbackText || !currentRequest) return;
      currentRequest.autoSend = autoSend;
      resetClosedPopup();
      if (isPopupOpen()) {
        mode = "popup";
        popupWindow.focus?.();
        if (popupReady) postRequest(popupWindow);
        hideOverlay();
        return;
      }

      popupReady = false;
      popupWindow = window.open(senderUrl.href, popupName);
      if (popupWindow) {
        mode = "popup";
        fallbackText.textContent = "已打开独立发送页，后续点击书签会直接复用。";
        popupWindow.focus?.();
        hideOverlay();
      } else {
        mode = "fallback";
        host.hidden = false;
        fallbackText.textContent =
          "浏览器阻止了新页面，请允许此网站打开弹窗后再次点击。";
      }
    };
    const handleMessage = (event) => {
      if (event.origin !== senderOrigin || !event.data) return;
      if (event.source === frame?.contentWindow) {
        if (event.data.type === "remote-input:ready") {
          frameReady = true;
          window.clearTimeout(readinessTimer);
          if (isPopupOpen() || mode === "popup") return;
          showIframe();
          postRequest(frame.contentWindow);
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
    const handleKeyDown = (event) => {
      if (event.key === "Escape" && mode === "iframe") hideOverlay();
    };
    const ensureHost = () => {
      if (host) return;
      host = element("div");
      host.id = hostId;
      const shadow = host.attachShadow({ mode: "open" });
      const style = element("style");
      style.textContent = `
        :host { all: initial; }
        :host([hidden]) { display: none !important; }
        .backdrop {
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          background: rgba(15, 23, 42, .32);
          backdrop-filter: blur(2px);
        }
        .panel {
          position: absolute;
          right: 20px;
          bottom: 20px;
          width: min(420px, calc(100vw - 24px));
          height: min(560px, calc(100vh - 24px));
          overflow: hidden;
          border: 1px solid rgba(148, 163, 184, .45);
          border-radius: 16px;
          background: #fff;
          box-shadow: 0 24px 80px rgba(15, 23, 42, .28);
        }
        iframe {
          width: 100%;
          height: 100%;
          border: 0;
          background: #fff;
        }
        .fallback {
          box-sizing: border-box;
          display: none;
          height: 100%;
          padding: 28px;
          color: #0f172a;
          background: #fff;
          font: 14px/1.55 system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
        }
        .fallback.visible {
          display: flex;
          flex-direction: column;
          justify-content: center;
          gap: 14px;
        }
        .fallback strong { font-size: 17px; }
        .fallback p { margin: 0; color: #475569; }
        .fallback button {
          min-height: 44px;
          border: 0;
          border-radius: 9px;
          color: #fff;
          background: #0f172a;
          cursor: pointer;
          font: 600 14px system-ui, sans-serif;
        }
        @media (max-width: 520px) {
          .panel { right: 12px; bottom: 12px; }
        }
      `;

      const backdrop = element("div", "backdrop");
      panel = element("div", "panel");
      frame = element("iframe");
      frame.title = "快速发送选中文本";
      frame.allow = "bluetooth";
      frame.referrerPolicy = "no-referrer";
      fallback = element("div", "fallback");
      const fallbackTitle = element(
        "strong",
        "",
        "当前网页无法嵌入发送页",
      );
      fallbackText = element(
        "p",
        "",
        "可以改用独立发送页；后续点击书签会复用它。",
      );
      const popupButton = element("button", "", "打开独立发送页");
      fallback.append(fallbackTitle, fallbackText, popupButton);
      panel.append(frame, fallback);
      backdrop.append(panel);
      shadow.append(style, backdrop);

      host._remoteInputUpdate = (text, autoSend = true) =>
        open(text, autoSend);
      backdrop.addEventListener("click", (event) => {
        if (mode === "iframe" && !panel.contains(event.target)) {
          hideOverlay();
        }
      });
      popupButton.addEventListener("click", () => openOrFocusPopup(false));
      frame.addEventListener("error", showFallback);
      frame.src = senderUrl.href;
      document.documentElement.appendChild(host);
      readinessTimer = window.setTimeout(showFallback, 5_000);
    };
    const open = (text = "", autoSend = true) => {
      currentRequest = createRequest(text, autoSend);
      ensureHost();
      resetClosedPopup();

      if (isPopupOpen()) {
        openOrFocusPopup(autoSend);
      } else if (mode === "fallback" || mode === "popup") {
        openOrFocusPopup(autoSend);
      } else {
        host.hidden = false;
        if (frameReady) {
          showIframe();
          postRequest(frame.contentWindow);
        }
      }
    };
    const dispose = () => {
      window.clearTimeout(readinessTimer);
      window.removeEventListener("message", handleMessage);
      window.removeEventListener("keydown", handleKeyDown, true);
      host?.remove();
      host = null;
      frame = null;
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

  const controller = createController();
  window[apiKey] = controller;
  queuedSelections.forEach((selection, index) => {
    controller.open(selection, index > 0);
  });
})();
