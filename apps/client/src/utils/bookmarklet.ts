import { createBookmarkletCode } from "@/utils/bookmarklet-bootstrap";

export const bookmarkletSelectionHashKey = "selection";

const bookmarkletLoaderFile = "bookmarklet.js";

export type BookmarkletMessage =
  | { type: "remote-input:close" }
  | { type: "remote-input:ready" }
  | {
    autoSend?: boolean;
    requestId?: number;
    text: string;
    type: "remote-input:selection";
  };

export function getBookmarkletLoaderUrl(): string {
  return new URL(
    bookmarkletLoaderFile,
    new URL(import.meta.env.BASE_URL, window.location.origin),
  ).href;
}

export function getFullSenderUrl(): string {
  return new URL(import.meta.env.BASE_URL, window.location.origin).href;
}

export function readBookmarkletSelectionFromHash(): string {
  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  const selection = new URLSearchParams(hash).get(
    bookmarkletSelectionHashKey,
  ) ?? "";

  if (selection) {
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + window.location.search,
    );
  }
  return selection;
}

/**
 * 书签中只保存启动器：读取选区、排队并下载远端 loader。
 * loader 每次使用都做缓存穿透，以便已安装的书签自动获得兼容修复；
 * loader 随后创建 iframe，完整 Vue 应用仍使用 Vite 哈希资源长期缓存。
 */
export function createBookmarkletHref(loaderUrl: string): string {
  return `javascript:${createBookmarkletCode(loaderUrl)}`;
}
