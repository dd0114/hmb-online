#!/usr/bin/env bash
# 터널 자가복구 워치독 설치/해제 (에픽 #183).
#
#   bash infra/install-tunnel-heal.sh            # 설치(또는 갱신 — 스크립트 수정 후 재실행)
#   bash infra/install-tunnel-heal.sh --uninstall
#   bash infra/install-tunnel-heal.sh --status
#
# 왜 복사인가: 이 머신엔 워크트리가 여러 개(spider9/10/14…)다. 서비스 관리자가 특정 체크아웃을
# 가리키면 그 워크트리가 사라지거나 브랜치가 바뀔 때 조용히 죽는다. 그래서 리포의 스크립트를
# ~/.local/bin 으로 **복사**해 실행하고, 어느 커밋에서 복사했는지 헤더에 박아 둔다.
# 스크립트를 고쳤으면 이 설치 스크립트를 다시 돌려야 반영된다.
#
# ── OS 이식 (#472 AC1.3) ──────────────────────────────────────────────────────
# mac = launchd(plist) · linux = systemd user unit(service + timer). 등록 방식만 다르고
# **성질은 같아야 한다** — 특히 워치독이 띄운 cloudflared 가 살아남는 것:
#   launchd  : 잡 종료 시 프로세스 그룹을 회수한다   → AbandonProcessGroup=true 로 막는다
#   systemd  : oneshot 종료 시 cgroup 잔여를 죽인다  → KillMode=process 로 막는다
# 이게 빠지면 매 틱 새 터널을 만드는 **스래시 루프**가 된다(#183 mac 실측). 이름만 다른 같은 고장이다.

set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
. infra/lib/portable.sh

OS=$(os_kind)
LABEL="${HMB_HEAL_LABEL:-online.hmb.tunnel-heal}"   # launchd
UNIT="${HMB_HEAL_UNIT:-hmb-tunnel-heal}"            # systemd
BIN="$HOME/.local/bin"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UNIT_DIR="$HOME/.config/systemd/user"
STATE_DIR="${HMB_STATE_DIR:-$HOME/.local/state/hmb}"
INTERVAL="${HMB_HEAL_INTERVAL:-60}"

case "${1:-}" in
  --uninstall)
    if [ "$OS" = linux ]; then
      systemctl --user disable --now "$UNIT.timer" 2>/dev/null || true
      rm -f "$UNIT_DIR/$UNIT.timer" "$UNIT_DIR/$UNIT.service"
      systemctl --user daemon-reload 2>/dev/null || true
    else
      launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
      rm -f "$PLIST"
    fi
    echo "[install] 해제 완료 ($OS · 스크립트·로그는 남는다: $BIN, $STATE_DIR)"
    exit 0;;
  --status)
    if [ "$OS" = linux ]; then
      systemctl --user status "$UNIT.timer" --no-pager 2>/dev/null | sed -n '1,12p' || echo "[install] 미설치"
    else
      launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | sed -n '1,12p' || echo "[install] 미설치"
    fi
    echo "--- 최근 이벤트 ---"; tail -5 "$STATE_DIR/tunnel-heal.log" 2>/dev/null || echo "(없음)"
    exit 0;;
esac

mkdir -p "$BIN" "$STATE_DIR"
if [ "$OS" = linux ]; then mkdir -p "$UNIT_DIR"; else mkdir -p "$HOME/Library/LaunchAgents"; fi

SHA=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
install_one(){ # <src> <dest>
  { printf '#!/usr/bin/env bash\n# ⚠️ 자동 설치본 — 원본은 리포의 %s (커밋 %s). 고치려면 원본을 고치고\n#    bash infra/install-tunnel-heal.sh 를 다시 실행한다.\n' "$1" "$SHA"
    tail -n +2 "$1"; } > "$2"
  chmod +x "$2"
  echo "[install] $1 → $2"
}
install_one infra/tunnel-heal.sh          "$BIN/hmb-tunnel-heal.sh"
install_one infra/publish-backend-url.sh  "$BIN/hmb-publish-backend-url.sh"

# launchd/systemd 둘 다 **최소 환경**으로 뜬다 — node(nvm)·패키지 경로를 명시하지 않으면
# npx/cloudflared 를 못 찾는다. (mac 은 homebrew, 리눅스는 /usr/local·/usr/bin.)
NODE_BIN=$(dirname "$(command -v node)")
if [ "$OS" = linux ]; then
  UNIT_PATH="$NODE_BIN:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
else
  UNIT_PATH="$NODE_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
fi
# ⚠️ `/tmp` 밖 (#497) — `/tmp` 는 부팅에 비워져 워치독의 기동 전제를 조용히 없앤다.
#    상세는 publish-backend-url.sh 의 같은 자리 주석. 여기서 만드는 것은 편의일 뿐이고,
#    실제 보증은 `publish-backend-url.sh` 가 매 실행 `mkdir -p` 하는 쪽이다.
WORKDIR="${HMB_WORK_DIR:-/var/tmp/hmb-wrangler-work}"
mkdir -p "$WORKDIR"

# wrangler 선설치: `npx -y wrangler` 는 실행마다 레지스트리 확인으로 **수 분**이 걸릴 수 있다
# (실측 ~4분 — 자가복구 MTTR 을 통째로 잡아먹었다). 전역 설치본이 있으면 전파가 수십 초로 떨어진다.
if ! command -v wrangler >/dev/null 2>&1 && [ "${HMB_SKIP_WRANGLER_INSTALL:-0}" != "1" ]; then
  echo "[install] wrangler 전역 설치 (자가복구 전파 속도용 — 건너뛰려면 HMB_SKIP_WRANGLER_INSTALL=1)"
  npm i -g wrangler >/dev/null 2>&1 || echo "[install] ⚠️ 전역 설치 실패 — npx 폴백으로 동작하나 느리다"
