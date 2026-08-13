# HMB laptop - reverse SSH forward, redial loop (#489 stage 3.5 follow-up).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-reverse-tunnel-task.ps1 -Status
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-reverse-tunnel-task.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-reverse-tunnel-task.ps1 -Uninstall
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-reverse-tunnel-task.ps1 -Run   (loop body; the task calls this)
#
# WHY THIS EXISTS  (measured 2026-08-13, #489)
#   The mac reaches this laptop through ONE path: a reverse forward that the laptop dials out,
#   'ssh -R 2223:localhost:22 <mac>'. It was created by hand as scheduled task HMB-ReverseTunnel
#   with a single AtStartup trigger, and it was NOT in the repo. AtStartup means "restored on
#   reboot", NOT "restored when it drops. So the first time the connection died, nothing
#   redialed it and remote access was gone until someone touched the machine physically.
#   That is exactly what happened: forward dead, 2223 closed on the mac for >12h, while the
#   laptop itself was healthy the whole time (cloudflared tunnel answering 401 in 0.107s and a
#   6h self-heal batch running to completion).
#
#   The asymmetry is the lesson: cloudflared went out of the same machine in the same direction
#   and survived, because cloudflared reconnects itself. Plain 'ssh -R' does not. So the fix is
#   not a bigger timeout, it is a loop.
#
# WHY THE LOOP LIVES ON WINDOWS AND NOT IN WSL
#   Everything else in this directory is owned by systemd inside the distro (see README), and
#   Restart=always would have been cheaper there. But this connection is the RESCUE PATH. WSL
#   distro death is a documented failure mode here (1h39m outage, see install-windows-boot-task.ps1),
#   and a rescue path that dies with the thing it rescues is not a rescue path. So it stays on
#   the Windows side, independent of WSL.
#
# WHAT THIS DOES NOT DO
#   It does not invent the dial parameters. On install it READS the existing HMB-ReverseTunnel
#   action, prints it, and reuses it - so the hand-made command that was never in version control
#   gets captured on first run instead of guessed. Explicit -Mac*/-Key/-RemotePorts override it,
#   and the built-in defaults are only a last resort.
#
# NOTE (ASCII only on purpose): Windows PowerShell 5.1 decodes .ps1 as ANSI without a BOM.
#   Korean comments would come back as mojibake. Same rule as install-windows-boot-task.ps1.

param(
  [switch]$Status,
  [switch]$Uninstall,
  [switch]$Run,
  [string]$TaskName   = 'HMB-ReverseTunnel',

  # Dial parameters. Empty = inherit from the currently registered task, then fall back to the
  # defaults below. Ordered candidate list: each attempt rotates to the next host.
  [string[]]$MacHosts   = @(),
  [string]$MacUser      = '',
  [int]$MacPort         = 0,
  [string]$Key          = '',
  # Rotated on "remote port forwarding failed" - a stale holder on the mac pins one port and
  # ExitOnForwardFailure would otherwise spin forever against it. The mac has ssh_config entries
  # for both (hmb-laptop=2223, hmb-laptop-manual=2222), so either one restores access.
  [int[]]$RemotePorts   = @(),
  [string]$Target       = '',

  [int]$BackoffMinSec   = 5,
  [int]$BackoffMaxSec   = 300,
  # A session that lasted at least this long counts as "it worked" -> reset backoff to minimum.
  [int]$StableSec       = 120,
  [int]$LogMaxBytes     = 2097152
)

$ErrorActionPreference = 'Stop'

# Last-resort defaults. Measured from the mac side on 2026-08-13:
#   user peter.park / LAN 192.168.224.58 / LocalHostName BH-L175 / authorized_keys comment
#   'hmb-laptop-tunnel' (ed25519, restrict,port-forwarding) / mac ssh_config Port 2223 and 2222.
# The .local name is listed second on purpose: it survives a DHCP lease change, but only resolves
# if mDNS works on this host, so it is a fallback and not the primary.
$DefaultMacHosts   = @('192.168.224.58', 'BH-L175.local')
$DefaultMacUser    = 'peter.park'
$DefaultMacPort    = 22
$DefaultRemotePorts= @(2223, 2222)
$DefaultTarget     = '127.0.0.1:22'
$DefaultKey        = (Join-Path $env:USERPROFILE '.ssh\hmb-laptop-tunnel')

