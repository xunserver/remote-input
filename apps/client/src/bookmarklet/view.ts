import { bookmarkletStyles } from "./styles";
import type { BookmarkletHost } from "./types";

export type BookmarkletView = {
  backdrop: HTMLDivElement;
  fallback: HTMLDivElement;
  fallbackText: HTMLParagraphElement;
  frame: HTMLIFrameElement;
  host: BookmarkletHost;
  panel: HTMLDivElement;
  popupButton: HTMLButtonElement;
};

function element<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const target = document.createElement(tagName);
  if (className) target.className = className;
  if (text) target.textContent = text;
  return target;
}

export function createBookmarkletView(
  hostId: string,
  pageUrl: URL,
): BookmarkletView {
  const host = element("div") as BookmarkletHost;
  host.id = hostId;

  const shadow = host.attachShadow({ mode: "open" });
  const style = element("style");
  style.textContent = bookmarkletStyles;

  const backdrop = element("div", "backdrop");
  const panel = element("div", "panel");
  const frame = element("iframe");
  frame.title = "快速发送选中文本";
  frame.allow = "bluetooth";
  frame.referrerPolicy = "no-referrer";
  frame.src = pageUrl.href;

  const fallback = element("div", "fallback");
  const fallbackTitle = element(
    "strong",
    "",
    "当前网页无法嵌入发送页",
  );
  const fallbackText = element(
    "p",
    "",
    "可以改用独立发送页；后续点击书签会复用它。",
  );
  const popupButton = element("button", "", "打开独立发送页");

  fallback.append(fallbackTitle, fallbackText, popupButton);
  panel.append(frame, fallback);
  backdrop.append(panel);
  shadow.append(style, backdrop);
  document.documentElement.appendChild(host);

  return {
    backdrop,
    fallback,
    fallbackText,
    frame,
    host,
    panel,
    popupButton,
  };
}
