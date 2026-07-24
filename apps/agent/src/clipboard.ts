import { spawn } from "node:child_process";

export async function writeClipboardAndPaste(text: string): Promise<void> {
  const clipboardy = await import("clipboardy");
  await clipboardy.default.write(text);
  await new Promise((resolve) => setTimeout(resolve, 80));
  if (process.platform === "win32") return run("powershell.exe", ["-NoProfile", "-Command", "$s=New-Object -ComObject WScript.Shell;$s.SendKeys('^v')"]);
  if (process.platform === "darwin") return run("osascript", ["-e", 'tell application "System Events" to keystroke "v" using command down']);
  return run("sh", ["-lc", "command -v xdotool >/dev/null && xdotool key ctrl+v || command -v wtype >/dev/null && wtype -M ctrl v -m ctrl || exit 127"]);
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Paste command exited with code ${code}.`)));
  });
}
