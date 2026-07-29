#!/usr/bin/env bash
# 공유 URL OG 썸네일 — **로컬 E2E 계약** (#299, 에픽 #293).
#
#   bash infra/pages/e2e/og-function.e2e.sh
#
# 진짜 `wrangler pages dev` 를 띄워(= 배포와 같은 workerd 런타임·같은 `functions/` 해석 규칙)
# curl 로 계약을 잰다. 배포하지 않는다.
#
# ── 이 파일이 지키는 계약 ────────────────────────────────────────────────────────
#   AC1  크롤러 UA → `<head>` 에 og:title·og:description·og:image(절대 URL)·og:url·twitter:card
#   AC2  `/notice/hero-kyeongnicius.webp` 가 계속 200 image/webp (Function 이 삼키지 않는다)
#   AC3  백엔드 URL 을 굽지 않는다 — `/config.json` 을 **요청 시각에** 읽는다(런타임에 바꿔 확인)
#   AC4  사람 UA 도 같은 SPA 셸을 받는다(브라우저 실검증은 ac4-browser.mjs)
#
# ── 변이체 스위치(계약이 실제로 죽는지 확인용) ──────────────────────────────────
#   HMB_E2E_STAGE=0            functions 배치를 건너뛴다 → AC1 이 죽어야 한다(red 기준선)
#   HMB_E2E_MUTANT=notice      `functions/notice/[id].js` 를 추가 → **AC2 가 죽어야 한다**
#   HMB_E2E_MUTANT=bake        apiBase 를 구운 Function 으로 교체 → AC3 이 죽어야 한다
#   HMB_E2E_PROTOCOL=https     TLS 로 띄운다(og:image 가 https:// 로 시작하는지 실측)
#   HMB_E2E_OUT=<dir>          로그 출력 디렉토리

set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

PORT="${HMB_E2E_PORT:-18877}"
STUB_A_PORT="${HMB_E2E_STUB_A:-18991}"
STUB_B_PORT="${HMB_E2E_STUB_B:-18992}"
PROTO="${HMB_E2E_PROTOCOL:-http}"
WORK="${HMB_E2E_WORK:-/tmp/hmb-og-e2e}"
OUT="${HMB_E2E_OUT:-$WORK/logs}"
BASE="$PROTO://127.0.0.1:$PORT"
CURL=(curl -s --max-time 20)
[ "$PROTO" = "https" ] && CURL+=(-k)

LIVE_ID="01J5LIVE0000000000000000AB"
NOIMG_ID="01J5NOIMG000000000000000CD"
GONE_ID="01J5GONE0000000000000000EF"
MISSING_ID="01J5MISSING00000000000000ZZ"
HERO="/notice/hero-kyeongnicius.webp"
CRAWLER_UA="facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"
HUMAN_UA="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

