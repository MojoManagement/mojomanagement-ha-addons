Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$taskName = 'YT Cast Audio Bridge'
$repoRoot = Resolve-Path "$PSScriptRoot\.."
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$repoRoot\scripts\start.ps1`""
$trigger = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Description 'Start YT Cast Audio Bridge on startup' -Force
