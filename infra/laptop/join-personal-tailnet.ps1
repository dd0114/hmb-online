# HMB laptop - join the PERSONAL tailnet (#489 path b). Run once, on the laptop.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File join-personal-tailnet.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File join-personal-tailnet.ps1 -Status
#
# WHY
#   The mac reaches this laptop through exactly one path today: a reverse ssh forward the laptop
#   dials out. On 2026-08-13 that forward died and nobody could get in for over 12 hours while the
#   machine itself was perfectly healthy. Redialing (install-reverse-tunnel-task.ps1) fixes the
#   common case; this adds a SECOND, independent path so a single failure is never a lockout.
#
# ⚠️ PERSONAL TAILNET ONLY - THIS IS THE WHOLE POINT
#   This laptop must NOT appear on the company tailnet: that would let company members reach a
#   personal machine. The mac stays on the company tailnet through its own system daemon, and
#   talks to this laptop through a SECOND, userspace-only daemon bound to the personal tailnet
#   (see install-tailscale-b-mac.sh). Which tailnet a node joins is decided by the auth key, so
#   this script checks afterwards which tailnet it actually landed on and shouts if it is wrong.
#
# ⚠️ THE AUTH KEY IS ONE-TIME AND SHORT-LIVED
#   Do not paste it into an issue, a log, a commit, or a chat. This script never writes it to a
#   durable location and never echoes it. Generate it in the personal tailnet admin console with
#   reusable=false and the shortest expiry that fits, and let it expire after use.
#
# NOTE (ASCII only on purpose): Windows PowerShell 5.1 decodes .ps1 as ANSI without a BOM.

param(
  [switch]$Status,
  [string]$NodeName = 'hmb-laptop',
  # The company tailnet this node must NOT end up on. Checked after login.
  [string]$ForbiddenTailnet = 'tail3401b2.ts.net'
)

$ErrorActionPreference = 'Stop'

function Get-TailscaleExe {
  $cands = @(
    (Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Tailscale\tailscale.exe')
  )
  foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
  $g = Get-Command tailscale.exe -ErrorAction SilentlyContinue
  if ($g) { return $g.Source }
  return $null
}

function Show-Tailnet([string]$exe) {
  $json = & $exe status --json 2>$null | Out-String
  if (-not $json) { Write-Output 'tailscale status: (no output - not running or logged out)'; return $null }
  try { $o = $json | ConvertFrom-Json } catch { Write-Output 'tailscale status: (unparseable)'; return $null }
  $suffix = $o.MagicDNSSuffix
  $self   = $null
  if ($o.Self) { $self = $o.Self.DNSName }
  Write-Output ('  tailnet : ' + $suffix)
  Write-Output ('  this node: ' + $self)
  Write-Output ('  backend : ' + $o.BackendState)
  return $suffix
}

$exe = Get-TailscaleExe

if ($Status) {
  if ($null -eq $exe) { Write-Output 'tailscale is not installed'; exit 0 }
  Write-Output ('tailscale: ' + $exe)
  Show-Tailnet $exe | Out-Null
  Write-Output '--- peers ---'
  & $exe status 2>&1 | Select-Object -First 15
  exit 0
}

# --- 1. install ------------------------------------------------------------------------------
if ($null -eq $exe) {
  Write-Output 'tailscale not found - installing via winget'
  $w = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $w) {
    Write-Output 'winget is not available. Install manually from https://tailscale.com/download/windows'
    Write-Output 'then re-run this script.'
    exit 1
  }
  & winget install --id tailscale.tailscale --silent --accept-package-agreements --accept-source-agreements
  Start-Sleep -Seconds 5
  $exe = Get-TailscaleExe
  if ($null -eq $exe) { Write-Output 'still cannot find tailscale.exe after install - install manually'; exit 1 }
}
Write-Output ('tailscale: ' + $exe)

