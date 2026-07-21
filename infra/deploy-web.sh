#!/usr/bin/env bash
# web 을 지정한 백엔드 URL 로 빌드해 Cloudflare Pages 에 배포한다.
#
#   bash infra/deploy-web.sh https://xxx.trycloudflare.com
#
# quick tunnel URL 이 바뀔 때마다 이 한 줄이면 web 이 새 백엔드를 가리키게 재배포된다
# (VITE_API_BASE 는 빌드타임 인라인이라 재빌드 필요 — deploy.md §6.1).
# WEB_ORIGINS(백엔드 CORS)는 Pages URL(고정)이라 바뀌지 않는다 → java 재시작 불필요.

set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

BACKEND="${1:?백엔드 URL 필요 (예: https://xxx.trycloudflare.com)}"
PROJECT="${PAGES_PROJECT:-hmb-online}"

echo "[deploy-web] backend = $BACKEND"
rm -rf apps/web/dist
VITE_API_BASE="$BACKEND" bash infra/pages/build.sh

echo "[deploy-web] Pages 배포 ($PROJECT)..."
npx -y wrangler pages deploy apps/web/dist --project-name="$PROJECT" --branch=main --commit-dirty=true

echo "[deploy-web] 완료 — web=https://$PROJECT.pages.dev  →  backend=$BACKEND"