fi
if [ "$OS" = linux ]; then
  # ── systemd user unit ───────────────────────────────────────────────────────
  cat > "$UNIT_DIR/$UNIT.service" <<EOF
[Unit]
Description=HMB 터널 자가복구 워치독 (#183)
Documentation=https://github.com/dd0114/hmb-online/issues/183
After=network-online.target

[Service]
Type=oneshot
ExecStart=$BIN/hmb-tunnel-heal.sh --once
WorkingDirectory=$WORKDIR
# ⚠️ oneshot 은 메인 프로세스가 끝나면 systemd 가 **cgroup 잔여 프로세스를 죽인다**(KillMode 기본
#    control-group). 그러면 워치독이 방금 띄운 cloudflared 가 즉사하고, 다음 틱이 또 새 터널을
#    만드는 스래시 루프가 된다 — launchd 의 AbandonProcessGroup 이 막던 바로 그 고장(#183 실측).
KillMode=process
Environment=PATH=$UNIT_PATH
Environment=HOME=$HOME
StandardOutput=append:$STATE_DIR/tunnel-heal.out
StandardError=append:$STATE_DIR/tunnel-heal.err
EOF
  cat > "$UNIT_DIR/$UNIT.timer" <<EOF
[Unit]
Description=HMB 터널 자가복구 워치독 타이머 (매 ${INTERVAL}초 — plist StartInterval 등가)

[Timer]
OnBootSec=30
OnUnitActiveSec=$INTERVAL
AccuracySec=5s
Persistent=true
Unit=$UNIT.service

[Install]
WantedBy=timers.target
EOF
  echo "[install] unit → $UNIT_DIR/$UNIT.{service,timer} (매 ${INTERVAL}초)"

  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT.timer"
  echo "[install] systemd user timer 등록 완료"

  # ⚠️ systemd **user** 유닛은 로그인 세션이 없으면 안 돈다. 서버(EC2)는 로그인 상태가 아니다 —
  #    linger 없이는 재부팅/로그아웃 후 워치독이 조용히 사라진다(이사 후 첫 재부팅에 터진다).
  if loginctl enable-linger "$(id -un)" 2>/dev/null; then
    echo "[install] linger 활성 — 로그인 없이도 상시 가동"
  else
    echo "[install] ⚠️ linger 자동설정 실패 — 재부팅 후 워치독이 안 뜬다."
    echo "[install]    수동: sudo loginctl enable-linger $(id -un)"
  fi
else
  # ── launchd plist (mac) ─────────────────────────────────────────────────────
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BIN/hmb-tunnel-heal.sh</string>
    <string>--once</string>
  </array>
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <key>RunAtLoad</key><true/>
  <!-- ⚠️ 이게 없으면 워치독이 띄운 cloudflared 를 **launchd 가 회수한다**(잡이 끝나면 같은 프로세스
       그룹을 정리하는 게 기본값). 실측: 치유가 새 터널을 만들자마자 죽어 매 틱 새 터널을 만드는
       스래시 루프가 됐다. 자가복구가 성립하려면 반드시 true. -->
  <key>AbandonProcessGroup</key><true/>
  <!-- ⚠️ **WorkingDirectory 를 여기 두지 마라** (#497, 2026-08-13 실장애).
       예전엔 wrangler 의 cwd 문제(.wrangler/tmp 를 cwd 밑에 만든다) 때문에 여기에 박아 뒀다.
       그런데 launchd 의 WorkingDirectory 는 **기동 전제**다 — 그 디렉토리가 없으면 프로그램을
       실행조차 하지 않고 EX_CONFIG(78) 로 끝낸다. 경로가 /tmp 였고 macOS 는 부팅 때 /tmp 를
       비우므로, 재부팅 한 번에 워치독이 매 틱 spawn 실패했다. 스크립트가 안 도니
       StandardOutPath·StandardErrorPath·tunnel-heal.log 가 **전부 무음**이었고(자기 고장을
       자기가 기록할 수 없는 구조), 그 33분 동안 테스터 접속이 끊긴 채 자가복구가 발화하지 않았다.
       launchctl list 는 PID 를 보여줘서 "행(hang)" 처럼 보인다 — 실제로는 spawn 실패다.
       → cwd 는 **소비자가 스스로 만든다**: publish-backend-url.sh 가 매 실행 mkdir -p + cd 한다.
         (그래서 이 키는 애초에 없어도 되는 것이었고, 있는 동안은 순수한 단일 실패점이었다.)
       같은 이유로 이 plist 에는 **사라질 수 있는 기동 전제를 더 넣지 않는다.** StandardOut/Err 의
       상위 디렉토리($STATE_DIR)도 같은 부류라 설치기가 먼저 만들고, 워치독이 매 틱 되살린다. -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$NODE_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>StandardOutPath</key><string>$STATE_DIR/tunnel-heal.out</string>
  <key>StandardErrorPath</key><string>$STATE_DIR/tunnel-heal.err</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
EOF
  echo "[install] plist → $PLIST (매 ${INTERVAL}초)"

  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "[install] launchd 등록 완료"
fi

echo ""
if [ "${HMB_HEAL_SKIP_SELFTEST:-0}" != "1" ]; then
  echo "── 사전점검 ──"
  "$BIN/hmb-tunnel-heal.sh" --selftest || echo "[install] ⚠️ selftest 에 ✗ 가 있다 — 위 항목을 먼저 해결할 것"
  echo ""
fi
echo "상태 보기 : bash infra/install-tunnel-heal.sh --status"
echo "이벤트 로그: tail -f $STATE_DIR/tunnel-heal.log"
echo "해제      : bash infra/install-tunnel-heal.sh --uninstall"
