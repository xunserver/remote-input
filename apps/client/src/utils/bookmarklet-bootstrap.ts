const apiKey = "__remoteInputBookmarklet";
const loaderId = "remote-input-bookmarklet-loader";
const popupName = "remote-input-bookmarklet-popup";

/**
 * 生成书签中内嵌的最小启动器。远端 loader 不可用时，这段代码自身也必须能重复打开
 * 独立发送页，因此失败状态不能只依赖一个残留的 script DOM 节点。
 */
export function createBookmarkletCode(loaderUrl: string): string {
  return `(()=>{const W=window,D=document,K=${JSON.stringify(apiKey)},I=${JSON.stringify(loaderId)},N=${JSON.stringify(popupName)},U=${JSON.stringify(loaderUrl)},A=D.activeElement;let T="";if(A&&(A.tagName==="TEXTAREA"||A.tagName==="INPUT")&&typeof A.selectionStart==="number"&&A.selectionStart!==A.selectionEnd)T=A.value.slice(A.selectionStart,A.selectionEnd);if(!T)T=String(getSelection()||"");const Q=W[K]||(W[K]={queue:[]}),B=new URL(".",U),O=B.origin;B.searchParams.set("remote-input-bookmarklet","1");const J=()=>{if(Q.messageListener)return;Q.messageListener=true;W.addEventListener("message",E=>{const P=Q.popup;if(!P||E.source!==P||E.origin!==O)return;if(E.data?.type==="remote-input:ready"){Q.popupReady=true;if(Q.pending){P.postMessage(Q.pending,O);Q.pending=null}}else if(E.data?.type==="remote-input:close"){Q.popup=null;Q.popupReady=false;Q.pending=null}})},F=(X,autoSend=false)=>{J();const M={type:"remote-input:selection",text:String(X),autoSend,requestId:(Q.requestId||0)+1};Q.requestId=M.requestId;if(Q.popup&&!Q.popup.closed){Q.popup.focus?.();if(Q.popupReady)Q.popup.postMessage(M,O);else Q.pending=M;return}Q.popupReady=false;Q.pending=autoSend?M:null;B.hash="selection="+encodeURIComponent(M.text);Q.popup=W.open(B.href,N);if(Q.popup)Q.popup.focus?.();else{Q.pending=null;alert("浏览器阻止了独立发送页，请允许此网站打开弹窗后再次点击书签。")}};if(Q.open){Q.open(T);return}if(Q.fallback){Q.fallback(T,true);return}(Q.queue||(Q.queue=[])).push(T);if(Q.loading)return;Q.loading=true;D.getElementById(I)?.remove();const S=D.createElement("script");S.id=I;S.async=true;S.src=U+(U.includes("?")?"&":"?")+"_="+Date.now();const H=()=>{Q.loading=false;S.remove();const C=W[K];if(C?.open)return;Q.fallback=F;F(Q.queue[Q.queue.length-1]||T,false)};S.onerror=H;S.onload=()=>{Q.loading=false;S.remove();if(!W[K]?.open)H()};(D.head||D.documentElement).appendChild(S)})()`;
}
