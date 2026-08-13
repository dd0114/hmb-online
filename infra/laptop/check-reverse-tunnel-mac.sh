#!/usr/bin/env bash
# 맥 쪽 역방향 포워드 점검 (#489 단계3.5 후속) — 랩탑의 재다이얼 루프가 **닿는 끝**을 본다.
#
#   bash infra/laptop/check-reverse-tunnel-mac.sh            # 점검만 (부작용 0)
#   bash infra/laptop/check-reverse-tunnel-mac.sh --reap     # 죽은 홀더만 PID 로 정리
#
# 왜 이게 따로 필요한가
#   재다이얼을 랩탑에 넣으면 **다음 실패 모양이 맥으로 옮겨간다.** `ssh -R` 은 맥 sshd 가 그 포트를
#   이미 쥐고 있으면 `ExitOnForwardFailure=yes` 때문에 즉시 죽는다. 그리고 네트워크가 툭 끊긴
#   세션은 맥 sshd 가 **한참 동안 모른다** — TCP 는 몇 시간을 버틴다. 그 사이 랩탑은 정상적으로
#   재다이얼하는데 매번 거절당한다 = 재다이얼을 넣고도 접근이 0 인 상태가 만들어진다.
#   그래서 랩탑 루프는 포트를 2223↔2222 로 **번갈아 시도**하고, 맥은 여기서 죽은 홀더를 걷어낸다.
#
# ⚠️ 종료는 PID 로만 한다. `pkill -f ssh` 류는 다른 세션의 스택을 죽인다(프로젝트 규율).
# ⚠️ 라이브 hmb-online 과 무관하다 — 이 스크립트는 sshd·포트만 본다.

set -uo pipefail

PORTS="${HMB_TUNNEL_PORTS:-2223 2222}"
SSH_HOSTS="${HMB_TUNNEL_SSH_HOSTS:-hmb-laptop hmb-laptop-manual}"
REAP=0
[ "${1:-}" = "--reap" ] && REAP=1

say(){ printf '%s\n' "$*"; }
rc=0

# ⚠️ 리스닝 판정에 `lsof` 를 쓰면 **거짓 ✗** 가 난다 — 일반 사용자의 lsof 는 **root 소유 프로세스의
#    소켓을 아예 못 본다**. 실제로 이 스크립트 초판이 맥 sshd(root)를 "✗ :22 없음" 으로 보고했고,
#    같은 순간 `nc -z 127.0.0.1 22` 는 열려 있었다. 그 오판을 그대로 두면 hero 를 "원격 로그인을
#    켜라"는 없는 문제로 보낸다. → 소유자와 무관한 `netstat` 로 판정한다.
#    (PID 조회는 계속 lsof 로 한다: 역방향 포워드 리스너는 **내 사용자** sshd 세션이 만들므로 보인다.)
port_listening(){ netstat -an -p tcp 2>/dev/null | awk '/LISTEN/{print $4}' | grep -qE "[.*]\.$1\$"; }

say "── 역방향 포워드 (맥 = 포워드를 받는 쪽) ──"

# ① 리스너 — 있는가, 누가 쥐고 있는가
declare -a live_ports=()
for p in $PORTS; do
  if ! port_listening "$p"; then
    say "✗ :$p 리스너 없음 — 랩탑이 다이얼하지 않았거나 다이얼이 실패하고 있다"
    rc=1
    continue
  fi
  live_ports+=("$p")
  pids=$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null | sort -u)
  if [ -z "$pids" ]; then
    say "✓ :$p 리스너 있음 (PID 는 이 사용자에게 안 보임 — 다른 사용자 소유)"
  else
    for pid in $pids; do
      info=$(ps -o lstart=,command= -p "$pid" 2>/dev/null | head -1)
      say "✓ :$p 리스너 pid=$pid  $info"
    done
  fi
done

