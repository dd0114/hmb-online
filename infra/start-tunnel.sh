#!/usr/bin/env bash
# 백엔드(18080)에 Cloudflare quick tunnel 을 띄우고, 그 URL 로 web 을 재배포한다.
# 테스터 링크를 (재)기동하는 한 방 커맨드.
#
#   bash infra/start-tunnel.sh
#
# 왜 quick tunnel: 무료·로그인 불필요·동시요청 부하 잘 버팀(ngrok 무료는 앱 로드 폭주에서 터짐 —
# 실측 CF 8/8 vs ngrok 0/8). 단점=재시작 시 URL 바뀜 → 이 스크립트가 재배포까지 해결.
#
# 전제: 백엔드 stack(java 18080)이 이미 떠 있어야 한다(cd infra && docker compose up -d java runner).
# 상시 URL 이 필요하면 named tunnel(도메인 필요) 또는 ngrok 유료 — deploy.md §5.2 참고.

set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

LOG=/tmp/hmb-cf-tunnel.log
PIDF=/tmp/hmb-cf-tunnel.pid

# 기존 터널 있으면 정리(PID로만 — 패턴 kill 금지)
if [ -f "$PIDF" ] && ps -p "$(cat "$PIDF")" >/dev/null 2>&1; then
  echo "[tunnel] 기존 터널 종료 (pid $(cat "$PIDF"))"; kill "$(cat "$PIDF")" 2>/dev/null || true; sleep 1
fi

echo "[tunnel] cloudflared quick tunnel 기동 → localhost:18080"
nohup cloudflared tunnel --url http://localhost:18080 --no-autoupdate > "$LOG" 2>&1 &
echo $! > "$PIDF"

URL=""
for _ in $(seq 1 30); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)
  [ -n "$URL" ] && break
  sleep 2
done
[ -z "$URL" ] && { echo "[tunnel] URL 획득 실패 — $LOG 확인"; exit 1; }
echo "[tunnel] URL = $URL (pid $(cat "$PIDF"))"

bash infra/deploy-web.sh "$URL"
echo "[tunnel] 테스터 접속: https://${PAGES_PROJECT:-hmb-online}.pages.dev"
