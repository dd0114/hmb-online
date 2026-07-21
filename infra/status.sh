#!/usr/bin/env bash
# 배포 상태 한 눈에 — 테스터 오픈 중 "지금 살아있나?" 를 이 한 줄로 확인한다.
#
#   bash infra/status.sh
#
# 검사: web(Pages) · 백엔드(로컬 18080 + 터널 경유) · 도커 3프로세스 · executor · 터널 URL.
# 읽기 전용(아무것도 안 바꿈).

cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
PAGES="https://${PAGES_PROJECT:-hmb-online}.pages.dev"
G='\033[32m'; R='\033[31m'; Y='\033[33m'; N='\033[0m'
ok(){ printf "  ${G}✓${N} %s\n" "$1"; }
bad(){ printf "  ${R}✗${N} %s\n" "$1"; }
warn(){ printf "  ${Y}!${N} %s\n" "$1"; }

echo "════════ HMB 배포 상태 ════════"

# 1) 도커 백엔드
for c in hmb-java hmb-runner; do
  st=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo "없음")
  hl=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$c" 2>/dev/null)
  if [ "$st" = "running" ]; then ok "$c: running ${hl:+($hl)}"; else bad "$c: $st"; fi
done

# 2) AI 실행기 (호스트 프로세스)
n=$(ps aux | grep "executor-main" | grep -v grep | grep -c "$(pwd | sed 's|/*$||')" 2>/dev/null || echo 0)
[ "${n:-0}" -ge 1 ] && ok "executor: 실행 중 ($n proc)" || warn "executor: 없음 (AI 매치 안 돌아감 — 모드 A 재기동 필요)"

# 3) 백엔드 로컬(18080) — .env 토큰으로 health
TOK=$(grep -E '^SERVANT_TOKEN=' infra/.env 2>/dev/null | cut -d= -f2)
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -H "X-Servant-Token: $TOK" http://localhost:18080/internal/health 2>/dev/null)
[ "$code" = "200" ] && ok "백엔드 로컬(18080): health 200" || bad "백엔드 로컬(18080): $code"

# 4) 터널 (cloudflared) + 현재 URL
PIDF=/tmp/hmb-cf-tunnel.pid; LOG=/tmp/hmb-cf-tunnel.log
if [ -f "$PIDF" ] && ps -p "$(cat "$PIDF")" >/dev/null 2>&1; then
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" 2>/dev/null | tail -1)
  ok "터널: 실행 중 (pid $(cat "$PIDF"))  URL=$URL"
  if [ -n "$URL" ]; then
    tcode=$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 -X POST "$URL/api/auth/login" -H 'Content-Type: application/json' -d '{"nickname":"status","provider":"guest"}' 2>/dev/null)
    [ "$tcode" = "200" ] && ok "터널 경유 백엔드: 로그인 200" || bad "터널 경유 백엔드: $tcode"
  fi
else
  bad "터널: 없음 (테스터 접속 불가 — 'bash infra/start-tunnel.sh' 로 재기동)"
fi

# 5) web (Pages)
wcode=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$PAGES/" 2>/dev/null)
[ "$wcode" = "200" ] && ok "web(Pages): $PAGES → 200" || bad "web(Pages): $PAGES → $wcode"

# 6) CORS 결선 확인 (백엔드가 허용하는 오리진 = Pages 여야 함)
cors=$(docker exec hmb-java sh -c 'echo $HMB_CORS_ALLOWEDORIGINS' 2>/dev/null)
[ "$cors" = "$PAGES" ] && ok "CORS 결선: $cors" || warn "CORS: '$cors' (Pages URL '$PAGES' 와 다름 — 왕복 막힐 수 있음)"

echo "═══════════════════════════════"
echo "테스터 접속: $PAGES"
