import { createController } from "./controller";
import type {
  BookmarkletBootstrapApi,
  BookmarkletWindow,
} from "./types";
import { resolveBookmarkletPageUrl } from "./url";

const apiKey = "__remoteInputBookmarklet";
const bookmarkletWindow = window as BookmarkletWindow;
const script = document.currentScript as HTMLScriptElement | null;
const loaderUrl = new URL(script?.src || window.location.href);
const bookmarkletPageUrl = resolveBookmarkletPageUrl(loaderUrl);
const previousApi = bookmarkletWindow[apiKey];

function selectionsFrom(api: BookmarkletBootstrapApi | undefined): string[] {
  return api && Array.isArray(api.queue) ? api.queue.slice() : [];
}

const queuedSelections =
  previousApi && "queue" in previousApi ? selectionsFrom(previousApi) : [];
const controller = createController(bookmarkletPageUrl);

bookmarkletWindow[apiKey] = controller;
queuedSelections.forEach((selection, index) => {
  controller.open(selection, index > 0);
});
