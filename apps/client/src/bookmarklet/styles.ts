export const bookmarkletStyles = `
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