# ② 리스너가 **살아 있는지**는 리스너 존재로 알 수 없다 — 실제로 통과시켜 봐야 한다.
#    좀비 홀더는 포트를 쥔 채로 연결을 못 넘긴다(= 존재하는데 죽은 것).
for h in $SSH_HOSTS; do
  hp=$(ssh -G "$h" 2>/dev/null | awk '/^port /{print $2}')
  [ -z "$hp" ] && continue
  case " ${live_ports[*]:-} " in *" $hp "*) ;; *) continue;; esac
  if ssh -o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=3 -o ServerAliveCountMax=2 \
         "$h" true >/dev/null 2>&1; then
    say "✓ $h (:$hp) 실제 통과 — 랩탑까지 살아 있다"
  else
    say "✗ $h (:$hp) 리스너는 있는데 통과 못 함 = **좀비 홀더**"
    say "    랩탑은 재다이얼해도 이 포트에서 계속 거절당한다(ExitOnForwardFailure)."
    say "    처방:  bash $0 --reap    (해당 sshd PID 만 종료)"
    rc=1
    if [ "$REAP" = "1" ]; then
      for pid in $(lsof -nP -iTCP:"$hp" -sTCP:LISTEN -t 2>/dev/null | sort -u); do
        say "    → kill $pid (PID 지정)"
        kill "$pid" 2>/dev/null || say "    ! kill 실패 pid=$pid"
      done
      sleep 2
      lsof -nP -iTCP:"$hp" -sTCP:LISTEN -t >/dev/null 2>&1 \
        && say "    ! 아직 잡혀 있다 — 잠시 뒤 다시 확인" \
        || say "    ✓ 정리됨 — 랩탑 루프가 다음 시도에서 다시 잡는다"
    fi
  fi
done

# ③ 맥 sshd 가 켜져 있는가 — 꺼져 있으면 랩탑은 무엇을 해도 못 붙는다
say ""
say "── 맥 sshd (랩탑이 다이얼해 들어오는 문) ──"
if port_listening 22; then
  say "✓ :22 sshd 리스닝"
else
  say "✗ :22 sshd 없음 — 시스템설정 > 일반 > 공유 > 원격 로그인 을 켜야 한다"
  rc=1
fi

# ④ 좀비 홀더가 **애초에 안 생기게** 하는 설정. 이것이 없으면 ②는 매번 사람이 치워야 한다.
#    sudo 가 필요해 여기서 고치지 않고 **명령만 찍는다**(무단 시스템 변경 금지).
ka=$(awk '/^[[:space:]]*ClientAlive(Interval|CountMax)/{print}' /etc/ssh/sshd_config 2>/dev/null)
if [ -n "$ka" ]; then
  say "✓ sshd_config ClientAlive 설정 있음:"
  printf '    %s\n' "$ka"
else
  say "! sshd_config 에 ClientAlive 설정이 없다 = 끊긴 세션을 맥이 늦게(수 시간) 알아챈다"
  say "    그동안 그 포트는 좀비가 쥐고 있고 랩탑의 재다이얼은 전부 거절된다."
  say "    처방(사람이 1회, sudo):"
  say "      sudo sh -c 'printf \"\\nClientAliveInterval 30\\nClientAliveCountMax 3\\n\" >> /etc/ssh/sshd_config'"
  say "      sudo launchctl kickstart -k system/com.openssh.sshd"
fi

# ⑤ 포워드 인증에 쓰는 키의 제약 — 접근 경로가 열려 있다는 것은 그만큼 좁아야 한다
say ""
say "── 포워드 전용 키 제약 (authorized_keys) ──"
if [ -f "$HOME/.ssh/authorized_keys" ]; then
  if grep -q 'hmb-laptop-tunnel' "$HOME/.ssh/authorized_keys" 2>/dev/null; then
    opts=$(awk '/hmb-laptop-tunnel/{ n=split($0,a," "); s=""; for(i=1;i<=n;i++){ if(a[i] ~ /^(ssh-|ecdsa-|sk-)/) break; s = s " " a[i] } print s }' "$HOME/.ssh/authorized_keys" | head -1)
    say "✓ hmb-laptop-tunnel 키 등록됨"
    say "   제약:$opts"
    case "$opts" in
      *restrict*port-forwarding*) say "✓ restrict + port-forwarding = 셸 없이 포워드만. 의도대로다";;
      *) say "! 제약이 restrict,port-forwarding 형태가 아니다 — 이 키로 셸이 열릴 수 있다"; rc=1;;
    esac
  else
    say "✗ authorized_keys 에 hmb-laptop-tunnel 항목이 없다 — 랩탑이 인증을 못 한다"
    rc=1
  fi
else
  say "✗ ~/.ssh/authorized_keys 없음"
  rc=1
fi

say ""
[ "$rc" -eq 0 ] && say "== 종합: 정상 ==" || say "== 종합: 이상 있음 (위 ✗ 참조) =="
exit "$rc"
