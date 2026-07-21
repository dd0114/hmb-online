#!/usr/bin/env bash
# Cloudflare Pages 배포 — **로그인 없이 API 토큰**으로. (wrangler 가 env 토큰 사용)
#
#   bash infra/deploy-pages.sh [백엔드_quick_tunnel_URL]
#
# 전제: infra/.env 에 CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (gitignore, 절대 커밋 금지).
# 백엔드 URL 생략 시 실행 중인 quick tunnel 로그에서 자동 추출.
#
# 하는 일: web 을 VITE_API_BASE=<백엔드URL> 로 빌드 → wrangler pages deploy(토큰) →
#          백엔드 CORS 에 https://<project>.pages.dev 추가·java 재시작(⭕ DB 볼륨 유지) →
#          버전 매니페스트.
#
# ⚠️ 백엔드 quick tunnel URL 이 재시작으로 바뀌면 web 을 **재빌드+재배포**해야 한다(VITE_API_BASE
#    는 빌드타임 인라인). 이 스크립트를 새 URL 로 다시 실행하면 된다. Pages URL(pages.dev)은 고정.

set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

# .env 에서 토큰/계정ID 로드 (export)
set -a; [ -f infra/.env ] && . infra/.env; set +a
: "${CLOUDFLARE_API_TOKEN:?infra/.env 에 CLOUDFLARE_API_TOKEN 필요 (커밋 금지)}"
: "${CLOUDFLARE_ACCOUNT_ID:?infra/.env 에 CLOUDFLARE_ACCOUNT_ID 필요}"
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID

PROJECT="${PAGES_PROJECT:-hmb-online}"
PAGES_URL="https://${PROJECT}.pages.dev"
BACKEND="${1:-$(grep -hoE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/hmb-cf-tunnel.log /tmp/cf2.log 2>/dev/null | tail -1 || true)}"
: "${BACKEND:?백엔드 quick tunnel URL 필요 (인자 or 실행 중 터널 로그)}"

echo "[pages] backend=$BACKEND  project=$PROJECT"

echo "[pages] 1) web 빌드 (VITE_API_BASE=$BACKEND)"
rm -rf apps/web/dist
VITE_API_BASE="$BACKEND" bash infra/pages/build.sh

echo "[pages] 2) 버전 매니페스트 (dist/version.json)"
API_URL="$BACKEND" WEB_URL="$PAGES_URL" TUNNEL_KIND="cloudflare-quick(backend)+pages(web)" \
  bash infra/version-manifest.sh infra/deploy-manifest.json >/dev/null || true

echo "[pages] 3) wrangler pages deploy (토큰 인증, 로그인 없음)"
npx -y wrangler pages deploy apps/web/dist --project-name="$PROJECT" --branch=main --commit-dirty=true

echo "[pages] 4) 백엔드 CORS 에 $PAGES_URL 추가·재결선 (⭕ DB 유지 — down 아님)"
CUR=$(grep -E '^WEB_ORIGINS=' infra/.env | cut -d= -f2-)
case ",$CUR," in
  *",$PAGES_URL,"*) NEW="$CUR";;                       # 이미 있음
  ""|",,") NEW="$PAGES_URL";;
  *) NEW="$CUR,$PAGES_URL";;                            # 콤마 추가(기존 quick-tunnel 오리진 유지)
esac
# --force-recreate: `up -d` 만으론 env 변경(WEB_ORIGINS)이 실행 컨테이너에 반영 안 될 때가 있다(실측).
( cd infra && sed -i '' "s|^WEB_ORIGINS=.*|WEB_ORIGINS=$NEW|" .env && docker compose up -d --force-recreate java >/dev/null )
until [ "$(docker inspect -f '{{.State.Health.Status}}' hmb-java 2>/dev/null)" = healthy ]; do sleep 3; done
echo "[pages]    WEB_ORIGINS=$NEW"

echo ""
echo "════════════════════════════════════════════"
echo " 테스터 접속 URL : $PAGES_URL   (고정)"
echo " 백엔드 API      : $BACKEND   (quick tunnel — 재시작 시 바뀜 → 재실행 필요)"
echo " 버전 확인       : $PAGES_URL/version.json"
echo "════════════════════════════════════════════"
