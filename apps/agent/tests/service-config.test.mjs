import assert from "node:assert/strict";
import test from "node:test";
import { renderLinuxUnit, renderMacPlist, renderWindowsLauncher } from "../scripts/service-config.mjs";

test("user service configurations preserve paths with spaces and special characters", () => {
  const linux = renderLinuxUnit('/opt/Node Runtime/node', '/home/user/Remote "Copy"/main.js');
  assert.match(linux, /ExecStart="\/opt\/Node Runtime\/node" "\/home\/user\/Remote \\"Copy\\"\/main\.js"/);

  const mac = renderMacPlist("/Applications/Node & Tools/node", "/Users/a/<copy>/main.js", "/tmp/out&.log", "/tmp/err>.log");
  assert.match(mac, /Node &amp; Tools/);
  assert.match(mac, /&lt;copy&gt;/);
  assert.match(mac, /err&gt;\.log/);

  const windows = renderWindowsLauncher("C:\\Program Files\\node.exe", "C:\\Users\\O'Brien\\Remote Copy\\main.js", "C:\\Temp\\agent.pid");
  assert.match(windows, /O''Brien/);
  assert.match(windows, /ArgumentList @\("`"\$entry`""\)/);
});
