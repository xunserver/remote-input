import { applyClipboardInput } from "../clipboard.js";
import { pressKeyboardKey } from "../keyboard.js";
import type { InputProcessor } from "./input-queue.js";

export type InputMode = "paste" | "dev";

export function createInputProcessor(mode: InputMode): InputProcessor {
  if (mode === "dev") return printReceivedText;
  return (command, onStage) =>
    "key" in command
      ? pressKeyboardKey(command, onStage)
      : applyClipboardInput(command, onStage);
}

export function printReceivedText(
  command: Parameters<InputProcessor>[0],
): Promise<void> {
  console.log(
    `Received input: ${JSON.stringify({
      ...("key" in command
        ? { key: command.key }
        : { text: command.text, control: command.control }),
    })}`,
  );
  return Promise.resolve();
}
