# HMB laptop - Windows boot hook (#489 AC1), stage 1 of the 3-stage boot chain.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-windows-boot-task.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-windows-boot-task.ps1 -Status
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-windows-boot-task.ps1 -Uninstall
#
# WHY THIS EXISTS
#   WSL is demand-started: nothing inside Ubuntu runs until Windows asks for it. So systemd,
#   docker and the heal timer all stay dead after a reboot unless something pokes wsl.exe.
#   This task is that poke. Everything else is owned by systemd inside the distro.
#
# WHY IT HOLDS A PROCESS INSTEAD OF POKING AND LEAVING  (measured 2026-08-12, #489)
#   The first version ran '-- /bin/true', which exits immediately. WSL then saw no attached
#   client and shut the DISTRO down - taking systemd, docker, the containers, cloudflared and
#   the reverse-ssh forward with it. Observed: journal silent from 22:59:51 to 00:38:34 (1h39m),
#   zero heal ticks, tunnel gone, and nothing revived it until an ssh from the mac woke WSL.
#   It is NOT a sleep problem - AC standby/hibernate idle timeouts are all 0 and lastwake is
#   empty. It is NOT covered by .wslconfig vmIdleTimeout=-1 either: that governs the utility
#   VM, not the distro. (Telltale: WSL2 shares one VM kernel, so boot_id and /proc/uptime stay
#   continuous across a distro restart - only journald's start time and 'who -b' move.)
#   So the task holds 'sleep infinity' for the life of the machine; the task stays in Running
#   state on purpose, which is why ExecutionTimeLimit is PT0S below.
#
# NOTE (ASCII only on purpose): this file is read by Windows PowerShell 5.1, which decodes
#   .ps1 as ANSI unless there is a BOM. Korean comments would come back as mojibake.
#
# LogonType S4U: runs at boot with no interactive logon and no stored password. If your
#   policy rejects S4U, fall back to an AtLogOn trigger plus Windows auto-logon.

param(
  [switch]$Status,
  [switch]$Uninstall,
  [string]$Distro = 'Ubuntu',
  [string]$TaskName = 'HMB-WSL-Boot'
)

$ErrorActionPreference = 'Stop'

if ($Status) {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $t) { Write-Output 'not installed'; exit 0 }
  $t | Format-List TaskName, State, Author
  Get-ScheduledTaskInfo -TaskName $TaskName | Format-List LastRunTime, LastTaskResult, NextRunTime
  Write-Output '--- wsl distros ---'
  wsl.exe -l -v
  exit 0
}

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output 'uninstalled'
  exit 0
}

$wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
if (-not (Test-Path $wsl)) { throw 'wsl.exe not found' }

# Long-lived holder (see WHY IT HOLDS A PROCESS above). Do not swap this for /bin/true.
$argLine = '-d ' + $Distro + ' --exec /usr/bin/sleep infinity'
$action  = New-ScheduledTaskAction -Execute $wsl -Argument $argLine
$trigger = New-ScheduledTaskTrigger -AtStartup

# Delay a little: docker/network inside WSL come up faster when Windows networking settled.
$trigger.Delay = 'PT30S'

$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
                                        -LogonType S4U -RunLevel Highest

# ExecutionTimeLimit 0 = no limit. RestartCount/Interval cover a boot where WSL is not ready yet.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                                         -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$settings.ExecutionTimeLimit = 'PT0S'

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
                       -Principal $principal -Settings $settings `
                       -Description 'Start WSL at boot so HMB systemd units (stack + tunnel heal) come up unattended.' | Out-Null

Write-Output ('registered: ' + $TaskName)
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 5
# Expected steady state: State=Running and LastTaskResult=267009 ("task is currently running").
# A task that has gone Ready with result 0 means the holder exited - the distro will idle out.
(Get-ScheduledTask -TaskName $TaskName) | Format-List TaskName, State
Get-ScheduledTaskInfo -TaskName $TaskName | Format-List LastRunTime, LastTaskResult
Write-Output '--- wsl distros (Ubuntu must stay Running) ---'
wsl.exe -l -v
