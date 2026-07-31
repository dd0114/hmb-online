#!/usr/bin/env bash
# 로그인 없는 순수 quick-tunnel 배포 — 매니저/아무 세션이 재현 가능.
# web(Pages/wrangler 로그인) 없이, 백엔드+web 둘 다 cloudflared quick tunnel 로 노출한다.
#
#   bash infra/deploy-quicktunnel.sh
#
# 산출: 테스터 접속 URL(WEB_URL). ⚠️ quick tunnel URL 은 재시작 시 바뀐다 → 재실행하면 갱신.
# ⚠️ DB(hmb-p3-db 볼륨)는 절대 안 건드린다 — 테스터 데이터 유지(이 스크립트에 down -v 없음).
#
# 전제: 백엔드 도커(java 18080, runner 18790)가 이미 떠 있어야 한다.
#   cd infra && docker compose up -d java runner   (+ AI 실행기 모드 A — deploy-playbook §2)

set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
WEB_PORT="${WEB_PORT:-4321}"

start_tunnel() { # $1=port $2=logfile $3=pidfile → echoes URL
  local port="$1" log="$2" pidf="$3"
  [ -f "$pidf" ] && ps -p "$(cat "$pidf")" >/dev/null 2>&1 && { kill "$(cat "$pidf")" 2>/dev/null || true; sleep 1; }
  nohup cloudflared tunnel --url "http://localhost:$port" --no-autoupdate --protocol "${HMB_TUNNEL_PROTOCOL:-http2}" > "$log" 2>&1 &
  echo $! > "$pidf"
  local u=""
  for _ in $(seq 1 30); do u=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" | head -1 || true); [ -n "$u" ] && break; sleep 2; done
  [ -z "$u" ] && { echo "[deploy-qt] $port 터널 URL 실패 — $log" >&2; return 1; }
  echo "$u"
}

echo "[deploy-qt] 1) 백엔드 터널 (→18080)"
API_URL=$(start_tunnel 18080 /tmp/hmb-cf-tunnel.log /tmp/hmb-cf-tunnel.pid)
echo "[deploy-qt]    API_URL = $API_URL"

echo "[deploy-qt] 2) web 빌드 (VITE_API_BASE=API_URL)"
rm -rf apps/web/dist
VITE_API_BASE="$API_URL" bash infra/pages/build.sh >/dev/null

echo "[deploy-qt] 3) web 정적 서버 (:$WEB_PORT)"
[ -f /tmp/hmb-web-serve.pid ] && ps -p "$(cat /tmp/hmb-web-serve.pid)" >/dev/null 2>&1 && { kill "$(cat /tmp/hmb-web-serve.pid)" 2>/dev/null || true; sleep 1; }
nohup node infra/serve-web.mjs "$WEB_PORT" apps/web/dist > /tmp/hmb-web-serve.log 2>&1 &
echo $! > /tmp/hmb-web-serve.pid
sleep 2

echo "[deploy-qt] 4) web 터널 (→$WEB_PORT)"
WEB_URL=$(start_tunnel "$WEB_PORT" /tmp/hmb-web-tunnel.log /tmp/hmb-web-tunnel.pid)
echo "[deploy-qt]    WEB_URL = $WEB_URL"

echo "[deploy-qt] 5) CORS = WEB_URL, java 재시작 (⭕ DB 볼륨 유지 — down 아님)"
cd infra && sed -i '' "s|^WEB_ORIGINS=.*|WEB_ORIGINS=${WEB_URL}|" .env
docker compose up -d --force-recreate java >/dev/null   # --force-recreate: env 변경 확실히 반영
until [ "$(docker inspect -f '{{.State.Health.Status}}' hmb-java 2>/dev/null)" = healthy ]; do sleep 3; done
cd ..

echo "[deploy-qt] 6) 버전 매니페스트 (#164) — 배포 스냅샷 json+로그, dist/version.json 노출"
API_URL="$API_URL" WEB_URL="$WEB_URL" TUNNEL_KIND=cloudflare-quick \
  bash infra/version-manifest.sh infra/deploy-manifest.json >/dev/null
# version.json 을 dist 에 넣었으니 web 서버 재시작으로 확실히 반영(정적서버는 fs 매요청이라 사실 즉시 반영됨)

echo ""
echo "════════════════════════════════════════════"
echo " 테스터 접속 URL : $WEB_URL"
echo " 버전 확인       : $WEB_URL/version.json  (또는 infra/deploy-manifest.json)"
echo " (백엔드 API     : $API_URL)"
echo "════════════════════════════════════════════"
echo " ⚠️ quick tunnel URL 은 재시작 시 바뀜 → 이 스크립트 재실행하면 갱신"
echo " ⚠️ DB 는 hmb-p3-db 볼륨에 보존 — 재배포/재기동해도 테스터 데이터 유지"
echo " 상태확인: bash infra/status.sh   (단, WEB_URL 은 tester-facing 이라 로컬 DNS 캐시 주의)"
