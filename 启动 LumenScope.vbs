' LumenScope 一键启动（无控制台窗口）
' 双击即启动本地服务并打开应用窗口；关闭窗口后自动退出。
Option Explicit
Dim sh, fso, dir, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
cmd = "cmd /c node """ & dir & "\launch.js"" >> """ & dir & "\launch.log"" 2>&1"
sh.Run cmd, 0, False
