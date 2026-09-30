# SharedCut on Windows: server + Cloudflare tunnel as startup tasks.
#   .\scripts\windows-host.ps1 install   register both tasks (server starts, tunnel stays off)
#   .\scripts\windows-host.ps1 on        this machine serves sharedcut.com
#   .\scripts\windows-host.ps1 off       stop serving sharedcut.com (server keeps running)
#   .\scripts\windows-host.ps1 restart   load new code: stop the running server, start the task again
#   .\scripts\windows-host.ps1 setup     once: normal priority, a no-prompt restart task, current cloudflared
# After setup, any shell restarts the server without a UAC prompt:  schtasks /run /tn "SharedCut Restart"
# (result in logs\restart.log).
# Only ONE machine may run the tunnel: two connectors split traffic between two databases.
# Run from an admin PowerShell. Switch hosts from the Mac with scripts/switch-host.sh.
param([Parameter(Mandatory)][ValidateSet('install', 'on', 'off', 'restart', 'setup')][string]$Action)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$cf = Join-Path $HOME '.cloudflared'
$logs = Join-Path $repo 'logs'

function Register-HostTask($name, $exe, $arguments) {
  $action = New-ScheduledTaskAction -Execute $exe -Argument $arguments -WorkingDirectory $repo
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Highest
  # Priority 4 = normal. Task Scheduler's default 7 is below normal: the server then ran at the same
  # priority as its own FFmpeg jobs, and media requests queued behind encodes.
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -Priority 4 `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings `
    -Trigger (New-ScheduledTaskTrigger -AtStartup) -Force | Out-Null
}

switch ($Action) {
  'install' {
    New-Item -ItemType Directory -Force $logs | Out-Null
    $creds = Get-ChildItem $cf -Filter '*-*-*-*-*.json' | Select-Object -First 1
    if (-not $creds) { throw "Copy the tunnel credentials JSON into $cf first" }
    @"
metrics: 127.0.0.1:20241
tunnel: $($creds.BaseName)
credentials-file: $($creds.FullName)
originRequest:
  connectTimeout: 30s
ingress:
  - hostname: sharedcut.com
    service: http://127.0.0.1:4310
  - hostname: www.sharedcut.com
    service: http://127.0.0.1:4310
  - service: http_status:404
"@ | Set-Content (Join-Path $cf 'config.yml')

    $node = (Get-Command node).Source
    $cloudflared = (Get-Command cloudflared).Source
    Register-HostTask 'SharedCut Server' 'cmd.exe' `
      "/c `"`"$node`" --env-file-if-exists=.env --experimental-strip-types server/index.ts >> `"$logs\server.log`" 2>&1`""
    # cloudflared exits if DNS isn't up yet at boot, and Task Scheduler never restarts a
    # program that exits with an error - so loop it here.
    $loop = "while (`$true) { & '$cloudflared' --config '$cf\config.yml' --logfile '$logs\tunnel.log' tunnel run; Start-Sleep 10 }"
    Register-HostTask 'SharedCut Tunnel' 'powershell.exe' `
      "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($loop)))"
    Disable-ScheduledTask 'SharedCut Tunnel' | Out-Null
    Start-ScheduledTask 'SharedCut Server'
    'Installed. Server running; tunnel off until "on".'
  }
  'on' {
    Enable-ScheduledTask 'SharedCut Tunnel' | Out-Null
    Start-ScheduledTask 'SharedCut Tunnel'
    'Dell tunnel on.'
  }
  'off' {
    Disable-ScheduledTask 'SharedCut Tunnel' | Out-Null
    Stop-ScheduledTask 'SharedCut Tunnel'
    Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
    'Dell tunnel off.'
  }
  'setup' {
    Start-Transcript -Append (Join-Path $logs 'setup.log') | Out-Null
    foreach ($name in 'SharedCut Server', 'SharedCut Tunnel') {
      try { $task = Get-ScheduledTask $name; $task.Settings.Priority = 4; Set-ScheduledTask -InputObject $task | Out-Null }
      catch { "$name priority unchanged: $_" }
    }
    # An on-demand elevated task. Starting an existing task needs no elevation, so later restarts
    # (by Konrad or an agent) skip the UAC prompt.
    $run = "& '$PSCommandPath' restart *>> '$logs\restart.log'"
    # Not $action: PowerShell variables are case-insensitive, so that would be the ValidateSet-checked $Action parameter.
    $restartAction = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $repo `
      -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand $([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($run)))"
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew `
      -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName 'SharedCut Restart' -Action $restartAction -Principal $principal -Settings $settings -Force | Out-Null
    'Restart task registered.'
    # cloudflared does not update itself on Windows. The tunnel restarts either way to pick up the new priority.
    $tunnel = (Get-ScheduledTask 'SharedCut Tunnel').State -ne 'Disabled'
    Stop-ScheduledTask 'SharedCut Tunnel' -ErrorAction SilentlyContinue
    Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
    try { winget upgrade --id Cloudflare.cloudflared --exact --silent --accept-source-agreements --accept-package-agreements --disable-interactivity }
    catch { "cloudflared upgrade skipped: $_" }
    if ($tunnel) { Start-ScheduledTask 'SharedCut Tunnel' }
    & $PSCommandPath restart
    "Setup done. cloudflared $(& (Get-Command cloudflared).Source --version)"
    Stop-Transcript | Out-Null
  }
  'restart' {
    # Stop-ScheduledTask ends only cmd.exe. Its node child keeps port 4310 and server.log open, so the next
    # start exits with code 1 and the old code keeps serving: exports after an update still ran the old one.
    Stop-ScheduledTask 'SharedCut Server' -ErrorAction SilentlyContinue
    Get-NetTCPConnection -LocalPort 4310 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
    Start-Sleep 2
    Start-ScheduledTask 'SharedCut Server'
    Start-Sleep 5
    $server = Get-NetTCPConnection -LocalPort 4310 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $server) { throw "The server did not come back. See $logs\server.log" }
    "Server restarted (process $($server.OwningProcess))."
  }
}
