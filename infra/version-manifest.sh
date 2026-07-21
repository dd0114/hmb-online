#!/usr/bin/env bash
# 배포 버전 매니페스트 (#164) — 배포 직전/직후 스냅샷을 json + 사람용 로그로 남긴다.
# git SHA · engine · server-java/web/servants 버전 · 도커 이미지 태그+다이제스트 ·
# 배포시각 · 터널 종류/URL. 산출 json 은 web dist 에도 복사돼 런타임 노출(WEB_URL/version.json).
#
#   bash infra/version-manifest.sh [출력경로.json]
#
# 환경변수(있으면 매니페스트에 포함): API_URL WEB_URL TUNNEL_KIND
# 없으면 /tmp 의 터널 로그에서 자동 추출.

set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
OUT="${1:-infra/deploy-manifest.json}"

jqget() { node -e "try{console.log(require('$1').version||'')}catch(e){console.log('')}" 2>/dev/null; }
imgid()  { docker image inspect "$1" --format '{{.Id}}' 2>/dev/null || echo "unknown"; }
imgcreated(){ docker image inspect "$1" --format '{{.Created}}' 2>/dev/null || echo ""; }

GIT_SHA=$(git rev-parse HEAD 2>/dev/null || echo unknown)
GIT_SHORT=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)
GIT_DIRTY=$([ -n "$(git status --porcelain 2>/dev/null)" ] && echo true || echo false)
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# 버전들
SERVER_JAVA_VER=$(grep -E '^version' server-java/build.gradle.kts 2>/dev/null | head -1 | sed -E 's/.*"([^"]+)".*/\1/' || echo "")
WEB_VER=$(jqget "$PWD/apps/web/package.json")
SERVANTS_VER=$(jqget "$PWD/packages/server/package.json")
ENGINE_VER=$(jqget "$PWD/packages/engine/package.json")
# 엔진 런타임 버전(runner /health) — 있으면 우선
ENGINE_RT=$(curl -s --max-time 4 http://localhost:18790/health 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).engineVersion||'')}catch(e){console.log('')}})" 2>/dev/null || echo "")

# 도커 이미지
JAVA_IMG=$(imgid hmb/server-java:p3); SERVANTS_IMG=$(imgid hmb/servants:p3)

# 터널
API_URL="${API_URL:-$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/hmb-cf-tunnel.log 2>/dev/null | tail -1 || true)}"
WEB_URL="${WEB_URL:-$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/hmb-web-tunnel.log 2>/dev/null | tail -1 || true)}"
TUNNEL_KIND="${TUNNEL_KIND:-cloudflare-quick}"

node -e '
const m={
  deployedAt: process.env.TS,
  git: { sha: process.env.GIT_SHA, short: process.env.GIT_SHORT, branch: process.env.GIT_BRANCH, dirty: process.env.GIT_DIRTY==="true" },
  versions: {
    engine: process.env.ENGINE_RT || process.env.ENGINE_VER,
    enginePackage: process.env.ENGINE_VER,
    serverJava: process.env.SERVER_JAVA_VER,
    web: process.env.WEB_VER,
    servants: process.env.SERVANTS_VER,
  },
  images: {
    "hmb/server-java:p3": process.env.JAVA_IMG,
    "hmb/servants:p3": process.env.SERVANTS_IMG,
  },
  tunnel: { kind: process.env.TUNNEL_KIND, apiUrl: process.env.API_URL||null, webUrl: process.env.WEB_URL||null },
};
const fs=require("fs");
fs.writeFileSync(process.env.OUT, JSON.stringify(m,null,2));
console.log(JSON.stringify(m,null,2));
' 2>/dev/null

# web dist 있으면 런타임 노출용으로 복사 (WEB_URL/version.json)
if [ -d apps/web/dist ]; then cp "$OUT" apps/web/dist/version.json && echo "[manifest] → apps/web/dist/version.json (런타임 노출)"; fi
echo "[manifest] → $OUT"
