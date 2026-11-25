# 撤掉 install-schedule.ps1 注册的两个计划任务
foreach ($n in 'PriceRangeDashboard Collect','PriceRangeDashboard Options OI') {
  Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "已撤掉: $n"
}
