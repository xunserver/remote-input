import { writeClipboardAndPaste } from "../clipboard.js";
import type { InputProcessor } from "./input-queue.js";

export type InputMode = "paste" | "dev";

export function createInputProcessor(mode: InputMode): InputProcessor {
  return mode === "dev" ? printReceivedText : writeClipboardAndPaste;
}

export function printReceivedText(text: string): Promise<void> {
  console.log(`Received text: ${JSON.stringify(text)}`);
  return Promise.resolve();
}
