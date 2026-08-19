' Agents Chat 静默启动器：无窗口后台运行 server（由 start.bat 调用）
' 用法: wscript start-hidden.vbs [port]
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
port = "3456"
If WScript.Arguments.Count > 0 Then port = WScript.Arguments(0)
node = root & "\bin\node.exe"
If Not fso.FileExists(node) Then node = "node"
cmd = "cmd /c cd /d """ & root & """ && """ & node & """ app\server.js --port " & port
shell.Run cmd, 0, False