$LogDir  = Join-Path $env:ProgramData 'hmb'
$LogFile = Join-Path $LogDir 'reverse-tunnel.log'
$ScriptPath = $MyInvocation.MyCommand.Path

function Write-Log([string]$msg) {
  if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
  if (Test-Path $LogFile) {
    $len = (Get-Item $LogFile).Length
    if ($len -gt $LogMaxBytes) { Move-Item -Force $LogFile ($LogFile + '.1') }
  }
  $line = ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
  Add-Content -Path $LogFile -Value $line
  Write-Output $line
}

function Get-SshExe {
  $p = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh.exe'
  if (Test-Path $p) { return $p }
  $c = Get-Command ssh -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  throw 'ssh.exe not found (install the Windows OpenSSH client)'
}

# --- read the hand-made task so the unknown parameters get captured, not guessed ---------------
function Get-ExistingAction {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $t) { return $null }
  $a = @($t.Actions)[0]
  if ($null -eq $a) { return $null }
  return [pscustomobject]@{
    Execute          = $a.Execute
    Arguments        = $a.Arguments
    WorkingDirectory = $a.WorkingDirectory
  }
}

function Parse-DialArgs([string]$argline) {
  # Pulls -i / -p / -R / user@host out of an ssh command line. Anything it cannot find stays
  # empty and the caller falls back. Deliberately forgiving: this parses a command written by
  # hand months ago, so it must not throw on a shape it does not recognise.
  $out = [pscustomobject]@{
    Key = ''; MacUser = ''; MacHost = ''; MacPort = 0; RemotePort = 0; Target = ''
  }
  if ([string]::IsNullOrWhiteSpace($argline)) { return $out }
  $toks = @([regex]::Matches($argline, '"[^"]*"|\S+') | ForEach-Object { $_.Value.Trim('"') })
  $num = 0
  try {
    for ($i = 0; $i -lt $toks.Count; $i++) {
      switch -Regex ($toks[$i]) {
        '^-i$' { if ($i+1 -lt $toks.Count) { $out.Key = $toks[$i+1]; $i++ }; break }
        '^-p$' {
          if ($i+1 -lt $toks.Count -and [int]::TryParse($toks[$i+1], [ref]$num)) { $out.MacPort = $num; $i++ }
          break
        }
        '^-R$' {
          if ($i+1 -lt $toks.Count) {
            # forms: 2223:localhost:22   or   127.0.0.1:2223:localhost:22
            $parts = $toks[$i+1].Split(':')
            if ($parts.Count -ge 4 -and [int]::TryParse($parts[1], [ref]$num)) {
              $out.RemotePort = $num; $out.Target = ($parts[2] + ':' + $parts[3])
            } elseif ($parts.Count -eq 3 -and [int]::TryParse($parts[0], [ref]$num)) {
              $out.RemotePort = $num; $out.Target = ($parts[1] + ':' + $parts[2])
            }
            $i++
          }
          break
        }
        '^[^-].*@.+$' { $kv = $toks[$i].Split('@'); $out.MacUser = $kv[0]; $out.MacHost = $kv[1]; break }
      }
    }
  } catch {
    # This parses a command line written by hand months ago. An unrecognised shape must degrade
    # to "fall back to defaults", never to a failed install.
    Write-Output ('! could not fully parse the existing action (' + $_.Exception.Message + ') - using what was read so far')
  }
  return $out
}

