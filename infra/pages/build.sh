#!/usr/bin/env bash
# Cloudflare Pages 빌드 커맨드. **리포 루트에서** 실행한다.
#
#   Pages 프로젝트 설정
#     Build command     : bash infra/pages/build.sh
#     Build output dir  : apps/web/dist
#     Root directory    : (비움 = 리포 루트)
#     환경변수          : VITE_API_BASE = https://api.<your-domain>
#
# ⚠️ Root directory 를 apps/web 으로 좁히면 깨진다 — apps/web 의 prebuild(ensure-viewer.mjs)가
#    packages/engine 에서 뷰어를 생성하므로 **모노레포 전체**가 필요하다.
#
# ⚠️ VITE_API_BASE 는 **빌드 타임에 인라인**된다(vite 특성). 런타임 설정이 아니다.
#    → 백엔드 오리진이 바뀌면 **재빌드·재배포**해야 한다. quick tunnel 은 재시작마다 URL 이
#      바뀌므로 상시 운영에 부적합하다(deploy.md §5.1).

set -euo pipefail

# ⚠️ 위 "재빌드해야 한다" 는 **#183 이후 완화됐다**: VITE_API_BASE 가 있으면 런타임 config
#    (dist/config.json)도 함께 내보내고 web 은 그걸 우선한다 → 터널 URL 만 바뀐 경우는
#    `infra/publish-backend-url.sh <새URL>` 로 config.json 만 갱신하면 된다(재빌드 불필요).
#    VITE_API_BASE 는 config 를 못 읽었을 때의 폴백으로 계속 인라인된다.

# 리포 루트로 이동을 **강제**한다(주석으로만 요구하지 않는다).
# 다른 cwd 에서 실행하면 npm ci 가 워크스페이스 하위에서 재해석돼 루트 node_modules 를 pruning 하고,
# 에러는 cwd 가 아니라 TypeScript 를 가리켜 원인 파악이 어렵다(실제로 겪음).
cd "$(git rev-parse --show-toplevel 2>/dev/null || dirname "$(dirname "$(dirname "$(realpath "${BASH_SOURCE[0]}")")")")"
echo "[pages] repo root = $PWD"

echo "[pages] node=$(node -v) npm=$(npm -v)"

# 런타임 config 스위치(#183). 백엔드 오리진이 지정된 **배포 빌드에서만** 켠다 —
# dev/데모(상대경로) 빌드는 켜지 않아야 추가 네트워크 호출 0 으로 기존 동작이 유지된다.
if [ -n "${VITE_API_BASE:-}" ]; then
  export VITE_RUNTIME_CONFIG_URL="${VITE_RUNTIME_CONFIG_URL:-/config.json}"
fi

# lockfile 고정 설치(재현성). Pages 빌드 환경은 매번 새 컨테이너다.
npm ci

# prebuild(ensure-viewer) → tsc --noEmit → vite build
npm run build --workspace=@hmb/web

DIST="apps/web/dist"
test -d "$DIST" || { echo "[pages] ERROR: $DIST not found" >&2; exit 1; }

# Pages 는 _redirects/_headers 를 **출력 디렉토리 루트**에서 읽는다.
# 소스는 infra/ 가 소유하므로(apps/web 무수정 원칙) 빌드 시 복사한다.
cp infra/pages/_redirects infra/pages/_headers "$DIST/"

# Pages **Function**(#299 공유 URL OG 썸네일)은 출력 디렉토리가 아니라 **리포 루트 `functions/`**
# 에서 읽힌다 — wrangler 는 `process.cwd()/functions` 만 본다(근거·실측은 stage-functions.sh 주석).
# `_worker.js` 를 쓰지 않는 이유도 거기 적혀 있다(그건 `_headers` 를 무력화해 뷰어 iframe 을 죽인다).
bash infra/pages/stage-functions.sh "$PWD"

# 런타임 백엔드 config(#183). 워치독이 터널을 되살린 뒤 **이 파일만** 갈아끼워 재배포한다.
if [ -n "${VITE_RUNTIME_CONFIG_URL:-}" ]; then
  printf '{\n  "apiBase": "%s",\n  "updatedAt": "%s",\n  "source": "build"\n}\n' \
    "${VITE_API_BASE%/}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DIST/config.json"
  echo "[pages] config.json = ${VITE_API_BASE%/} (런타임 우선, VITE_API_BASE 는 폴백)"
fi

echo "[pages] VITE_API_BASE=${VITE_API_BASE:-<unset — 상대경로로 빌드됨>}"
echo "[pages] output:"
ls -la "$DIST"
