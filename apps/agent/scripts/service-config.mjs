export function renderLinuxUnit(node, entry) {
  return `[Unit]\nDescription=Remote Copy HID agent\nAfter=graphical-session.target\n\n[Service]\nType=simple\nExecStart=${systemdQuote(node)} ${systemdQuote(entry)}\nRestart=on-failure\nRestartSec=1\nEnvironment=INPUT_MODE=paste\n\n[Install]\nWantedBy=default.target\n`;
}

export function renderMacPlist(node, entry, stdoutPath, stderrPath) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>com.remote-copy.agent</string>\n<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(entry)}</string></array>\n<key>EnvironmentVariables</key><dict><key>INPUT_MODE</key><string>paste</string></dict>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>StandardOutPath</key><string>${xml(stdoutPath)}</string>\n<key>StandardErrorPath</key><string>${xml(stderrPath)}</string>\n</dict></plist>\n`;
}

export function renderWindowsLauncher(node, entry, pidFile) {
  return `$env:INPUT_MODE='paste'\n$entry = '${powershellQuote(entry)}'\n$p = Start-Process -FilePath '${powershellQuote(node)}' -ArgumentList @("\`"$entry\`"") -WindowStyle Hidden -PassThru\n$p.Id | Set-Content -Path '${powershellQuote(pidFile)}'\nWait-Process -Id $p.Id\n`;
}

function systemdQuote(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function xml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function powershellQuote(value) {
  return value.replaceAll("'", "''");
}