# --- status ------------------------------------------------------------------------------------
if ($Status) {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $t) { Write-Output ('not installed: ' + $TaskName) }
  else {
    $t | Format-List TaskName, State, Author
    Get-ScheduledTaskInfo -TaskName $TaskName | Format-List LastRunTime, LastTaskResult, NextRunTime
    Write-Output '--- action (THIS is what to paste back into #489: dial target, key path, ports) ---'
    Write-Output '--- if a password or token appears in these lines, redact that line before pasting ---'
    $t.Actions | Format-List Execute, Arguments, WorkingDirectory
    Write-Output '--- triggers (AtStartup alone = the #489 defect: restored on reboot, not on drop) ---'
    $t.Triggers | Format-List
  }
  Write-Output '--- ssh processes ---'
  Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" |
    Select-Object ProcessId, CreationDate, CommandLine | Format-List
  Write-Output '--- log tail ---'
  if (Test-Path $LogFile) { Get-Content $LogFile -Tail 25 } else { Write-Output ('(no log at ' + $LogFile + ')') }
  exit 0
}

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output ('uninstalled: ' + $TaskName)
  exit 0
}

# --- resolve dial parameters (explicit > existing task > defaults) -------------------------------
$existing = Get-ExistingAction
$parsed   = if ($null -ne $existing) { Parse-DialArgs $existing.Arguments } else { Parse-DialArgs '' }

if ($MacHosts.Count -eq 0) {
  if ($parsed.MacHost) { $MacHosts = @($parsed.MacHost) + ($DefaultMacHosts | Where-Object { $_ -ne $parsed.MacHost }) }
  else                 { $MacHosts = $DefaultMacHosts }
}
if (-not $MacUser)            { $MacUser = if ($parsed.MacUser) { $parsed.MacUser } else { $DefaultMacUser } }
if ($MacPort -le 0)           { $MacPort = if ($parsed.MacPort -gt 0) { $parsed.MacPort } else { $DefaultMacPort } }
if (-not $Key)                { $Key     = if ($parsed.Key) { $parsed.Key } else { $DefaultKey } }
if (-not $Target)             { $Target  = if ($parsed.Target) { $parsed.Target } else { $DefaultTarget } }
if ($RemotePorts.Count -eq 0) {
  if ($parsed.RemotePort -gt 0) { $RemotePorts = @($parsed.RemotePort) + ($DefaultRemotePorts | Where-Object { $_ -ne $parsed.RemotePort }) }
  else                          { $RemotePorts = $DefaultRemotePorts }
}

