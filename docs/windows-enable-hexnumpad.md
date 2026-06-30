# Windows EnableHexNumpad 配置

目标 Windows 必须开启 HexNumpad，ESP32-S3 才能通过 `Alt + 小键盘 + + 十六进制码点` 输入 Unicode。

## 注册表设置

1. 打开 `regedit`。
2. 进入 `HKEY_CURRENT_USER\Control Panel\Input Method`。
3. 新建或修改字符串值 `EnableHexNumpad`。
4. 设置值为 `1`。
5. 注销并重新登录，或重启电脑。

也可以在 PowerShell 中执行：

```powershell
New-ItemProperty -Path "HKCU:\Control Panel\Input Method" -Name EnableHexNumpad -Value 1 -PropertyType String -Force
```

## 验证

打开 Notepad，按住 `Alt`，按小键盘 `+`，输入 `4E2D`，松开 `Alt`。如果出现 `中`，说明配置生效。
