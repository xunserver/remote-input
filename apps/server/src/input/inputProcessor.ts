import { writeClipboardAndPaste } from "../os/clipboard.js";
import type { InputProcessor } from "./inputQueue.js";

export type InputMode = "print" | "paste";

type InputLogger = (message: string) => void;

export function createInputProcessor(mode: InputMode): InputProcessor {
  return mode === "paste" ? writeClipboardAndPaste : printReceivedText;
}

export function printReceivedText(
  text: string,
  log: InputLogger = (message) => console.log(message),
): Promise<void> {
  // JSON encoding keeps whitespace and terminal control characters visible without executing them.
  log(`Received text: ${JSON.stringify(text)}`);
  return Promise.resolve();
}
