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
STATE_DIR="${HMB_STATE_DIR:-$HOME/.local/state/hmb}"
LOCK="$STATE_DIR/deploy.lock"
CACHE="${HMB_DIST_CACHE:-$HOME/.cache/hmb/dist-current}"

# 자가복구 워치독(#183)이 같은 순간에 config 를 재배포하면 서로의 배포를 덮어쓴다 → 락으로 직렬화.
mkdir -p "$STATE_DIR"
for _ in $(seq 1 60); do
  mkdir "$LOCK" 2>/dev/null && { echo $$ > "$LOCK/pid"; LOCKED=1; break; }
  owner=$(cat "$LOCK/pid" 2>/dev/null || echo "")
  [ -n "$owner" ] && ! ps -p "$owner" >/dev/null 2>&1 && rm -rf "$LOCK" && continue
  echo "[deploy-web] 워치독/다른 배포가 진행 중 — 대기(pid ${owner:-?})"; sleep 3
done
trap '[ "${LOCKED:-0}" = 1 ] && rm -rf "$LOCK"' EXIT

echo "[deploy-web] backend = $BACKEND"
rm -rf apps/web/dist
VITE_API_BASE="$BACKEND" bash infra/pages/build.sh

echo "[deploy-web] Pages 배포 ($PROJECT)..."
npx -y wrangler pages deploy apps/web/dist --project-name="$PROJECT" --branch=main --commit-dirty=true

# 배포 성공분을 **머신 전역** 캐시에 보존한다(#183). 워치독이 터널 URL 만 바뀐 경우
# 이 스냅샷의 config.json 만 고쳐 재배포하므로, 여기 없으면 자가복구가 전파 단계에서 멈춘다.
# (리포 안에 두면 워크트리마다 달라져 엉뚱한 dist 를 배포할 수 있다 — 그래서 리포 밖.)
mkdir -p "$CACHE"
rsync -a --delete apps/web/dist/ "$CACHE/"
printf 'deployedAt=%s\nbackend=%s\ngit=%s\nfrom=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$BACKEND" "$(git rev-parse --short HEAD 2>/dev/null || echo ?)" "$PWD" \
  > "$CACHE.meta"
echo "[deploy-web] dist 스냅샷 보존 → $CACHE"

echo "[deploy-web] 완료 — web=https://$PROJECT.pages.dev  →  backend=$BACKEND"