# --- 2. refuse to clobber an existing login ---------------------------------------------------
$cur = Show-Tailnet $exe
if ($cur -and $cur -eq $ForbiddenTailnet) {
  Write-Output ''
  Write-Output ('STOP: this node is already on the company tailnet (' + $ForbiddenTailnet + ').')
  Write-Output 'That is the exact state #489 requires to never happen. Log out first:'
  Write-Output ('  "' + $exe + '" logout')
  exit 1
}
if ($cur) {
  Write-Output ''
  Write-Output ('Already logged in to: ' + $cur + ' - nothing to do. Use -Status to inspect.')
  exit 0
}

# --- 3. auth key: prompt, use, destroy ---------------------------------------------------------
# The key is read as a SecureString so it is not echoed and does not land in PSReadLine history.
# It is then handed to tailscale through a file rather than the command line: an argument is
# visible to every process listing on the machine for the lifetime of the call, whereas this file
# is ACL'd to the current user and deleted immediately after.
Write-Output ''
Write-Output 'Paste the ONE-TIME auth key from the PERSONAL tailnet admin console.'
Write-Output '(reusable=false, short expiry. It will not be echoed, stored, or logged.)'
$sec = Read-Host -AsSecureString 'auth key'
$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try { $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
if ([string]::IsNullOrWhiteSpace($plain)) { Write-Output 'empty key - aborted'; exit 1 }

$keyFile = Join-Path $env:TEMP ('hmb-ts-' + [guid]::NewGuid().ToString('N') + '.key')
$rc = 1
try {
  Set-Content -Path $keyFile -Value $plain -NoNewline -Encoding ASCII
  # ACL: current user only.
  $acl = Get-Acl $keyFile
  $acl.SetAccessRuleProtection($true, $false)
  $acl.Access | ForEach-Object { [void]$acl.RemoveAccessRule($_) }
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'Allow')))
  Set-Acl -Path $keyFile -AclObject $acl

  # --unattended: keep the node connected with no interactive user logged on. Without it the
  #   second access path would only exist while someone is signed in - useless as a rescue path.
  # --accept-routes=false / --accept-dns=false: this node must not inherit anyone's routing or DNS.
  Write-Output ''
  Write-Output 'joining...'
  & $exe up --auth-key=("file:" + $keyFile) --hostname=$NodeName --unattended `
            --accept-routes=false --accept-dns=false
  $rc = $LASTEXITCODE
  if ($rc -ne 0) {
    # Older CLIs do not support the file: form. Fall back to the argument form.
    Write-Output 'file: form failed - retrying with the inline form (key is briefly visible to process listings)'
    & $exe up --auth-key=$plain --hostname=$NodeName --unattended `
              --accept-routes=false --accept-dns=false
    $rc = $LASTEXITCODE
  }
} finally {
  $plain = $null
  if (Test-Path $keyFile) {
    # Overwrite before unlinking so the bytes are not left in a freed cluster.
    try { Set-Content -Path $keyFile -Value ('0' * 256) -NoNewline -Encoding ASCII } catch {}
    Remove-Item $keyFile -Force -ErrorAction SilentlyContinue
  }
  [System.GC]::Collect()
}

if ($rc -ne 0) { Write-Output ('tailscale up failed (rc=' + $rc + ')'); exit $rc }

# --- 4. verify WHICH tailnet we landed on ------------------------------------------------------
Write-Output ''
Write-Output '--- result ---'
$now = Show-Tailnet $exe
if ($now -eq $ForbiddenTailnet) {
  Write-Output ''
  Write-Output 'STOP: that key belonged to the COMPANY tailnet. This is exactly what must not happen.'
  Write-Output 'Logging out now.'
  & $exe logout
  Write-Output 'Get a key from the PERSONAL tailnet admin console and run this again.'
  exit 1
}
Write-Output ''
Write-Output 'OK. Next: on the mac, verify the second path actually works by breaking the first one -'
Write-Output '  (mac) bash infra/laptop/install-tailscale-b-mac.sh --status'
Write-Output '  (mac) ssh hmb-laptop-ts true          # must succeed while the reverse forward is down'
Write-Output 'A second path that has never been tested while the first was down is not redundancy.'
