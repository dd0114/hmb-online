#!/usr/bin/env bash
# 현재 백엔드(터널) 주소를 **재빌드 없이** 배포된 web 에 알린다 — 에픽 #183 접근 A.
#
#   bash infra/publish-backend-url.sh https://xxx.trycloudflare.com
#
# 하는 일: 마지막으로 배포된 dist 스냅샷(머신 전역 캐시)의 `config.json` 만 새 주소로 고쳐
#          Pages 에 재업로드하고, Pages 가 실제로 그 주소를 서빙하는지 검증한다.
#          web 은 부팅 시 이 파일을 읽으므로(apps/web/src/api/client.ts) 재빌드가 필요 없다.
#
# ⚠️ Pages 배포는 **디렉토리 통째 교체**다. 그래서 "마지막에 배포한 dist" 를 그대로 보존해 둔
#    캐시에서만 올린다 — 아무 dist 나 올리면 web 코드가 조용히 롤백된다. 캐시는 워크트리
#    (spider9/10/14…)마다 다르면 안 되므로 리포 밖 **머신 전역**(~/.cache/hmb/dist-current)에 둔다.
#    캐시는 deploy-web.sh / deploy-pages.sh 가 배포 성공 직후에 갱신한다.
#
# 이 스크립트는 **리포에 의존하지 않는다**(launchd 워치독이 부른다) — 절대경로만 쓴다.

set -euo pipefail

PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
export PATH

BACKEND="${1:?백엔드 URL 필요 (예: https://xxx.trycloudflare.com)}"
BACKEND="${BACKEND%/}"

CACHE="${HMB_DIST_CACHE:-$HOME/.cache/hmb/dist-current}"
PROJECT="${PAGES_PROJECT:-hmb-online}"
PAGES_URL="https://${PROJECT}.pages.dev"
STATE_DIR="${HMB_STATE_DIR:-$HOME/.local/state/hmb}"
LOCK="$STATE_DIR/deploy.lock"

mkdir -p "$STATE_DIR"

log(){ printf '[publish] %s\n' "$*"; }

# ── 락 (워치독의 치유와 사람의 수동 배포가 겹치면 서로의 배포를 덮어쓴다) ────────────
# 이미 상위(워치독)가 락을 잡고 있으면 재획득하지 않는다 — 자기 자신과 데드락 금지.
LOCK_OWNED=0
acquire_lock(){
  [ "${HMB_LOCK_HELD:-0}" = "1" ] && return 0
  local waited=0
  while ! mkdir "$LOCK" 2>/dev/null; do
    local owner; owner=$(cat "$LOCK/pid" 2>/dev/null || echo "")
    if [ -n "$owner" ] && ! ps -p "$owner" >/dev/null 2>&1; then
      log "죽은 락 정리 (pid $owner)"; rm -rf "$LOCK"; continue
    fi
    [ "$waited" -ge "${HMB_LOCK_WAIT:-180}" ] && { log "락 대기 초과 (pid ${owner:-?}) — 중단"; exit 3; }
    sleep 3; waited=$((waited + 3))
  done
  echo $$ > "$LOCK/pid"; LOCK_OWNED=1
}
release_lock(){ [ "$LOCK_OWNED" = "1" ] && rm -rf "$LOCK"; return 0; }
trap release_lock EXIT

# ── 토큰 (리포 밖 전역 우선, 리포가 있으면 override) ────────────────────────────────
set -a
[ -f "$HOME/.config/hmb/deploy.env" ] && . "$HOME/.config/hmb/deploy.env"
[ -n "${HMB_REPO:-}" ] && [ -f "$HMB_REPO/infra/.env" ] && . "$HMB_REPO/infra/.env"
set +a
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN 필요 — ~/.config/hmb/deploy.env}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID 필요 — ~/.config/hmb/deploy.env}"
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID

acquire_lock

# ── 1) 캐시 유효성 (여기서 막지 않으면 빈 사이트를 배포하게 된다) ───────────────────
if [ ! -f "$CACHE/index.html" ]; then
  cat >&2 <<EOF
[publish] ✗ dist 캐시가 없다: $CACHE
          web 을 한 번 정상 배포해 캐시를 만들어야 한다:
            bash infra/deploy-web.sh $BACKEND
EOF
  exit 2
