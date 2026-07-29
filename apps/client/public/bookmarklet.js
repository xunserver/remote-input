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

  function element(tagName, className, text) {
    const target = document.createElement(tagName);
    if (className) target.className = className;
    if (text) target.textContent = text;
    return target;
  }

  function open(text = "") {
    const existing = document.getElementById(hostId);
    if (existing?._remoteInputUpdate) {
      existing._remoteInputUpdate(text);
      return;
    }

    const host = element("div");
    host.id = hostId;
    const shadow = host.attachShadow({ mode: "open" });
    const style = element("style");
    style.textContent = `
      :host { all: initial; }
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
    const panel = element("div", "panel");
    const frame = element("iframe");
    frame.title = "快速发送选中文本";
    frame.allow = "bluetooth";
    frame.referrerPolicy = "no-referrer";
    const fallback = element("div", "fallback");
    const fallbackTitle = element("strong", "", "悬浮窗被当前网页阻止");
    const fallbackText = element(
      "p",
      "",
      "可以降级到独立小窗继续发送，选中的文字不会提交到当前网站。",
    );
    const popupButton = element("button", "", "在独立小窗中打开");
    fallback.append(fallbackTitle, fallbackText, popupButton);
    panel.append(frame, fallback);
    backdrop.append(panel);
    shadow.append(style, backdrop);

    let selection = String(text);
    let popupWindow = null;
    let ready = false;
    let readinessTimer;

    const postSelection = () => {
      if (!frame.contentWindow) return;
      frame.contentWindow.postMessage(
        { type: "remote-input:selection", text: selection },
        senderOrigin,
      );
    };
    const showFallback = () => {
      if (ready) return;
      frame.hidden = true;
      fallback.classList.add("visible");
    };
    const cleanup = () => {
      window.clearTimeout(readinessTimer);
      window.removeEventListener("message", handleMessage);
      window.removeEventListener("keydown", handleKeyDown, true);
      host.remove();
    };
    const handleMessage = (event) => {
      if (event.origin !== senderOrigin) {
        return;
      }
      if (
        event.source === frame.contentWindow &&
        event.data?.type === "remote-input:ready"
      ) {
        ready = true;
        window.clearTimeout(readinessTimer);
        postSelection();
      }
      if (
        event.source === frame.contentWindow &&
        event.data?.type === "remote-input:close"
      ) {
        cleanup();
      }
      if (
        popupWindow &&
        event.source === popupWindow &&
        event.data?.type === "remote-input:ready"
      ) {
        popupWindow.postMessage(
          { type: "remote-input:selection", text: selection },
          senderOrigin,
        );
        cleanup();
      }
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") cleanup();
    };

    host._remoteInputUpdate = (nextText) => {
      selection = String(nextText);
      host.hidden = false;
      if (ready) postSelection();
    };
    backdrop.addEventListener("click", (event) => {
      if (!panel.contains(event.target)) cleanup();
    });
    popupButton.addEventListener("click", () => {
      popupWindow = window.open(
        senderUrl.href,
        "remote-input-bookmarklet-popup",
        "popup,width=440,height=560,resizable=yes,scrollbars=yes",
      );
      if (popupWindow) {
        fallbackText.textContent = "正在独立小窗中打开快速发送…";
      } else {
        fallbackText.textContent =
          "浏览器阻止了弹窗，请允许此网站打开弹窗后重试。";
      }
    });
    window.addEventListener("message", handleMessage);
    window.addEventListener("keydown", handleKeyDown, true);
    frame.addEventListener("load", () => {
      if (!ready) postSelection();
    });
    frame.addEventListener("error", showFallback);
    frame.src = senderUrl.href;
    document.documentElement.appendChild(host);
    readinessTimer = window.setTimeout(showFallback, 5_000);
  }

  window[apiKey] = { open, version: 2 };
  for (const selection of queuedSelections) open(selection);
})();