mkdir -p "$OUT"
PASS=0; FAIL=0
ok(){   PASS=$((PASS+1)); printf 'PASS  %s\n' "$*"; }
bad(){  FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$*"; }
check(){ # check <설명> <조건참이면0>
  if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi
}

PIDS=()
cleanup(){
  for p in "${PIDS[@]:-}"; do [ -n "${p:-}" ] && kill "$p" 2>/dev/null; done
  sleep 0.5
  for p in "${PIDS[@]:-}"; do [ -n "${p:-}" ] && kill -9 "$p" 2>/dev/null; done
  return 0
}
trap cleanup EXIT

# ── 0) 산출물 준비 ───────────────────────────────────────────────────────────────
[ -f apps/web/dist/index.html ] || {
  echo "ERROR: apps/web/dist 가 없다 — 먼저 빌드해라: VITE_API_BASE=... bash infra/pages/build.sh" >&2
  exit 2
}
rm -rf "$WORK/dist"; mkdir -p "$WORK/dist"
rsync -a apps/web/dist/ "$WORK/dist/"
mkdir -p "$OUT"

# 배포와 동일한 배치 경로를 탄다(build.sh 가 부르는 바로 그 스크립트).
rm -rf "$ROOT/functions"
if [ "${HMB_E2E_STAGE:-1}" = "1" ]; then
  bash infra/pages/stage-functions.sh "$ROOT" | tee "$OUT/stage.log"
else
  echo "[e2e] HMB_E2E_STAGE=0 — functions 배치 생략(red 기준선)" | tee "$OUT/stage.log"
fi

case "${HMB_E2E_MUTANT:-}" in
  notice)
    # 변이체: Function 라우트를 `/notice/*` 로 넓힌다 → 히어로 이미지 계약(AC2)이 죽어야 한다.
    mkdir -p "$ROOT/functions/notice"
    cp "$ROOT/functions/share/notice/[id].js" "$ROOT/functions/notice/[id].js"
    echo "[e2e] MUTANT=notice — functions/notice/[id].js 추가"
    ;;
  bake)
    # 변이체: config.json 대신 백엔드 주소를 굽는다 → AC3(런타임 추종)이 죽어야 한다.
    perl -0pi -e "s#const base = typeof cfg\?\.apiBase.*?: \"\";#const base = \"http://127.0.0.1:$STUB_A_PORT\"; void cfg;#s" \
      "$ROOT/functions/share/notice/[id].js"
    echo "[e2e] MUTANT=bake — apiBase 하드코딩"
    ;;
esac

# ── 1) 스텁 백엔드 2개 (A=초기, B=터널 교체 후) ─────────────────────────────────
node infra/pages/e2e/stub-backend.mjs "$STUB_A_PORT" A > "$OUT/stub-a.log" 2>&1 & PIDS+=($!)
node infra/pages/e2e/stub-backend.mjs "$STUB_B_PORT" B > "$OUT/stub-b.log" 2>&1 & PIDS+=($!)
sleep 1

# config.json 은 **배포 산출물의 일부**다. 여기선 A 를 가리키게 두고, 뒤에서 B 로 갈아끼운다.
printf '{\n  "apiBase": "http://127.0.0.1:%s",\n  "updatedAt": "2026-07-30T00:00:00Z",\n  "source": "e2e"\n}\n' \
  "$STUB_A_PORT" > "$WORK/dist/config.json"

# ── 2) wrangler pages dev ────────────────────────────────────────────────────────
WRANGLER="${HMB_WRANGLER:-$(command -v wrangler)}"
DEV_ARGS=(pages dev "$WORK/dist" --ip 127.0.0.1 --port "$PORT"
          --compatibility-date=2025-01-01 --log-level=warn
          --show-interactive-dev-session=false)
[ "$PROTO" = "https" ] && DEV_ARGS+=(--local-protocol https)
echo "[e2e] $WRANGLER ${DEV_ARGS[*]}" | tee -a "$OUT/wrangler.log"
"$WRANGLER" "${DEV_ARGS[@]}" >> "$OUT/wrangler.log" 2>&1 & PIDS+=($!)

for i in $(seq 1 60); do
  "${CURL[@]}" -o /dev/null -w '' "$BASE/index.html" && break
  sleep 1
done
if ! "${CURL[@]}" -o /dev/null "$BASE/index.html"; then
  echo "ERROR: wrangler pages dev 기동 실패 — $OUT/wrangler.log 참조" >&2
  tail -30 "$OUT/wrangler.log" >&2
  exit 3
fi
echo "[e2e] pages dev up: $BASE"

# ── 3) AC1 — 크롤러가 받는 메타 ─────────────────────────────────────────────────
"${CURL[@]}" -A "$CRAWLER_UA" "$BASE/share/notice/$LIVE_ID"   > "$OUT/AC1-og.html"
"${CURL[@]}" -A "$CRAWLER_UA" "$BASE/share/notice/$NOIMG_ID"  > "$OUT/AC1-og-noimage.html"
"${CURL[@]}" -A "$CRAWLER_UA" "$BASE/share/notice/$GONE_ID"   > "$OUT/AC1-og-410.html"
"${CURL[@]}" -A "$CRAWLER_UA" "$BASE/share/notice/$MISSING_ID" > "$OUT/AC1-og-404.html"