fi
if ! ls "$CACHE"/assets/*.js >/dev/null 2>&1; then
  echo "[publish] ✗ 캐시가 온전치 않다(assets 없음): $CACHE — 정상 배포로 재생성 필요" >&2
  exit 2
fi

# ── 2) config.json 만 교체 ─────────────────────────────────────────────────────────
PREV=$(sed -n 's/.*"apiBase" *: *"\([^"]*\)".*/\1/p' "$CACHE/config.json" 2>/dev/null | head -1)
printf '{\n  "apiBase": "%s",\n  "updatedAt": "%s",\n  "source": "%s"\n}\n' \
  "$BACKEND" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${HMB_PUBLISH_SOURCE:-manual}" > "$CACHE/config.json"
log "config.json: ${PREV:-<없음>} → $BACKEND"

# ── 3) Pages 재업로드 (빌드 없음 — 바뀐 파일만 올라간다) ────────────────────────────
# ⚠️ wrangler 는 **cwd 아래에 .wrangler/tmp 를 만든다**. launchd 는 cwd 가 `/` 라서 그대로 두면
#    `Missing file or directory: /.wrangler/tmp` 로 매번 실패한다(실측 — 워치독 1차 실행에서 3연속
#    실패했다). 그래서 쓰기 가능한 작업 디렉토리로 옮기고 나서 실행한다.
# 작업 디렉토리는 **$HOME 밖**에 둔다: wrangler 는 cwd 에서 위로 올라가며 설정을 찾다가 $HOME 의
# 보호 디렉토리(.Trash 등)를 건드린다(실측 경고). launchd 컨텍스트에선 그 접근이 TCC 에 막혀
# 조용히 매달릴 수 있다 — 애초에 건드릴 게 없는 곳에서 돌린다.
WORKDIR="${HMB_WORK_DIR:-/tmp/hmb-wrangler-work}"
mkdir -p "$WORKDIR"
cd "$WORKDIR"
export WRANGLER_SEND_METRICS=false   # 원격 메트릭 POST 를 임계 경로에서 제거(행 지점 직전에 찍힘)

# `npx -y wrangler` 는 매 실행마다 레지스트리를 확인해 **수 분** 걸릴 수 있다(실측 ~4분:
# 자가복구 MTTR 을 통째로 잡아먹는다). 설치된 바이너리가 있으면 그걸 쓴다.
WRANGLER="${HMB_WRANGLER:-$(command -v wrangler 2>/dev/null || true)}"
log "wrangler pages deploy $CACHE  (${WRANGLER:-npx -y wrangler})"

# ⏱ 반드시 상한을 건다. 실측: launchd 컨텍스트에서 wrangler 가 첫 CF API 요청에 **6분 넘게 매달렸다**
#    (같은 명령이 셸에선 2초). 상한이 없으면 워치독 한 틱이 영원히 안 끝나 자가복구가 통째로 멈춘다.
#    실패로 처리하면 다음 틱이 다시 시도하고, 시도 상한이 무한 반복을 막는다.
TIMEOUT_BIN=$(command -v timeout || command -v gtimeout || true)
run_deploy(){
  if [ -n "$WRANGLER" ]; then set -- "$WRANGLER"; else set -- npx -y wrangler; fi
  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" -k 10 "${HMB_DEPLOY_TIMEOUT:-150}" "$@" pages deploy "$CACHE" \
      --project-name="$PROJECT" --branch=main --commit-dirty=true >/dev/null
  else
    "$@" pages deploy "$CACHE" --project-name="$PROJECT" --branch=main --commit-dirty=true >/dev/null
  fi
}
if ! run_deploy; then
  rc=$?
  [ "$rc" = 124 ] && echo "[publish] ✗ wrangler 시간초과(${HMB_DEPLOY_TIMEOUT:-150}s) — 다음 틱에서 재시도된다" >&2
  exit "$rc"
fi

# ── 4) 검증 — Pages 가 실제로 새 주소를 서빙하는가 (전파에 몇 초 걸린다) ────────────
for i in $(seq 1 10); do
  SERVED=$(curl -fsS -m 10 -H 'Cache-Control: no-cache' "$PAGES_URL/config.json?t=$(date +%s)-$i" 2>/dev/null \
           | sed -n 's/.*"apiBase" *: *"\([^"]*\)".*/\1/p' | head -1)
  [ "$SERVED" = "$BACKEND" ] && { log "✓ 검증: $PAGES_URL/config.json → $SERVED"; exit 0; }
  sleep 3
done

echo "[publish] ✗ 검증 실패 — Pages 가 서빙하는 apiBase='${SERVED:-<응답없음>}' (기대 '$BACKEND')" >&2
exit 1
