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
# HMB_BUILD_CMD = 계약 하네스(infra/tests/deploy-web-manifest.test.sh)의 주입 이음매.
# 실빌드(npm ci)는 워크트리 node_modules 를 통째로 재설치하므로 테스트에서 돌릴 수 없다.
# 기본값은 종전 경로 그대로다.
VITE_API_BASE="$BACKEND" ${HMB_BUILD_CMD:-bash infra/pages/build.sh}

# 버전 매니페스트 (#506) — 이 단계가 deploy-pages.sh 에만 있어서, 장애 복구 경로(start-tunnel.sh
# → 여기)로 재배포할 때마다 version.json 이 배포물에서 빠졌다. 그런데 엣지가 s-maxage 7일 캐시로
# 두 세대 전 매니페스트를 200 으로 계속 줘(실측 age 3.7일, cf-cache HIT) 실패가 404 가 아니라
# **그럴듯한 오답**이 됐다 — 버전 식별이 가장 필요한 복구 순간에 가장 낡은 답을 준다.
# deploy-pages.sh 42-44행과 같은 스텝(같은 스크립트·같은 env 계약)이다. `|| true` 도 같은 이유 —
# 매니페스트는 관측용이라 그것 때문에 배포가 죽으면 안 된다.
echo "[deploy-web] 버전 매니페스트 (dist/version.json)"
# 실패해도 배포는 계속한다(가용성 우선, deploy-pages.sh 와 동일) — 단 ① 조용히 넘기지 않고
# 경고를 남기고 ② _headers 의 /version.json no-store 덕에 그 회차의 부재는 스테일 200 이 아니라
# **404 로 정직하게** 나타난다(#506 의 해악은 부재가 아니라 그럴듯한 오답이었다).
# HMB_MANIFEST_CMD = 계약 하네스의 실패 주입 이음매(기본값 = 실제 스크립트).
if ! API_URL="$BACKEND" WEB_URL="https://${PROJECT}.pages.dev" TUNNEL_KIND="cloudflare-quick(backend)+pages(web)" \
     ${HMB_MANIFEST_CMD:-bash infra/version-manifest.sh} infra/deploy-manifest.json >/dev/null; then
  echo "[deploy-web] ⚠ 버전 매니페스트 실패 — version.json 없이 배포한다(엣지는 no-store 라 404 로 보인다)" >&2
fi

echo "[deploy-web] Pages 배포 ($PROJECT)..."
npx -y wrangler pages deploy apps/web/dist --project-name="$PROJECT" --branch=main --commit-dirty=true

# 배포 성공분을 **머신 전역** 캐시에 보존한다(#183). 워치독이 터널 URL 만 바뀐 경우
# 이 스냅샷의 config.json 만 고쳐 재배포하므로, 여기 없으면 자가복구가 전파 단계에서 멈춘다.
# (리포 안에 두면 워크트리마다 달라져 엉뚱한 dist 를 배포할 수 있다 — 그래서 리포 밖.)
mkdir -p "$CACHE"
rsync -a --delete apps/web/dist/ "$CACHE/"
# Pages Function(#299)도 같이 보존한다 — dist 에 들어 있지 않고 **cwd 아래 functions/** 에서
# 읽히기 때문에, 이게 없으면 워치독 재배포가 OG Function 을 **삭제**한다(미리보기가 조용히 죽는다).
mkdir -p "$CACHE.functions"
rsync -a --delete functions/ "$CACHE.functions/"
printf 'deployedAt=%s\nbackend=%s\ngit=%s\nfrom=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$BACKEND" "$(git rev-parse --short HEAD 2>/dev/null || echo ?)" "$PWD" \
  > "$CACHE.meta"
echo "[deploy-web] dist 스냅샷 보존 → $CACHE (+ functions → $CACHE.functions)"

echo "[deploy-web] 완료 — web=https://$PROJECT.pages.dev  →  backend=$BACKEND"
