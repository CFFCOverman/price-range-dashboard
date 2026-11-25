# 计划任务调用的入口(S7)。时刻只在 install-schedule.ps1 顶部定义一次。
#   -Mode main : 到期的数据集都拉 → 计算价位与估值 → 写交接包(17:45)
#   -Mode oi   : 补读上一快照日的收盘 OI → 重算(价位改用收盘 OI)→ 写交接包(06:30)
# 后台运行(FS_HEADLESS=1):登录过期不弹浏览器,而是弹系统通知,请你双击 ops\login.bat。
param([ValidateSet('main','oi')][string]$Mode = 'main')
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$logDir = Join-Path $repo 'ops\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Get-ChildItem $logDir -Filter *.log | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } | Remove-Item -ErrorAction SilentlyContinue
$log = Join-Path $logDir ("{0:yyyy-MM-dd}-{1}.log" -f (Get-Date), $Mode)
$env:FS_HEADLESS = '1'
function Step([string[]]$nodeArgs) {
  "---- node $($nodeArgs -join ' ')" | Out-File -Append -Encoding utf8 $log
  & node @nodeArgs *>&1 | Out-File -Append -Encoding utf8 $log
  return $LASTEXITCODE
}
"==== $(Get-Date -Format s) $Mode ====" | Out-File -Append -Encoding utf8 $log
if ($Mode -eq 'oi') { $c1 = Step @('collect/run.mjs', '--only=options-oi') } else { $c1 = Step @('collect/run.mjs') }
$c2 = Step @('process/run.mjs')   # 拉取有个别失败也照样计算:用已有的最新数据
$code = if ($c1 -ne 0) { $c1 } else { $c2 }
"exit collect=$c1 process=$c2" | Out-File -Append -Encoding utf8 $log
if ($code -ne 0) {
  $text = Get-Content $log -Raw -Encoding utf8
  if ($text -match '登录已失效') { $msg = 'FactSet 登录已过期:请双击 ops\login.bat 登录一次。' }
  else { $msg = '拉取或计算有失败项:打开控制台的「运行」页,或看 ops\logs。' }
  Add-Type -AssemblyName System.Windows.Forms
  $n = New-Object System.Windows.Forms.NotifyIcon
  $n.Icon = [System.Drawing.SystemIcons]::Warning
  $n.Visible = $true
  $n.ShowBalloonTip(30000, 'Price Range 拉取', $msg, 'Warning')
  Start-Sleep -Seconds 30
  $n.Dispose()
}
exit $code
