# SharedCut on Windows: server + Cloudflare tunnel as startup tasks.
#   .\scripts\windows-host.ps1 install   register both tasks (server starts, tunnel stays off)
#   .\scripts\windows-host.ps1 on        this machine serves sharedcut.com
#   .\scripts\windows-host.ps1 off       stop serving sharedcut.com (server keeps running)
#   .\scripts\windows-host.ps1 restart   load new code: stop the running server, start the task again
# Only ONE machine may run the tunnel: two connectors split traffic between two databases.
# Run from an admin PowerShell. Switch hosts from the Mac with scripts/switch-host.sh.
param([Parameter(Mandatory)][ValidateSet('install', 'on', 'off', 'restart')][string]$Action)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$cf = Join-Path $HOME '.cloudflared'
$logs = Join-Path $repo 'logs'

function Register-HostTask($name, $exe, $arguments) {
  $action = New-ScheduledTaskAction -Execute $exe -Argument $arguments -WorkingDirectory $repo
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew `
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
