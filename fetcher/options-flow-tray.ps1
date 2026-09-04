# Windows tray host for the all-symbol options-flow monitor.
# Kept ASCII-only because legacy cmd.exe code pages can corrupt UTF-8 batch text.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$repoDir = Split-Path -Parent $PSScriptRoot
$nodeScript = Join-Path $PSScriptRoot 'options-flow.mjs'
$dashboard = Join-Path $repoDir 'options-dashboard.html'
$dataDir = Join-Path $repoDir 'Assets\options'
$logDir = Join-Path $repoDir 'Assets\_logs'
$logFile = Join-Path $logDir 'options-flow-monitor.log'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# Allow only one tray icon. Starting it again simply leaves the existing one in place.
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, 'PriceRangeOptionsFlowTray', [ref]$createdNew)
if (-not $createdNew) { exit 0 }

# Reuse an already-running ALL monitor instead of creating a FactSet profile conflict.
$existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*options-flow.mjs*--watch*--all*' } |
  Select-Object -First 1

if ($existing) {
  $proc = Get-Process -Id $existing.ProcessId -ErrorAction SilentlyContinue
} else {
  $env:FS_HEADLESS = '1'
  $errFile = Join-Path $logDir 'options-flow-monitor-error.log'
  $proc = Start-Process -FilePath 'node.exe' `
    -ArgumentList @("`"$nodeScript`"", '--watch', '--all') `
    -WorkingDirectory $repoDir -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $logFile -RedirectStandardError $errFile
}

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = [System.Drawing.SystemIcons]::Information
$tray.Text = 'Options Flow - starting'
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = $menu.Items.Add('Status: starting')
$statusItem.Enabled = $false
[void]$menu.Items.Add('-')
$openDashboard = $menu.Items.Add('Open Options Dashboard')
$openData = $menu.Items.Add('Open Options Data Folder')
$openLog = $menu.Items.Add('Open Monitor Log')
[void]$menu.Items.Add('-')
$stopItem = $menu.Items.Add('Stop Monitor and Exit')
$tray.ContextMenuStrip = $menu

$openDashboard.Add_Click({ Start-Process $dashboard })
$openData.Add_Click({ Start-Process explorer.exe $dataDir })
$openLog.Add_Click({
  if (Test-Path $logFile) { Start-Process notepad.exe $logFile }
  else { [System.Windows.Forms.MessageBox]::Show('The first log entry has not been written yet.', 'Options Flow') | Out-Null }
})

$context = New-Object System.Windows.Forms.ApplicationContext
$stopItem.Add_Click({
  if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  $tray.Visible = $false
  $context.ExitThread()
})
$tray.Add_DoubleClick({ Start-Process $dashboard })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({
  if ($proc -and -not $proc.HasExited) {
    $lastSchedule = $null
    if (Test-Path $logFile) {
      $lastSchedule = Get-Content $logFile -Tail 20 -ErrorAction SilentlyContinue |
        Where-Object { $_ -match 'next|Next|check|closed|session' } | Select-Object -Last 1
    }
    $statusItem.Text = if ($lastSchedule) { "Status: $lastSchedule" } else { "Status: running (PID $($proc.Id))" }
    $tray.Text = 'Options Flow - running'
  } else {
    $statusItem.Text = 'Status: stopped - check error log'
    $tray.Text = 'Options Flow - stopped'
    $tray.Icon = [System.Drawing.SystemIcons]::Warning
  }
})
$timer.Start()
$tray.ShowBalloonTip(3000, 'Options Flow Monitor', 'ALL-symbol monitoring is running. Right-click this tray icon for controls.', [System.Windows.Forms.ToolTipIcon]::Info)

try { [System.Windows.Forms.Application]::Run($context) }
finally {
  $timer.Stop(); $timer.Dispose(); $tray.Visible = $false; $tray.Dispose()
  if ($createdNew) { $mutex.ReleaseMutex() }; $mutex.Dispose()
}
