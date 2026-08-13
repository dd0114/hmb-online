#!/usr/bin/env bash
# 맥에 **두 번째 tailscaled** 를 올린다 — 개인 tailnet 전용, userspace 모드 (#489 경로 ⓑ).
#
#   bash infra/laptop/install-tailscale-b-mac.sh            # 설치 + 기동(로그아웃 상태로 대기)
#   bash infra/laptop/install-tailscale-b-mac.sh --status
#   bash infra/laptop/install-tailscale-b-mac.sh --login     # hero 가 브라우저로 개인 계정 로그인
#   bash infra/laptop/install-tailscale-b-mac.sh --uninstall
#
# ── 왜 두 번째 데몬인가 ────────────────────────────────────────────────────────────
# 랩탑에 닿는 경로가 **역방향 ssh 하나뿐**이었고, 그게 끊긴 채 12시간 넘게 아무도 못 들어갔다
# (#489, 2026-08-13). 이중화가 필요한데 제약이 두 개다:
#   ① 이 맥은 **회사 tailnet**(tail3401b2)에 붙어 있고 그건 끊으면 안 된다.
#   ② 랩탑은 **회사 tailnet 에 올리면 안 된다** — 회사 구성원이 hero 개인 랩탑에 닿게 된다.
# tailscale 은 노드당 **활성 tailnet 이 1개**다(프로필은 *동시*가 아니라 *전환*). 그래서:
#   ⓐ 노드 공유  = 회사 tailnet ACL(외부 공유 수락) + 계정 아이덴티티에 의존. 게다가 맥 계정이
#                  debug.yoon@gmail.com 이라 같은 계정으로 개인 tailnet 을 만들면 자기 자신에게
#                  공유가 안 된다. → 기각.
#   ⓑ 두 번째 데몬 = 시스템 인스턴스를 **손대지 않고** 개인 tailnet 에 붙는 독립 데몬을 하나 더
#                  띄운다. 랩탑은 개인 tailnet 에만 조인 → **회사 tailnet 에 아예 안 올라간다**.
#                  제약 ②를 정책이 아니라 **위상**으로 만족한다. → 채택.
#
# ── 왜 userspace-networking 인가 ───────────────────────────────────────────────────
# 두 데몬이 각자 utun 인터페이스와 라우팅 테이블을 잡으면 시스템 인스턴스와 충돌한다. userspace
# 모드는 커널 인터페이스를 **아예 만들지 않고** SOCKS5 프록시로만 내보낸다 — 회사 tailnet 의
# 라우팅에 손을 대지 않는다는 것이 계약이다. 대가는 "일반 앱이 그냥 못 쓴다" 인데, 우리 용도는
# **ssh 하나**라 `ProxyCommand` 로 충분하다.
#
# ⚠️ 이 스크립트는 시스템 tailscaled 를 **읽지도 고치지도 않는다**. 확인만 하고, 충돌하면 선다.
# ⚠️ 인증키·계정 정보를 **파일로 남기지 않는다**. --login 은 브라우저 URL 을 띄울 뿐이다.

set -uo pipefail

LABEL="online.hmb.tailscaled-personal"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
TS_DIR="${HMB_TS_DIR:-$HOME/.local/state/hmb/tailscale-personal}"
SOCKET="$TS_DIR/tailscaled.sock"
STATE="$TS_DIR/tailscaled.state"
LOGD="$TS_DIR"
SOCKS_PORT="${HMB_TS_SOCKS_PORT:-1085}"
HOSTNAME_TAG="${HMB_TS_HOSTNAME:-bh-l175-personal}"
SSH_HOST="${HMB_TS_SSH_HOST:-hmb-laptop-ts}"
LAPTOP_TS_NAME="${HMB_LAPTOP_TS_NAME:-hmb-laptop}"
LAPTOP_USER="${HMB_LAPTOP_USER:-도현}"

TSD="$(command -v tailscaled || echo /opt/homebrew/bin/tailscaled)"
TSC="$(command -v tailscale  || echo /opt/homebrew/bin/tailscale)"
ts(){ "$TSC" --socket="$SOCKET" "$@"; }