# --- the loop ------------------------------------------------------------------------------------
if ($Run) {
  $ssh = Get-SshExe
  Write-Log ('start: user=' + $MacUser + ' hosts=' + ($MacHosts -join ',') + ' macPort=' + $MacPort +
             ' remotePorts=' + ($RemotePorts -join ',') + ' target=' + $Target + ' key=' + $Key)
  if (-not (Test-Path $Key)) { Write-Log ('! key not found at ' + $Key + ' - dial will fail until this is fixed') }

  $attempt = 0
  $hostIdx = 0
  $portIdx = 0
  $backoff = $BackoffMinSec
  $errFile = Join-Path $env:TEMP 'hmb-reverse-tunnel.err'

  while ($true) {
    $attempt++
    $mh = $MacHosts[$hostIdx % $MacHosts.Count]
    $rp = $RemotePorts[$portIdx % $RemotePorts.Count]

    $sshArgs = @(
      '-N',
      '-i', $Key,
      '-p', $MacPort,
      '-R', ('{0}:{1}' -f $rp, $Target),
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=15',
      ('{0}@{1}' -f $MacUser, $mh)
    )

    Write-Log ('dial #' + $attempt + ' -> ' + $MacUser + '@' + $mh + ':' + $MacPort + ' -R ' + $rp + ':' + $Target)
    $t0 = Get-Date
    $rc = 0
    try {
      $p = Start-Process -FilePath $ssh -ArgumentList $sshArgs -NoNewWindow -PassThru -Wait `
                         -RedirectStandardError $errFile
      $rc = $p.ExitCode
    } catch {
      $rc = -1
      Write-Log ('! start-process failed: ' + $_.Exception.Message)
    }
    $dur = [int]((Get-Date) - $t0).TotalSeconds
    $err = ''
    if (Test-Path $errFile) { $err = (Get-Content $errFile -Raw); Remove-Item $errFile -Force -ErrorAction SilentlyContinue }
    if ($err) { foreach ($l in ($err -split "`r?`n" | Where-Object { $_ -ne '' })) { Write-Log ('  ssh: ' + $l) } }
    Write-Log ('exit rc=' + $rc + ' after ' + $dur + 's')

    if ($err -match 'remote port forwarding failed') {
      # The mac still has a listener bound on this port: either a live duplicate or a zombie
      # session whose TCP has not been reaped yet. Rotating gets access back on the other port;
      # the permanent fix is ClientAliveInterval on the mac (see check-reverse-tunnel-mac.sh).
      $portIdx++
      Write-Log ('! remote forward refused on ' + $rp + ' (stale holder on the mac?) - next attempt uses ' +
                 $RemotePorts[$portIdx % $RemotePorts.Count])
    }
    if ($dur -lt 10) { $hostIdx++ }   # died instantly: probably the wrong address, try the next one

    if ($dur -ge $StableSec) { $backoff = $BackoffMinSec }
    else { $backoff = [Math]::Min($backoff * 2, $BackoffMaxSec) }

    $jitter = Get-Random -Minimum 0 -Maximum 5
    Write-Log ('sleep ' + ($backoff + $jitter) + 's')
    Start-Sleep -Seconds ($backoff + $jitter)
  }
}

# --- install --------------------------------------------------------------------------------------
if ($null -ne $existing) {
  Write-Output '--- replacing the existing action (recorded here so #489 gets the real parameters) ---'
  $existing | Format-List Execute, Arguments, WorkingDirectory
}
Write-Output ('resolved dial: ' + $MacUser + '@[' + ($MacHosts -join ' | ') + ']:' + $MacPort +
              '  -R ' + ($RemotePorts -join '|') + ':' + $Target + '  key=' + $Key)
if (-not (Test-Path $Key)) { Write-Output ('WARNING: key not found at ' + $Key) }

$psExe   = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$argLine = ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Run ' +
            '-MacUser "{1}" -MacPort {2} -Key "{3}" -Target "{4}" -MacHosts {5} -RemotePorts {6}') -f `
           $ScriptPath, $MacUser, $MacPort, $Key, $Target,
           (($MacHosts | ForEach-Object { '"' + $_ + '"' }) -join ','),
           ($RemotePorts -join ',')

$action = New-ScheduledTaskAction -Execute $psExe -Argument $argLine

# Two triggers on purpose:
#   AtStartup            - same as before, covers reboot.
#   Once + repetition    - the layer that was missing. If the loop process itself is killed
#                          (crash, someone ends the task, a Windows update), the task is Ready
#                          again and the next 5-minute tick starts it. MultipleInstances=IgnoreNew
#                          means a healthy running loop is never disturbed by those ticks.
$tStart = New-ScheduledTaskTrigger -AtStartup
$tStart.Delay = 'PT30S'
# (No -RepetitionDuration: omitted means indefinite. Passing [TimeSpan]::MaxValue is rejected by
#  some PowerShell 5.1 builds, and a finite duration would silently stop the safety net later.)
$tRep = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
          -RepetitionInterval (New-TimeSpan -Minutes 5)

$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
                                        -LogonType S4U -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                                         -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$settings.ExecutionTimeLimit  = 'PT0S'          # the loop is supposed to run forever
$settings.MultipleInstances   = 'IgnoreNew'     # 5-minute ticks must not stack dialers

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($tStart, $tRep) `
                       -Principal $principal -Settings $settings `
                       -Description 'HMB reverse SSH forward to the mac, redialed on drop (#489). Loop body = this script with -Run.' | Out-Null

Write-Output ('registered: ' + $TaskName)
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 8
# Expected steady state: State=Running, LastTaskResult=267009 (running), one ssh.exe alive.
(Get-ScheduledTask -TaskName $TaskName) | Format-List TaskName, State
Get-ScheduledTaskInfo -TaskName $TaskName | Format-List LastRunTime, LastTaskResult
Write-Output '--- ssh processes ---'
Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | Select-Object ProcessId, CommandLine | Format-List
Write-Output ('--- log: ' + $LogFile + ' ---')
if (Test-Path $LogFile) { Get-Content $LogFile -Tail 20 }
