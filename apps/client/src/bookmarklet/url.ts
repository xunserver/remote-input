const legacyPagesOrigin = "https://xunserver.github.io";
const publicOrigin = "https://blog.xunserver.cn";
const projectPath = "/remote-input/";

export function resolveBookmarkletPageUrl(loaderUrl: URL): URL {
  // GitHub Pages redirects the legacy project URL to the custom domain, but
  // HTMLScriptElement.src keeps the originally requested URL.
  const pageUrl =
    loaderUrl.origin === legacyPagesOrigin &&
    loaderUrl.pathname.startsWith(projectPath)
      ? new URL(`${publicOrigin}${projectPath}bookmarklet/`)
      : new URL("bookmarklet/", loaderUrl);

  pageUrl.searchParams.set(
    "_",
    loaderUrl.searchParams.get("_") || String(Date.now()),
  );
  pageUrl.hash = "";
  return pageUrl;
}
