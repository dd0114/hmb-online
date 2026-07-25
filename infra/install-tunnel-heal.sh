#!/usr/bin/env bash
# 터널 자가복구 워치독 설치/해제 (에픽 #183).
#
#   bash infra/install-tunnel-heal.sh            # 설치(또는 갱신 — 스크립트 수정 후 재실행)
#   bash infra/install-tunnel-heal.sh --uninstall
#   bash infra/install-tunnel-heal.sh --status
#
# 왜 복사인가: 이 머신엔 워크트리가 여러 개(spider9/10/14…)다. launchd 가 특정 체크아웃을
# 가리키면 그 워크트리가 사라지거나 브랜치가 바뀔 때 조용히 죽는다. 그래서 리포의 스크립트를
# ~/.local/bin 으로 **복사**해 실행하고, 어느 커밋에서 복사했는지 헤더에 박아 둔다.
# 스크립트를 고쳤으면 이 설치 스크립트를 다시 돌려야 반영된다.

set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

LABEL="online.hmb.tunnel-heal"
BIN="$HOME/.local/bin"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
STATE_DIR="${HMB_STATE_DIR:-$HOME/.local/state/hmb}"
INTERVAL="${HMB_HEAL_INTERVAL:-60}"

case "${1:-}" in
  --uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "[install] 해제 완료 (스크립트·로그는 남는다: $BIN, $STATE_DIR)"
    exit 0;;
  --status)
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | sed -n '1,12p' || echo "[install] 미설치"
    echo "--- 최근 이벤트 ---"; tail -5 "$STATE_DIR/tunnel-heal.log" 2>/dev/null || echo "(없음)"
    exit 0;;
esac

mkdir -p "$BIN" "$STATE_DIR" "$HOME/Library/LaunchAgents"

SHA=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
install_one(){ # <src> <dest>
  { printf '#!/usr/bin/env bash\n# ⚠️ 자동 설치본 — 원본은 리포의 %s (커밋 %s). 고치려면 원본을 고치고\n#    bash infra/install-tunnel-heal.sh 를 다시 실행한다.\n' "$1" "$SHA"
    tail -n +2 "$1"; } > "$2"
  chmod +x "$2"
  echo "[install] $1 → $2"
}
install_one infra/tunnel-heal.sh          "$BIN/hmb-tunnel-heal.sh"
install_one infra/publish-backend-url.sh  "$BIN/hmb-publish-backend-url.sh"

# launchd 는 최소 환경으로 뜬다 — node(nvm)·homebrew 경로를 명시하지 않으면 npx/cloudflared 를 못 찾는다.
NODE_BIN=$(dirname "$(command -v node)")
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

echo ""
echo "── 사전점검 ──"
"$BIN/hmb-tunnel-heal.sh" --selftest || echo "[install] ⚠️ selftest 에 ✗ 가 있다 — 위 항목을 먼저 해결할 것"
echo ""
echo "상태 보기 : bash infra/install-tunnel-heal.sh --status"
echo "이벤트 로그: tail -f $STATE_DIR/tunnel-heal.log"
echo "해제      : bash infra/install-tunnel-heal.sh --uninstall"
