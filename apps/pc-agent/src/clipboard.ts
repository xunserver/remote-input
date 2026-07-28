import { spawn } from "node:child_process";
import type { InputProcessor } from "./input/input-queue.js";

const clipboardRestoreDelayMs = 200;

export const applyClipboardInput: InputProcessor = async (
  command,
  onStage,
) => {
  const clipboardy = await import("clipboardy");
  return createClipboardInputProcessor(clipboardy.default)(
    command,
    onStage,
  );
};

export type ClipboardIO = {
  read(): Promise<string>;
  write(text: string): Promise<void>;
};

export function createClipboardInputProcessor(
  clipboard: ClipboardIO,
  paste: () => Promise<void> = pasteFromClipboard,
  wait: (milliseconds: number) => Promise<void> = delay,
): InputProcessor {
  return async (command, onStage) => {
  const previous = command.control.restoreClipboard
    ? await clipboard.read()
    : undefined;
  let inputError: unknown;
  try {
    await clipboard.write(command.text);
    onStage("copied", "文字已复制到接收端剪贴板。");
    if (command.control.paste) {
      await paste();
      onStage("pasted", "接收端已触发系统粘贴。");
    }
  } catch (error) {
    inputError = error;
  } finally {
    if (previous !== undefined) {
      if (command.control.paste) {
        await wait(clipboardRestoreDelayMs);
      }
      try {
        await clipboard.write(previous);
        onStage("clipboard_restored", "接收端原剪贴板已恢复。");
      } catch (restoreError) {
        throw inputError === undefined
          ? restoreError
          : new AggregateError(
              [inputError, restoreError],
              "输入失败，且原剪贴板未能恢复。",
            );
      }
    }
  }
  if (inputError !== undefined) throw inputError;
  };
}

function pasteFromClipboard(): Promise<void> {
  if (process.platform === "win32") {
    return runCommand("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "$shell = New-Object -ComObject WScript.Shell; Start-Sleep -Milliseconds 80; $shell.SendKeys('^v')",
    ]);
  }
  if (process.platform === "darwin") {
    return runCommand("osascript", [
      "-e",
      'tell application "System Events" to keystroke "v" using command down',
    ]);
  }
  return runCommand("sh", [
    "-lc",
    "command -v xdotool >/dev/null && xdotool key ctrl+v || command -v wtype >/dev/null && wtype -M ctrl v -m ctrl || exit 127",
  ]);
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`粘贴命令执行失败，退出码 ${code}。`));
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
