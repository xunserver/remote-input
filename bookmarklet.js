(function(){function e(e,t=``,n=``){let r=document.createElement(e);return t&&(r.className=t),n&&(r.textContent=n),r}function t(t,n){let r=e(`div`);r.id=t;let i=r.attachShadow({mode:`open`}),a=e(`style`);a.textContent=`
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
`;let o=e(`div`,`backdrop`),s=e(`div`,`panel`),c=e(`iframe`);c.title=`快速发送选中文本`,c.allow=`bluetooth`,c.referrerPolicy=`no-referrer`,c.src=n.href;let l=e(`div`,`fallback`),u=e(`strong`,``,`当前网页无法嵌入发送页`),d=e(`p`,``,`可以改用独立发送页；后续点击书签会复用它。`),f=e(`button`,``,`打开独立发送页`);return l.append(u,d,f),s.append(c,l),o.append(s),i.append(a,o),document.documentElement.appendChild(r),{backdrop:o,fallback:l,fallbackText:d,frame:c,host:r,panel:s,popupButton:f}}function n(e){return!e||typeof e!=`object`||!(`type`in e)?!1:e.type===`remote-input:ready`||e.type===`remote-input:close`||e.type===`remote-input:selection`}function r(e){let r=e.origin,i=`loading`,a=null,o=null,s=!1,c=!1,l,u=0,d=null,f=()=>!!(o&&!o.closed),p=(e,t)=>({autoSend:t,requestId:++u,text:String(e),type:`remote-input:selection`}),m=e=>{e&&d&&e.postMessage(d,r)},h=()=>{a&&(a.host.hidden=!0)},g=()=>{!a||s||f()||(i=`fallback`,a.host.hidden=!1,a.frame.hidden=!0,a.fallback.classList.add(`visible`))},_=()=>{a&&(i=`iframe`,a.host.hidden=!1,a.frame.hidden=!1,a.fallback.classList.remove(`visible`))},v=()=>{o?.closed&&(o=null,c=!1)},y=(t=!1)=>{if(!(!a||!d)){if(d.autoSend=t,v(),f()){i=`popup`,o?.focus(),c&&m(o),h();return}c=!1,o=window.open(e.href,`remote-input-bookmarklet-popup`),o?(i=`popup`,a.fallbackText.textContent=`已打开独立发送页，后续点击书签会直接复用。`,o.focus(),h()):(i=`fallback`,a.host.hidden=!1,a.fallbackText.textContent=`浏览器阻止了新页面，请允许此网站打开弹窗后再次点击。`)}},b=e=>{if(!(e.origin!==r||!n(e.data))){if(e.source===a?.frame.contentWindow){if(e.data.type===`remote-input:ready`){if(s=!0,window.clearTimeout(l),f()||i===`popup`)return;_(),m(a.frame.contentWindow)}else e.data.type===`remote-input:close`&&h();return}o&&e.source===o&&(e.data.type===`remote-input:ready`?(c=!0,i=`popup`,m(o),h()):e.data.type===`remote-input:close`&&(c=!1,o=null,i=`fallback`))}},x=e=>{e.key===`Escape`&&i===`iframe`&&h()},S=()=>{a||(a=t(`remote-input-bookmarklet-host`,e),a.host._remoteInputUpdate=(e,t=!0)=>C(e,t),a.backdrop.addEventListener(`click`,e=>{i===`iframe`&&e.target&&!a?.panel.contains(e.target)&&h()}),a.popupButton.addEventListener(`click`,()=>y(!1)),a.frame.addEventListener(`error`,g),l=window.setTimeout(g,5e3))},C=(e=``,t=!0)=>{d=p(e,t),S(),v(),f()||i===`fallback`||i===`popup`?y(t):(a&&(a.host.hidden=!1),s&&a&&(_(),m(a.frame.contentWindow)))};return window.addEventListener(`message`,b),window.addEventListener(`keydown`,x,!0),{dispose:()=>{window.clearTimeout(l),window.removeEventListener(`message`,b),window.removeEventListener(`keydown`,x,!0),a?.host.remove(),a=null,o=null},get mode(){return v(),i},open:C,openPopup:y,version:3}}var i=`/remote-input/`;function a(e){let t=e.origin===`https://xunserver.github.io`&&e.pathname.startsWith(i)?new URL(`https://blog.xunserver.cn${i}bookmarklet/`):new URL(`bookmarklet/`,e);return t.searchParams.set(`_`,e.searchParams.get(`_`)||String(Date.now())),t.hash=``,t}var o=`__remoteInputBookmarklet`,s=window,c=document.currentScript,l=a(new URL(c?.src||window.location.href)),u=s[o];function d(e){return e&&Array.isArray(e.queue)?e.queue.slice():[]}var f=u&&`queue`in u?d(u):[],p=r(l);s[o]=p,f.forEach((e,t)=>{p.open(e,t>0)})})();