Option Explicit
Dim fso, shell, here, scriptPath, command
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
scriptPath = fso.BuildPath(here, "options-flow-tray.ps1")
command = "powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File """ & scriptPath & """"
shell.Run command, 0, False
