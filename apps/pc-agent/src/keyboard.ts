import { spawn } from "node:child_process";
import type { InputStatusStage, KeyCommand, KeyboardKey } from "@remote-input/sdk";

const windowsKeys: Record<KeyboardKey, string> = {
  Enter: "{ENTER}",
  Backspace: "{BACKSPACE}",
  Tab: "{TAB}",
  Escape: "{ESC}",
  Delete: "{DELETE}",
  ArrowUp: "{UP}",
  ArrowDown: "{DOWN}",
  ArrowLeft: "{LEFT}",
  ArrowRight: "{RIGHT}",
  Home: "{HOME}",
  End: "{END}",
  PageUp: "{PGUP}",
  PageDown: "{PGDN}",
  Space: " ",
};

const macKeyCodes: Record<KeyboardKey, number> = {
  Enter: 36,
  Backspace: 51,
  Tab: 48,
  Escape: 53,
  Delete: 117,
  ArrowUp: 126,
  ArrowDown: 125,
  ArrowLeft: 123,
  ArrowRight: 124,
  Home: 115,
  End: 119,
  PageUp: 116,
  PageDown: 121,
  Space: 49,
};

const linuxKeys: Record<KeyboardKey, { xdotool: string; wtype: string }> = {
  Enter: { xdotool: "Return", wtype: "Return" },
  Backspace: { xdotool: "BackSpace", wtype: "BackSpace" },
  Tab: { xdotool: "Tab", wtype: "Tab" },
  Escape: { xdotool: "Escape", wtype: "Escape" },
  Delete: { xdotool: "Delete", wtype: "Delete" },
  ArrowUp: { xdotool: "Up", wtype: "Up" },
  ArrowDown: { xdotool: "Down", wtype: "Down" },
  ArrowLeft: { xdotool: "Left", wtype: "Left" },
  ArrowRight: { xdotool: "Right", wtype: "Right" },
  Home: { xdotool: "Home", wtype: "Home" },
  End: { xdotool: "End", wtype: "End" },
  PageUp: { xdotool: "Page_Up", wtype: "Page_Up" },
  PageDown: { xdotool: "Page_Down", wtype: "Page_Down" },
  Space: { xdotool: "space", wtype: "space" },
};

export async function pressKeyboardKey(
  command: KeyCommand,
  onStage: (stage: InputStatusStage, message: string) => void,
): Promise<void> {
  const key = command.key;
  if (process.platform === "win32") {
    await runCommand("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `$shell = New-Object -ComObject WScript.Shell; $shell.SendKeys('${windowsKeys[key]}')`,
    ]);
  } else if (process.platform === "darwin") {
    await runCommand("osascript", [
      "-e",
      `tell application "System Events" to key code ${macKeyCodes[key]}`,
    ]);
  } else {
    const names = linuxKeys[key];
    await runCommand("sh", [
      "-lc",
      `command -v xdotool >/dev/null && xdotool key ${names.xdotool} || command -v wtype >/dev/null && wtype -k ${names.wtype} || exit 127`,
    ]);
  }
  onStage("key_pressed", `接收端已按下 ${key}。`);
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`按键命令执行失败，退出码 ${code}。`));
    });
  });
}