say(){ printf '%s\n' "$*"; }

case "${1:-}" in
  --status)
    say "── 시스템 인스턴스 (회사 tailnet — 무접촉이어야 한다) ──"
    if pgrep -x tailscaled >/dev/null 2>&1; then
      say "✓ tailscaled 프로세스 있음: $(pgrep -x tailscaled | tr '\n' ' ')"
      "$TSC" status 2>/dev/null | head -3 | sed 's/^/    /'
      say "    tailnet: $("$TSC" status --json 2>/dev/null | awk -F'"' '/MagicDNSSuffix/{print $4; exit}')"
    else
      say "✗ 시스템 tailscaled 없음"
    fi
    say ""
    say "── 개인 인스턴스 ⓑ ──"
    if [ -S "$SOCKET" ]; then
      say "✓ 소켓 있음: $SOCKET"
      ts status 2>&1 | head -10 | sed 's/^/    /'
      say "    SOCKS5: 127.0.0.1:$SOCKS_PORT $(nc -z -G 2 127.0.0.1 "$SOCKS_PORT" 2>/dev/null && echo '(열림)' || echo '(닫힘)')"
    else
      say "✗ 소켓 없음 ($SOCKET) — 미설치이거나 데몬이 안 떠 있다"
    fi
    say ""
    say "── ssh 경로 ──"
    grep -qE "^Host[[:space:]]+$SSH_HOST\b" "$HOME/.ssh/config" 2>/dev/null \
      && say "✓ ~/.ssh/config 에 $SSH_HOST 있음" || say "✗ ~/.ssh/config 에 $SSH_HOST 없음"
    grep -qE "^Host[[:space:]]+hmb-laptop\b" "$HOME/.ssh/config" 2>/dev/null \
      && say "✓ 기존 hmb-laptop(역방향 포워드) 항목 보존됨 — 경로가 둘이어야 이중화다" \
      || say "! 기존 hmb-laptop 항목이 없다 — ⓑ 가 유일 경로가 되면 이중화가 아니다"
    exit 0;;

  --uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    say "[ts-b] launchd 해제. 상태 디렉토리는 남긴다: $TS_DIR"
    say "       완전 삭제는 수동으로:  rm -rf $TS_DIR"
    exit 0;;

  --login)
    [ -S "$SOCKET" ] || { say "✗ 데몬이 안 떠 있다 — 먼저 인자 없이 실행해 설치하라"; exit 1; }
    say "⚠️ **개인 계정으로** 로그인해야 한다. 회사 계정으로 로그인하면 이 맥이 회사 tailnet 에"
    say "   두 번 붙는 것이고 ⓑ 의 목적(랩탑을 회사 tailnet 밖에 두기)이 사라진다."
    say ""
    ts up --hostname="$HOSTNAME_TAG" --accept-routes=false --accept-dns=false
    say ""
    ts status 2>&1 | head -5
    exit $?;;
esac

# ── 설치 ────────────────────────────────────────────────────────────────────────────
[ -x "$TSD" ] || { say "✗ tailscaled 없음 ($TSD) — brew install tailscale"; exit 1; }
say "✓ tailscaled = $TSD ($("$TSD" --version 2>/dev/null | head -1))"

# 시스템 인스턴스를 확인만 한다 — 여기서 **아무것도 바꾸지 않는다**.
if pgrep -x tailscaled >/dev/null 2>&1; then
  sys_tailnet=$("$TSC" status --json 2>/dev/null | awk -F'"' '/MagicDNSSuffix/{print $4; exit}')
  say "✓ 시스템 인스턴스 가동 중 (tailnet: ${sys_tailnet:-?}) — 이 스크립트는 손대지 않는다"
fi

# 포트 충돌 방지: SOCKS5 포트가 이미 쓰이면 선다(남의 프록시를 빼앗지 않는다).
if nc -z -G 2 127.0.0.1 "$SOCKS_PORT" >/dev/null 2>&1; then
  say "✗ 127.0.0.1:$SOCKS_PORT 이미 사용 중 — HMB_TS_SOCKS_PORT 로 다른 포트를 주라"
  exit 1
