#!/usr/bin/env bash
# Pages Function 소스를 **wrangler 가 실제로 읽는 자리**에 배치한다 (#299).
#
#   bash infra/pages/stage-functions.sh [대상디렉토리]      # 기본 = 리포 루트
#
# ── 왜 복사하나 (추측이 아니라 wrangler 4.86.0 소스로 확인한 사실) ────────────────────
#   wrangler-dist/cli.js:  functionsDirectory = customFunctionsDirectory || path.join(process.cwd(), "functions")
#   그리고 `pages deploy` 는 customFunctionsDirectory 를 **넘기지 않는다**(호출부 확인).
#   `pages dev` 도 같다: functionsDirectory = "./functions".
#   ⇒ Function 디렉토리는 **wrangler 를 실행한 cwd 바로 아래 `functions/`** 여야 한다.
#      `--functions-directory` 같은 플래그는 `pages deploy|dev` 에 없다(`--help` 확인).
#
#   배포는 리포 루트에서 `wrangler pages deploy apps/web/dist` 를 돈다(infra/deploy-pages.sh).
#   따라서 배치 위치 = **리포 루트 `functions/`**. 소스를 그리로 옮기지 않고 여기서 복사하는 것은
#   `_headers`·`_redirects`·`config.json` 과 같은 원칙이다 — 배포 산출물의 조립은 build.sh 한 곳에서만
#   일어나고, 소스는 전부 `infra/pages/` 아래 모여 있어야 계약(주석)과 함께 읽힌다.
#
# ⚠️ 리포 루트 `functions/` 는 **생성물**이다(.gitignore). 거기서 직접 고치지 마라 — 다음 빌드가 덮는다.
#    SoT 는 `infra/pages/functions/`.

set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/functions"
DEST_ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
DEST="$DEST_ROOT/functions"

[ -d "$SRC_DIR" ] || { echo "[stage-functions] ERROR: $SRC_DIR 없음" >&2; exit 1; }

mkdir -p "$DEST"
# --delete: 지워진 Function 이 유령으로 남아 라우트를 잡는 것을 막는다.
rsync -a --delete "$SRC_DIR/" "$DEST/"
echo "[stage-functions] $SRC_DIR → $DEST"
find "$DEST" -type f | sed "s|^$DEST_ROOT/||" | sed 's/^/[stage-functions]   /'
