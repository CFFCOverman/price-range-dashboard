# 注册两个 Windows 计划任务(S7)。时刻只在 config/params.json § run(S9 起从那里读)。
# 用法:右键「使用 PowerShell 运行」,或在 PowerShell 里: powershell -ExecutionPolicy Bypass -File ops\install-schedule.ps1
# 时间按本机时区;电脑时区应为美东。勾选了「唤醒计算机运行」:电脑可以睡眠,但不能关机;电源选项里要允许唤醒定时器。
$repo = Split-Path -Parent $PSScriptRoot
$run = (Get-Content (Join-Path $repo 'config\params.json') -Raw -Encoding UTF8 | ConvertFrom-Json).run
$MainAt = $run.daily_at_et       # 收盘后:拉取 → 计算 → 交接,赶在 Research OS EVENING 之前
$OiAt   = $run.options_oi_at_et  # 次日:补读收盘 OI → 重算 → 交接,赶在 Research OS MORNING 之前
$ps = (Get-Command powershell.exe).Source
$script = Join-Path $repo 'ops\run-scheduled.ps1'
$user = "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$tasks = @(
  @{ Name = 'PriceRangeDashboard Collect';    At = $MainAt; Days = 'Monday','Tuesday','Wednesday','Thursday','Friday';  Mode = 'main' },
  @{ Name = 'PriceRangeDashboard Options OI'; At = $OiAt;   Days = 'Tuesday','Wednesday','Thursday','Friday','Saturday'; Mode = 'oi' }
)
foreach ($t in $tasks) {
  $action  = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -Mode $($t.Mode)" -WorkingDirectory $repo
  $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $t.Days -At $t.At
  Register-ScheduledTask -TaskName $t.Name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  Write-Host ("已注册: {0}  {1}  {2}" -f $t.Name, $t.At, ($t.Days -join ','))
}
Write-Host '完成。在「任务计划程序」里能看到这两个任务;要撤掉运行 ops\uninstall-schedule.ps1。'
