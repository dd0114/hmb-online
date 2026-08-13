#!/usr/bin/env bash
# #497 항목 3 — docker-autostart.sh 를 로그인 시 도는 LaunchAgent 로 설치한다.
#
#   bash infra/install-docker-autostart.sh              # 설치(또는 재설치)
#   bash infra/install-docker-autostart.sh --status     # 상태
#   bash infra/install-docker-autostart.sh --test       # 지금 1회 실행(무해 — Docker 가 떠 있으면 no-op)
#   bash infra/install-docker-autostart.sh --uninstall   # 제거
#
# ⚠️ 이 설치는 돌아가는 Docker 데몬에 손대지 않는다. 컨테이너를 내리지 않는다.
#    그래서 다른 도메인(tfs-ledger-view · hmb-growth · komodo)의 가용성을 소비하지 않는다.
#
# 📌 **지금은 설치돼 있지 않다 — 그게 의도다(2026-08-13).** 2026-08-13 에 매니저가 Docker 자체
#    설정(`autoStart=true`)을 켰다(#497 코멘트 5280856314). 이 에이전트까지 깔면 로그인 시
#    **기동 경로가 둘**이 되어 서로 레이스가 난다. 이 파일은 **폴백**이다 — 다음 자연 재부팅에서
#    `autoStart` 가 발화하지 않으면(= 로그인 아이템 등록이 안 됐다면, `evidence/497/reboot-checklist.md`
#    §1) **그때 설치한다**. 반대 방향도 성립: 이걸 쓰기로 하면 `autoStart` 를 끄는 쪽이 깔끔하다.
#
# ⚠️ #497 의 교훈: plist 에 사라질 수 있는 기동 전제를 두지 않는다.
#    WorkingDirectory 키 없음(있으면 그 경로가 사라진 순간 launchd 가 프로그램을 띄우지도
#    못하고 EX_CONFIG(78) 로 끝나며 stdout·stderr 가 둘 다 비어 무음이 된다 — 08:47Z 실장애).
#    로그 경로도 /tmp 밖(~/Library/Logs/hmb)이라 재부팅에 사라지지 않는다.
set -euo pipefail

LABEL="online.hmb.docker-autostart"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/docker-autostart.sh"
DST="$HOME/.local/bin/hmb-docker-autostart.sh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/hmb"
DOMAIN="gui/$(id -u)"

status(){
  echo "label   : $LABEL"
  echo "plist   : $PLIST $( [ -f "$PLIST" ] && echo '(있음)' || echo '(없음)' )"
  echo "script  : $DST $( [ -x "$DST" ] && echo '(실행가능)' || echo '(없음)' )"
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null \
      | awk -F'= *' '/state =|last exit code|runs =/{gsub(/^[ \t]+/,"");print "  "$0}'
  else
    echo "  (launchd 에 로드되지 않음)"
  fi
  echo "--- 로그 마지막 10줄 ---"
  tail -10 "$LOG_DIR/docker-autostart.log" 2>/dev/null | sed 's/^/  /' || echo "  (로그 없음)"
  echo "--- 참고: Docker 자체 설정 ---"
  python3 -c "import json,os;p=os.path.expanduser('~/Library/Group Containers/group.com.docker/settings.json');print('  autoStart =',json.load(open(p))['autoStart'])" 2>/dev/null \
    || echo "  (settings.json 을 읽지 못함)"
}

case "${1:-install}" in
  --status) status; exit 0 ;;
  --test)
    [ -x "$DST" ] || { echo "설치되지 않았다 — 먼저 설치해라"; exit 1; }
    echo "1회 실행한다(Docker 가 떠 있으면 no-op 이어야 한다)"
    before=$(docker ps -q 2>/dev/null | wc -l | tr -d ' ')
    "$DST"; rc=$?
    after=$(docker ps -q 2>/dev/null | wc -l | tr -d ' ')
    echo "rc=$rc  컨테이너 $before -> $after"
    [ "$before" = "$after" ] && echo "PASS — 상태 불변" || echo "✗ 컨테이너 수가 바뀌었다"
    tail -5 "$LOG_DIR/docker-autostart.log" 2>/dev/null | sed 's/^/  /'
    exit 0 ;;
  --uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST" "$DST"
    echo "제거 완료 (로그는 남긴다: $LOG_DIR/docker-autostart.log)"
    exit 0 ;;
esac

# ── 설치 ─────────────────────────────────────────────────────────────────────
mkdir -p "$HOME/.local/bin" "$HOME/Library/LaunchAgents" "$LOG_DIR"
install -m 0755 "$SRC" "$DST"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>

  <!-- 로그인 시 1회. KeepAlive 를 걸지 않는다 — 이건 감시자가 아니라 기동자다. -->
  <key>RunAtLoad</key><true/>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$DST</string>
  </array>

  <!--
    ⚠️ WorkingDirectory 키를 여기에 두지 마라 (#497).
    launchd 의 WorkingDirectory 는 spawn 전제다 — 경로가 없으면 프로그램을 실행조차 하지
    않고 EX_CONFIG(78) 로 끝내며, 실행이 안 됐으므로 리다이렉트할 출력도 없어 아래 로그
    경로가 아무리 멀쩡해도 **0줄**이 남는다. 2026-08-13 08:47Z 에 그 조합으로 33분간
    자가복구가 무음으로 죽어 있었다. 이 스크립트는 cwd 를 요구하지 않는다.
    로그 경로도 /tmp 가 아닌 ~/Library/Logs (재부팅에 비워지지 않는다).
  -->
  <key>StandardOutPath</key><string>$LOG_DIR/docker-autostart.launchd.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/docker-autostart.launchd.log</string>

  <!-- GUI 앱을 띄우므로 Aqua 세션에서만 의미가 있다. -->
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "설치 완료."
echo
status
echo
echo "다음: bash infra/install-docker-autostart.sh --test  로 무해성을 확인해라."
echo "⚠️ 실제 재부팅 복귀는 '다음 자연 재부팅' 때만 검증된다 — 검증하려고 재부팅하지 마라."