OGIMG=$(grep -o 'property="og:image" content="[^"]*"' "$OUT/AC1-og.html" | head -1 | sed 's/.*content="//;s/"$//')
check "AC1 og:title = 공지 제목" \
  "grep -qF 'property=\"og:title\" content=\"[A] 경니시우스 합류 안내\"' '$OUT/AC1-og.html'"
check "AC1 og:description 존재(본문 요약)" \
  "grep -q 'property=\"og:description\" content=\"LEGEND 등급 공격수' '$OUT/AC1-og.html'"
check "AC1 og:image = 본문 첫 이미지의 절대 URL ($OGIMG)" \
  "[ \"\$OGIMG\" = \"$BASE$HERO\" ]"
check "AC1 og:image 가 절대 URL(스킴+호스트)" "echo \"\$OGIMG\" | grep -qE '^https?://[^/]+/'"
check "AC1 og:url = 정규 공유 URL" \
  "grep -qF 'property=\"og:url\" content=\"$BASE/share/notice/$LIVE_ID\"' '$OUT/AC1-og.html'"
check "AC1 twitter:card" "grep -q 'name=\"twitter:card\" content=\"summary_large_image\"' '$OUT/AC1-og.html'"
check "AC1 <title> 도 공지 제목" "grep -qF '<title>[A] 경니시우스 합류 안내</title>' '$OUT/AC1-og.html'"
check "AC1 메타가 </head> 앞에 있다" \
  "python3 -c \"import sys;h=open('$OUT/AC1-og.html',encoding='utf-8').read();sys.exit(0 if h.index('og:title')<h.index('</head>') else 1)\""

check "AC1 이미지 없는 공지는 기본 이미지로 폴백" \
  "grep -qF 'property=\"og:image\" content=\"$BASE/favicon.svg\"' '$OUT/AC1-og-noimage.html'"
check "AC1 제목 특수문자 이스케이프(&lt; &gt; &quot;)" \
  "grep -qF 'content=\"[A] 정기 점검 안내 &lt;필독&gt; &amp; &quot;주의&quot;\"' '$OUT/AC1-og-noimage.html'"

# 410/404 = 흰 화면 금지. 셸은 그대로 200, 메타는 기본값.
for f in "$OUT/AC1-og-410.html" "$OUT/AC1-og-404.html"; do
  n=$(basename "$f")
  check "AC1 $n 셸 유지(#root + 앱 번들)" \
    "grep -q '<div id=\"root\"></div>' '$f' && grep -q 'assets/index-.*\.js' '$f'"
  check "AC1 $n 은 기본 메타(본문 유출 없음)" \
    "grep -q 'property=\"og:title\" content=\"HMB 온라인\"' '$f' && ! grep -q '경니시우스' '$f'"
done

# ── 4) AC2 — 정적 에셋 무회귀(대조군) ───────────────────────────────────────────
"${CURL[@]}" -D "$OUT/AC2-asset.log" -o "$WORK/hero.webp" "$BASE$HERO"
{ echo "--- body bytes ---"; wc -c < "$WORK/hero.webp"; } >> "$OUT/AC2-asset.log"
check "AC2 히어로 이미지 200" "head -1 '$OUT/AC2-asset.log' | grep -q ' 200'"
check "AC2 content-type: image/webp" "grep -qi 'content-type: image/webp' '$OUT/AC2-asset.log'"
check "AC2 크기 > 50KB" "[ \"\$(wc -c < '$WORK/hero.webp')\" -gt 51200 ]"
check "AC2 원본과 바이트 동일" "cmp -s '$WORK/hero.webp' apps/web/dist$HERO"

"${CURL[@]}" -D "$OUT/AC2-headers.log" -o /dev/null "$BASE/index.html"
check "AC2 _headers 가 살아 있다(X-Frame-Options: SAMEORIGIN)" \
  "grep -qi 'x-frame-options: SAMEORIGIN' '$OUT/AC2-headers.log'"

