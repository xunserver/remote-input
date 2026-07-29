import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const loaderSource = await readFile(
  new URL("../public/bookmarklet.js", import.meta.url),
  "utf8",
);

class FakeClassList {
  values = new Set();

  add(...values) {
    for (const value of values) this.values.add(value);
  }

  contains(value) {
    return this.values.has(value);
  }
}

class FakeElement {
  children = [];
  classList = new FakeClassList();
  hidden = false;
  listeners = new Map();
  parent = null;
  removed = false;

  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    if (this.tagName === "IFRAME") {
      this.contentWindow = {
        messages: [],
        postMessage: (message, origin) => {
          this.contentWindow.messages.push({ message, origin });
        },
      };
    }
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  append(...children) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }

  appendChild(child) {
    this.append(child);
    return child;
  }

  attachShadow() {
    this.shadowRoot = new FakeElement("shadow-root", this.ownerDocument);
    return this.shadowRoot;
  }

  contains(target) {
    return target === this ||
      this.children.some((child) => child.contains(target));
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  remove() {
    this.removed = true;
    if (this.parent) {
      this.parent.children = this.parent.children.filter(
        (child) => child !== this,
      );
    }
  }
}

function descendants(root) {
  return [
    ...root.children,
    ...root.children.flatMap((child) => descendants(child)),
  ];
}

function createFixture(options = {}) {
  const windowListeners = new Map();
  const timers = new Map();
  let nextTimerId = 1;
  const document = {
    currentScript: {
      src: "https://xunserver.github.io/remote-input/bookmarklet.js?_=1",
    },
    createElement(tagName) {
      return new FakeElement(tagName, document);
    },
    getElementById(id) {
      return descendants(document.documentElement).find(
        (element) => element.id === id,
      ) ?? null;
    },
  };
  document.documentElement = new FakeElement("html", document);
  const window = {
    __remoteInputBookmarklet: { queue: ["首次选文"] },
    addEventListener(type, listener) {
      const listeners = windowListeners.get(type) ?? [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    location: { href: "https://example.com/article" },
    open() {
      return options.popupWindow ?? null;
    },
    removeEventListener(type, listener) {
      const listeners = windowListeners.get(type) ?? [];
      windowListeners.set(
        type,
        listeners.filter((candidate) => candidate !== listener),
      );
    },
    setTimeout(callback) {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
  };
  window.window = window;

  const context = vm.createContext({
    Array,
    String,
    URL,
    document,
    window,
  });
  new vm.Script(loaderSource, { filename: "bookmarklet.js" }).runInContext(
    context,
  );

  return {
    document,
    dispatchWindow(type, event) {
      for (const listener of windowListeners.get(type) ?? []) listener(event);
    },
    runLatestTimer() {
      const entry = [...timers.entries()].at(-1);
      assert.ok(entry, "expected a pending readiness timer");
      timers.delete(entry[0]);
      entry[1]();
    },
    window,
  };
}

function findByTag(root, tagName) {
  return descendants(root).find((element) => element.tagName === tagName);
}

function findByClass(root, className) {
  return descendants(root).find(
    (element) =>
      element.className === className ||
      element.classList.contains(className),
  );
}

test("loader consumes queued text, sends it after ready, and reuses its API", () => {
  const fixture = createFixture();
  const api = fixture.window.__remoteInputBookmarklet;
  assert.equal(api.version, 2);

  const host = fixture.document.getElementById(
    "remote-input-bookmarklet-host",
  );
  assert.ok(host);
  const frame = findByTag(host.shadowRoot, "IFRAME");
  assert.ok(frame);
  assert.equal(
    frame.src,
    "https://blog.xunserver.cn/remote-input/?remote-input-bookmarklet=1&_=1",
  );
  assert.equal(frame.allow, "bluetooth");

  fixture.dispatchWindow("message", {
    data: { type: "remote-input:ready" },
    origin: "https://blog.xunserver.cn",
    source: frame.contentWindow,
  });
  assert.equal(frame.contentWindow.messages.length, 1);
  assert.equal(
    frame.contentWindow.messages[0].message.type,
    "remote-input:selection",
  );
  assert.equal(frame.contentWindow.messages[0].message.text, "首次选文");
  assert.equal(
    frame.contentWindow.messages[0].origin,
    "https://blog.xunserver.cn",
  );

  api.open("第二次选文");
  assert.equal(
    fixture.document.getElementById("remote-input-bookmarklet-host"),
    host,
  );
  assert.equal(frame.contentWindow.messages.at(-1).message.text, "第二次选文");
});

test("loader shows the popup fallback when the iframe never becomes ready", () => {
  const fixture = createFixture();
  const host = fixture.document.getElementById(
    "remote-input-bookmarklet-host",
  );
  const frame = findByTag(host.shadowRoot, "IFRAME");
  const fallback = findByClass(host.shadowRoot, "fallback");

  fixture.runLatestTimer();

  assert.equal(frame.hidden, true);
  assert.equal(fallback.classList.contains("visible"), true);
});

test("loader removes its host when the embedded sender requests close", () => {
  const fixture = createFixture();
  const host = fixture.document.getElementById(
    "remote-input-bookmarklet-host",
  );
  const frame = findByTag(host.shadowRoot, "IFRAME");

  fixture.dispatchWindow("message", {
    data: { type: "remote-input:close" },
    origin: "https://blog.xunserver.cn",
    source: frame.contentWindow,
  });

  assert.equal(
    fixture.document.getElementById("remote-input-bookmarklet-host"),
    null,
  );
});

test("popup fallback transfers text after the popup sender becomes ready", () => {
  const popupWindow = {
    messages: [],
    postMessage(message, origin) {
      this.messages.push({ message, origin });
    },
  };
  const fixture = createFixture({ popupWindow });
  const host = fixture.document.getElementById(
    "remote-input-bookmarklet-host",
  );
  const popupButton = findByTag(host.shadowRoot, "BUTTON");

  fixture.runLatestTimer();
  popupButton.dispatch("click");
  fixture.dispatchWindow("message", {
    data: { type: "remote-input:ready" },
    origin: "https://blog.xunserver.cn",
    source: popupWindow,
  });

  assert.equal(popupWindow.messages.length, 1);
  assert.equal(popupWindow.messages[0].message.text, "首次选文");
  assert.equal(
    popupWindow.messages[0].origin,
    "https://blog.xunserver.cn",
  );
  assert.equal(
    fixture.document.getElementById("remote-input-bookmarklet-host"),
    null,
  );
});