fi

mkdir -p "$TS_DIR"
chmod 700 "$TS_DIR"

# --tun=userspace-networking : 커널 인터페이스를 만들지 않는다(시스템 인스턴스와 무충돌).
# --port=0                   : UDP 포트 자동(고정하면 시스템 인스턴스와 부딪힐 수 있다).
# --socks5-server            : ssh ProxyCommand 가 탈 유일한 출구.
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$TSD</string>
    <string>--tun=userspace-networking</string>
    <string>--socket=$SOCKET</string>
    <string>--statedir=$TS_DIR</string>
    <string>--state=$STATE</string>
    <string>--socks5-server=localhost:$SOCKS_PORT</string>
    <string>--port=0</string>
    <string>--verbose=0</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- ⚠️ WorkingDirectory 를 넣지 않는다 — 없어지면 launchd 가 EX_CONFIG(78) 로 **실행조차
       안 한다**. 그 부류로 워치독이 33분 무음으로 죽은 적이 있다(#497). -->
  <key>StandardOutPath</key><string>$LOGD/tailscaled.out</string>
  <key>StandardErrorPath</key><string>$LOGD/tailscaled.err</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
EOF
say "✓ plist → $PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" || { say "✗ launchd 등록 실패"; exit 1; }
say "✓ launchd 등록"

# 소켓이 뜰 때까지 잠깐 기다린다(콜드 스타트).
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -S "$SOCKET" ] && break; sleep 1; done
[ -S "$SOCKET" ] && say "✓ 데몬 기동 (소켓 $SOCKET)" || { say "✗ 소켓이 안 생겼다 — $LOGD/tailscaled.err 확인"; exit 1; }

# ── 시스템 인스턴스 무영향 확인 (이게 이 스크립트의 핵심 계약이다) ─────────────────
say ""
say "── 회사 tailnet 무영향 확인 ──"
if "$TSC" status >/dev/null 2>&1; then
  say "✓ 시스템 tailscale status 정상 (회사 tailnet 유지)"
else
  say "✗ 시스템 tailscale status 이상 — 즉시 --uninstall 하고 조사할 것"
fi

# ── ssh 설정 조각 (기존 hmb-laptop 은 **남긴다** — 경로가 둘이어야 이중화다) ─────────
say ""
if grep -qE "^Host[[:space:]]+$SSH_HOST\b" "$HOME/.ssh/config" 2>/dev/null; then
  say "✓ ~/.ssh/config 에 $SSH_HOST 이미 있음"
else
  say "다음 블록을 ~/.ssh/config 에 추가하라 (기존 hmb-laptop 은 지우지 말 것):"
  cat <<EOF

# ⓑ 개인 tailnet 경유 (#489). 역방향 포워드(hmb-laptop)가 죽어도 이 경로로 들어간다.
Host $SSH_HOST
  HostName $LAPTOP_TS_NAME
  User $LAPTOP_USER
  ProxyCommand /usr/bin/nc -X 5 -x 127.0.0.1:$SOCKS_PORT %h %p
  StrictHostKeyChecking accept-new
  UserKnownHostsFile ~/.ssh/known_hosts_hmb
  ServerAliveInterval 30
EOF
fi

say ""
say "── 다음 단계 ──"
say "1) hero: 개인 계정으로 로그인   bash $0 --login"
say "2) hero: 개인 tailnet 관리콘솔에서 **일회용·짧은 만료** auth key 발급 (재사용 금지·태그 부여)"
say "3) 랩탑: infra/laptop/join-personal-tailnet.ps1 실행 (키는 붙여넣기, 디스크에 안 남는다)"
say "4) 검증: 역방향 포워드를 **일부러 끊고** 'ssh $SSH_HOST true' 가 되는지 — 그래야 이중화다"
say ""
say "상태: bash $0 --status"