# ── 5) AC3 — 백엔드 URL 을 굽지 않는다 ──────────────────────────────────────────
{
  echo "--- Function 소스에 하드코딩된 백엔드가 있는가 (0 이어야 한다) ---"
  grep -c 'trycloudflare' infra/pages/functions/share/notice/'[id].js' || true
  echo "--- config.json 을 읽는 코드 ---"
  grep -n 'config.json' infra/pages/functions/share/notice/'[id].js' || true
  echo "--- 지금 사이트가 서빙하는 config.json ---"
  "${CURL[@]}" "$BASE/config.json"
} > "$OUT/AC3-config.log" 2>&1

check "AC3 Function 소스에 trycloudflare 하드코딩 0건" \
  "! grep -q 'trycloudflare' infra/pages/functions/share/notice/'[id].js'"
check "AC3 Function 이 /config.json 을 읽는다" \
  "grep -q '\"/config.json\"' infra/pages/functions/share/notice/'[id].js'"

# 런타임 추종: #183 워치독이 하듯 config.json 만 갈아끼우고 **재시작 없이** 다시 요청한다.
printf '{\n  "apiBase": "http://127.0.0.1:%s",\n  "updatedAt": "2026-07-30T00:10:00Z",\n  "source": "watchdog"\n}\n' \
  "$STUB_B_PORT" > "$WORK/dist/config.json"
sleep 2
"${CURL[@]}" -A "$CRAWLER_UA" "$BASE/share/notice/$LIVE_ID" > "$OUT/AC3-after-swap.html"
{ echo "--- config.json 교체 후 og:title ---"
  grep -o 'property="og:title" content="[^"]*"' "$OUT/AC3-after-swap.html" | head -1; } >> "$OUT/AC3-config.log"
check "AC3 config.json 교체를 재시작 없이 따라간다([A]→[B])" \
  "grep -qF 'property=\"og:title\" content=\"[B] 경니시우스 합류 안내\"' '$OUT/AC3-after-swap.html'"

# 원복(뒤 검사들이 A 를 기대한다)
printf '{\n  "apiBase": "http://127.0.0.1:%s",\n  "updatedAt": "2026-07-30T00:00:00Z",\n  "source": "e2e"\n}\n' \
  "$STUB_A_PORT" > "$WORK/dist/config.json"
sleep 2

# ── 6) AC4(curl 층) — 사람 UA 도 같은 SPA 셸 ────────────────────────────────────
"${CURL[@]}" -A "$HUMAN_UA" "$BASE/share/notice/$LIVE_ID" > "$OUT/AC4-human-ua.html"
check "AC4 사람 UA 도 앱 번들을 받는다(UA 분기 없음)" \
  "grep -q 'assets/index-.*\.js' '$OUT/AC4-human-ua.html' && grep -q '<div id=\"root\"></div>' '$OUT/AC4-human-ua.html'"
check "AC4 사람 UA 응답도 크롤러와 동일(og 포함)" \
  "grep -q 'property=\"og:title\"' '$OUT/AC4-human-ua.html'"

# 실브라우저 판정(선택 — playwright 필요). curl 은 "셸이 온다"까지만 본다.
if [ "${HMB_E2E_BROWSER:-1}" = "1" ]; then
  if node infra/pages/e2e/ac4-browser.mjs "$BASE" "$LIVE_ID" "$OUT" > "$OUT/AC4-browser.log" 2>&1; then
    ok "AC4 실브라우저: 공지 팝업 노출 · JS 에러 0 · 실패 요청 0"
  else
    bad "AC4 실브라우저: $OUT/AC4-browser.log 참조"
    tail -40 "$OUT/AC4-browser.log"
  fi
fi

echo ""
echo "════════ 결과: PASS=$PASS FAIL=$FAIL  (로그: $OUT) ════════"
[ "$FAIL" -eq 0 ]
