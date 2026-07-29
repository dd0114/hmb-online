#!/usr/bin/env bash
# 배포 배선 계약 (#299) — **Function 이 어디서 읽히는가**를 추측이 아니라 실행으로 박제한다.
#
#   bash infra/pages/e2e/deploy-wiring.e2e.sh
#
# 여기서 재는 것 3가지:
#   W1  `functions/` 는 **wrangler 를 실행한 cwd 아래**에서만 읽힌다.
#       → 배포 산출물(dist) 안에 넣어 두면 **읽히지 않는다**(대조군으로 직접 확인).
#   W2  `infra/pages/build.sh` 가 그 자리에 배치한다(stage-functions.sh).
#   W3  #183 워치독(`publish-backend-url.sh`)이 재배포할 때도 Function 이 따라간다.
#       → 스냅샷이 없으면 워치독 재배포가 사이트에서 Function 을 **지운다**. 그 회귀를 여기서 막는다.
#
# 배포하지 않는다(W3 는 DRYRUN).

set -uo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

PORT="${HMB_E2E_PORT:-18879}"
WORK="${HMB_E2E_WORK:-/tmp/hmb-og-wiring}"
OUT="${HMB_E2E_OUT:-$WORK/logs}"
LIVE_ID="01J5LIVE0000000000000000AB"
mkdir -p "$OUT"

PASS=0; FAIL=0
ok(){  PASS=$((PASS+1)); printf 'PASS  %s\n' "$*"; }
bad(){ FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$*"; }
check(){ if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }

PIDS=()
cleanup(){ for p in "${PIDS[@]:-}"; do [ -n "${p:-}" ] && kill -9 "$p" 2>/dev/null; done; return 0; }
trap cleanup EXIT

[ -f apps/web/dist/index.html ] || { echo "ERROR: apps/web/dist 없음 — 먼저 빌드" >&2; exit 2; }

# ── W1 대조군: functions 를 **dist 안**에 넣고, cwd 에는 두지 않는다 ─────────────
rm -rf "$WORK/dist" "$WORK/cwd"; mkdir -p "$WORK/dist" "$WORK/cwd"
rsync -a apps/web/dist/ "$WORK/dist/"
mkdir -p "$WORK/dist/functions"
rsync -a infra/pages/functions/ "$WORK/dist/functions/"
printf '{"apiBase":"http://127.0.0.1:1"}\n' > "$WORK/dist/config.json"

WRANGLER="${HMB_WRANGLER:-$(command -v wrangler)}"
# 서브셸로 감싸지 않는다 — 그러면 $! 가 서브셸 PID 라 wrangler 본체가 고아로 남는다.
cd "$WORK/cwd"
"$WRANGLER" pages dev "$WORK/dist" --ip 127.0.0.1 --port "$PORT" \
  --compatibility-date=2025-01-01 --log-level=warn --show-interactive-dev-session=false \
  > "$OUT/W1-wrangler.log" 2>&1 &
W1_PID=$!; PIDS+=("$W1_PID")
cd "$ROOT"
for _ in $(seq 1 60); do curl -s -o /dev/null --max-time 5 "http://127.0.0.1:$PORT/index.html" && break; sleep 1; done
# ⚠️ 기동 실패를 "og 태그 없음"으로 읽으면 **빈 응답이 W1 을 통과시킨다**(실제로 포트 충돌로 겪음).
if ! curl -s -o /dev/null --max-time 5 "http://127.0.0.1:$PORT/index.html"; then
  echo "ERROR: W1 wrangler pages dev 기동 실패 — $OUT/W1-wrangler.log" >&2
  tail -10 "$OUT/W1-wrangler.log" >&2
  exit 3
fi
curl -s --max-time 15 -A 'facebookexternalhit/1.1' "http://127.0.0.1:$PORT/share/notice/$LIVE_ID" > "$OUT/W1-dist-functions.html"
kill "$W1_PID" 2>/dev/null

check "W1 dist 안의 functions/ 는 라우트로 잡히지 않는다(= cwd 기준이 맞다)" \
  "! grep -q 'og:title' '$OUT/W1-dist-functions.html'"
check "W1 그때도 셸 자체는 정상(200 SPA)" \
  "grep -q '<div id=\"root\"></div>' '$OUT/W1-dist-functions.html'"

# ── W2 build.sh 의 배치 단계 ─────────────────────────────────────────────────────
rm -rf "$ROOT/functions"
grep -q 'stage-functions.sh' infra/pages/build.sh \
  && ok "W2 build.sh 가 stage-functions.sh 를 부른다" || bad "W2 build.sh 가 배치 단계를 부르지 않는다"
bash infra/pages/stage-functions.sh "$ROOT" > "$OUT/W2-stage.log" 2>&1
check "W2 배치 결과가 리포 루트 functions/ 에 있다" "[ -f '$ROOT/functions/share/notice/[id].js' ]"
check "W2 리포 루트 functions/ 는 커밋되지 않는다(.gitignore)" \
  "git check-ignore -q '$ROOT/functions/share/notice/[id].js'"

# ── W3 워치독 재배포가 Function 을 지우지 않는다 ────────────────────────────────
FAKE_CACHE="$WORK/cache/dist-current"
rm -rf "$WORK/cache"; mkdir -p "$FAKE_CACHE"
rsync -a apps/web/dist/ "$FAKE_CACHE/"
FAKE_WORKDIR="$WORK/wrangler-work"; rm -rf "$FAKE_WORKDIR"

# (a) 스냅샷이 있으면 워치독 작업 디렉토리에 실린다
mkdir -p "$FAKE_CACHE.functions"
rsync -a "$ROOT/functions/" "$FAKE_CACHE.functions/"
HMB_PUBLISH_DRYRUN=1 HMB_DIST_CACHE="$FAKE_CACHE" HMB_WORK_DIR="$FAKE_WORKDIR" \
  HMB_STATE_DIR="$WORK/state" CLOUDFLARE_API_TOKEN=x CLOUDFLARE_ACCOUNT_ID=x \
  bash infra/publish-backend-url.sh https://example.invalid > "$OUT/W3-with-snapshot.log" 2>&1
check "W3 워치독 cwd 에 Function 이 실린다" \
  "[ -f '$FAKE_WORKDIR/functions/share/notice/[id].js' ]"

# (b) 스냅샷이 없으면 **경고를 남긴다**(조용히 지우지 않는다)
rm -rf "$FAKE_CACHE.functions" "$FAKE_WORKDIR"
HMB_PUBLISH_DRYRUN=1 HMB_DIST_CACHE="$FAKE_CACHE" HMB_WORK_DIR="$FAKE_WORKDIR" \
  HMB_STATE_DIR="$WORK/state" CLOUDFLARE_API_TOKEN=x CLOUDFLARE_ACCOUNT_ID=x \
  bash infra/publish-backend-url.sh https://example.invalid > "$OUT/W3-no-snapshot.log" 2>&1
check "W3 스냅샷이 없으면 경고를 남기고 계속한다(접속 복구 우선)" \
  "grep -q 'functions 스냅샷 없음' '$OUT/W3-no-snapshot.log'"
check "W3 deploy-pages.sh 가 스냅샷을 남긴다" "grep -q 'CACHE.functions' infra/deploy-pages.sh"
check "W3 deploy-web.sh 가 스냅샷을 남긴다" "grep -q 'CACHE.functions' infra/deploy-web.sh"

echo ""
echo "════════ 배선 결과: PASS=$PASS FAIL=$FAIL  (로그: $OUT) ════════"
[ "$FAIL" -eq 0 ]
