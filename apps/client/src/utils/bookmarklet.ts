export const bookmarkletQueryKey = "remote-input-bookmarklet";
export const bookmarkletSelectionHashKey = "selection";

const bookmarkletLoaderFile = "bookmarklet.js";

export type BookmarkletMessage =
  | { type: "remote-input:close" }
  | { type: "remote-input:ready" }
  | { text: string; type: "remote-input:selection" };

export function isBookmarkletMode(): boolean {
  return new URLSearchParams(window.location.search).get(bookmarkletQueryKey) ===
    "1";
}

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
  const code = `(()=>{const W=window,D=document,K="__remoteInputBookmarklet",U=${JSON.stringify(loaderUrl)},A=D.activeElement;let T="";if(A&&(A.tagName==="TEXTAREA"||A.tagName==="INPUT")&&typeof A.selectionStart==="number"&&A.selectionStart!==A.selectionEnd)T=A.value.slice(A.selectionStart,A.selectionEnd);if(!T)T=String(getSelection()||"");const Q=W[K]||(W[K]={queue:[]});if(Q.open){Q.open(T);return}(Q.queue||(Q.queue=[])).push(T);if(D.getElementById("remote-input-bookmarklet-loader"))return;const S=D.createElement("script");S.id="remote-input-bookmarklet-loader";S.async=true;S.src=U+(U.includes("?")?"&":"?")+"_="+Date.now();S.onerror=()=>{const B=new URL(".",U),L=Q.queue[Q.queue.length-1]||T;B.searchParams.set("remote-input-bookmarklet","1");B.hash="selection="+encodeURIComponent(L);W.open(B.href,"remote-input-bookmarklet-popup","popup,width=440,height=560,resizable=yes,scrollbars=yes")||alert("当前网页阻止了快速发送脚本和弹窗，请直接打开远程输入发送页。")};(D.head||D.documentElement).appendChild(S)})()`;
  return `javascript:${code}`;
}
