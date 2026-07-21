import { spawn } from "node:child_process";

// 仅在剪贴板写入和粘贴命令都完成后 resolve，使上层响应覆盖完整输入操作。
export async function writeClipboardAndPaste(text: string, onPasting?: () => void): Promise<void> {
  const clipboardy = await import("clipboardy");
  await clipboardy.default.write(text);
  onPasting?.();
  await pasteFromClipboard();
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
    return runCommand("osascript", ["-e", 'tell application "System Events" to keystroke "v" using command down']);
  }

  return runCommand("sh", [
    "-lc",
    "command -v xdotool >/dev/null && xdotool key ctrl+v || command -v wtype >/dev/null && wtype -M ctrl v -m ctrl || exit 127",
  ]);
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: "ignore",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`粘贴命令执行失败，退出码 ${code}。`));
      }
    });
  });
}
