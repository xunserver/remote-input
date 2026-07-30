import assert from "node:assert/strict";
import test from "node:test";
import { resolveBookmarkletPageUrl } from "../src/bookmarklet/url.ts";

test("bookmarklet URL normalizes the legacy GitHub Pages origin", () => {
  const pageUrl = resolveBookmarkletPageUrl(
    new URL(
      "https://xunserver.github.io/remote-input/bookmarklet.js?_=123#ignored",
    ),
  );

  assert.equal(
    pageUrl.href,
    "https://blog.xunserver.cn/remote-input/bookmarklet/?_=123",
  );
});

test("bookmarklet URL stays relative to a self-hosted loader", () => {
  const pageUrl = resolveBookmarkletPageUrl(
    new URL("https://example.com/tools/bookmarklet.js?_=456"),
  );

  assert.equal(
    pageUrl.href,
    "https://example.com/tools/bookmarklet/?_=456",
  );
});
