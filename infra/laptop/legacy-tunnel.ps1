# CAPTURED ARTIFACT - do not edit here to change the laptop. (#489, 2026-08-18)
#
# This is the verbatim body of C:\ProgramData\hmb\tunnel.ps1 on the HMB laptop, the loop that the
# hand-made scheduled task HMB-ReverseTunnel actually runs. It was created by hand and had never
# been in version control, which is why nobody could see what it did. Captured read-only over the
# live path so the next person reads code instead of guessing.
#
# WHAT IT CORRECTS
#   #489 recorded the outage root cause as "AtStartup only, so nothing redialed it when it dropped".
#   That is wrong. This loop DOES redial: while($true){ ssh -R ...; sleep 15 }. The AtStartup
#   trigger only starts the loop; the loop itself is what survives a drop.
#
# THE TWO REAL WEAKNESSES (measured 2026-08-18)
#   1. LAN-ONLY TARGETS. It dials peter.park@BH-L175.local and peter.park@172.30.1.33 - both are
#      this LAN. If the laptop ever leaves this network the reverse path cannot come back at all,
#      no matter how many times it retries. That is a structural ceiling, not a tuning problem.
#   2. FIXED PORT 2223 + ExitOnForwardFailure=yes. If a stale holder pins 2223 on the mac, every
#      redial is refused and the loop spins forever while looking healthy from here. There is no
#      port rotation. (infra/laptop/install-reverse-tunnel-task.ps1 adds 2223<->2222 rotation.)
#
# The durable answer to (1) is the second path, not a better loop: tailscale (mac -> laptop),
# which works off-LAN via DERP. See README and install-tailscale-b-mac.sh.
$ssh = "C:\Windows\System32\OpenSSH\ssh.exe"
$key = "C:\Windows\System32\config\systemprofile\.ssh\id_ed25519"
$kh  = "C:\ProgramData\hmb\known_hosts"
$log = "C:\ProgramData\hmb\tunnel.log"
$targets = @("peter.park@BH-L175.local", "peter.park@172.30.1.33")
$i = 0
while ($true) {
  if ((Get-Item $log -ErrorAction SilentlyContinue).Length -gt 2MB) { Clear-Content $log }
  $t = $targets[$i % $targets.Count]
  Add-Content $log "$(Get-Date -Format s) connect -> $t"
  & $ssh -N -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$kh `
        -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes `
        -o ConnectTimeout=20 -i $key -R 2223:localhost:22 $t 2>&1 |
        ForEach-Object { Add-Content $log "$(Get-Date -Format s) [ssh] $_" }
  Add-Content $log "$(Get-Date -Format s) dropped (exit=$LASTEXITCODE), retry 15s"
  $i++
  Start-Sleep -Seconds 15
}


