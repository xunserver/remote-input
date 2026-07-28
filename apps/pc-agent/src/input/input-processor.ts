import { applyClipboardInput } from "../clipboard.js";
import type { InputProcessor } from "./input-queue.js";

export type InputMode = "paste" | "dev";

export function createInputProcessor(mode: InputMode): InputProcessor {
  return mode === "dev" ? printReceivedText : applyClipboardInput;
}

export function printReceivedText(
  command: Parameters<InputProcessor>[0],
): Promise<void> {
  console.log(
    `Received input: ${JSON.stringify({
      text: command.text,
      control: command.control,
    })}`,
  );
  return Promise.resolve();
}
