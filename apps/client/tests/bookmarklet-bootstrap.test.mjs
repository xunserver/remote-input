import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { createBookmarkletCode } from "../src/utils/bookmarklet-bootstrap.ts";

function createPopup() {
  return {
    closed: false,
    focusCount: 0,
    messages: [],
    focus() {
      this.focusCount += 1;
    },
    postMessage(message, origin) {
      this.messages.push({ message, origin });
    },
  };
}

function createFixture(options = {}) {
  const alerts = [];
  const elements = new Map();
  const listeners = new Map();
  const openCalls = [];
  let selection = options.selection ?? "首次选文";
  let openIndex = 0;
  const popups = options.popups ?? [createPopup()];
  const document = {
    activeElement: null,
    createElement(tagName) {
      return {
        async: false,
        id: "",
        remove() {
          if (elements.get(this.id) === this) elements.delete(this.id);
        },
        src: "",
        tagName: tagName.toUpperCase(),
      };
    },
    getElementById(id) {
      return elements.get(id) ?? null;
    },
  };
  document.head = {
    appendChild(script) {
      elements.set(script.id, script);
      if (options.loaderSucceeds) {
        window.__remoteInputBookmarklet = {
          open(text) {
            this.openedText = text;
          },
          version: 3,
        };
        script.onload();
      } else {
        script.onerror();
      }
      return script;
    },
  };
  document.documentElement = document.head;
  const window = {
    addEventListener(type, listener) {
      const entries = listeners.get(type) ?? [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    open(...args) {
      openCalls.push(args);
      const popup = popups[openIndex] ?? null;
      openIndex += 1;
      return popup;
    },
  };
  window.window = window;
  const context = vm.createContext({
    Date,
    String,
    URL,
    alert(message) {
      alerts.push(message);
    },
    document,
    encodeURIComponent,
    getSelection() {
      return selection;
    },
    window,
  });
  const code = createBookmarkletCode(
    "https://blog.xunserver.cn/remote-input/bookmarklet.js",
  );

  return {
    alerts,
    code,
    dispatchMessage(event) {
      for (const listener of listeners.get("message") ?? []) listener(event);
    },
    document,
    execute() {
      new vm.Script(code, { filename: "bookmarklet-bootstrap.js" })
        .runInContext(context);
    },
    openCalls,
    popups,
    setSelection(value) {
      selection = value;
    },
    window,
  };
}

test("failed loader is removed and a closed fallback page can reopen", () => {
  const firstPopup = createPopup();
  const secondPopup = createPopup();
  const fixture = createFixture({ popups: [firstPopup, secondPopup] });

  fixture.execute();

  assert.equal(
    fixture.document.getElementById("remote-input-bookmarklet-loader"),
    null,
  );
  assert.equal(typeof fixture.window.__remoteInputBookmarklet.fallback, "function");
  assert.equal(fixture.openCalls.length, 1);

  firstPopup.closed = true;
  fixture.setSelection("第二次选文");
  fixture.execute();

  assert.equal(fixture.openCalls.length, 2);
  assert.match(fixture.openCalls[1][0], /selection=%E7%AC%AC%E4%BA%8C/);
  assert.equal(fixture.openCalls[1][1], "remote-input-bookmarklet-popup");
  assert.equal(fixture.openCalls[1].length, 2);

  fixture.dispatchMessage({
    data: { type: "remote-input:ready" },
    origin: "https://blog.xunserver.cn",
    source: secondPopup,
  });
  assert.equal(secondPopup.messages.length, 1);
  assert.equal(secondPopup.messages[0].message.text, "第二次选文");
  assert.equal(secondPopup.messages[0].message.autoSend, true);
});

test("an open direct fallback page is focused and receives the next selection", () => {
  const popup = createPopup();
  const fixture = createFixture({ popups: [popup] });

  fixture.execute();
  fixture.dispatchMessage({
    data: { type: "remote-input:ready" },
    origin: "https://blog.xunserver.cn",
    source: popup,
  });
  fixture.setSelection("直接复用");
  fixture.execute();

  assert.equal(fixture.openCalls.length, 1);
  assert.equal(popup.focusCount, 2);
  assert.equal(popup.messages.length, 1);
  assert.equal(popup.messages[0].message.text, "直接复用");
  assert.equal(popup.messages[0].message.autoSend, true);
});

test("a blocked asynchronous popup remains recoverable on the next click", () => {
  const popup = createPopup();
  const fixture = createFixture({ popups: [null, popup] });

  fixture.execute();
  assert.equal(fixture.alerts.length, 1);

  fixture.setSelection("用户手势重开");
  fixture.execute();

  assert.equal(fixture.openCalls.length, 2);
  assert.equal(fixture.window.__remoteInputBookmarklet.popup, popup);
});

test("a successful loader replaces the bootstrap without opening fallback", () => {
  const fixture = createFixture({ loaderSucceeds: true });

  fixture.execute();

  assert.equal(fixture.window.__remoteInputBookmarklet.version, 3);
  assert.equal(fixture.openCalls.length, 0);
  assert.equal(
    fixture.document.getElementById("remote-input-bookmarklet-loader"),
    null,
  );
});
