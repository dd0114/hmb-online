#!/usr/bin/env bash
# 배포 상태 한 눈에 — 테스터 오픈 중 "지금 살아있나?" 를 이 한 줄로 확인한다.
#
#   bash infra/status.sh
#
# 검사: web(Pages) · 백엔드(로컬 18080 + 터널 경유) · 도커 3프로세스 · executor · 터널 URL.
# 읽기 전용(아무것도 안 바꿈).

cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
PAGES="https://${PAGES_PROJECT:-hmb-online}.pages.dev"
G='\033[32m'; R='\033[31m'; Y='\033[33m'; N='\033[0m'
ok(){ printf "  ${G}✓${N} %s\n" "$1"; }
bad(){ printf "  ${R}✗${N} %s\n" "$1"; }
warn(){ printf "  ${Y}!${N} %s\n" "$1"; }

echo "════════ HMB 배포 상태 ════════"

# 0) ⚠️ 워치독 DEGRADED — **맨 위에, 눈에 띄게.**
# 백오프에 들어가면 자가복구가 멈춘다(=터널이 죽어도 아무도 안 고친다). 그런데 그 사실이
# 로그 안에만 있어서, 실측(2026-07-31)에서 상한을 소진하고 복구가 멈춰 있는 동안에도 이 화면은
# 계속 ✓ 만 보여줬다. 그래서 마커 파일을 첫 줄에서 읽는다.
DEG="${HMB_STATE_DIR:-$HOME/.local/state/hmb}/DEGRADED"
if [ -f "$DEG" ]; then
  printf "  \033[1;31m▲ 워치독 DEGRADED — 자가복구 백오프 중(터널이 죽어도 자동으로 안 고쳐진다)\033[0m\n"
  printf "     %s\n" "$(cat "$DEG" 2>/dev/null | tr '\t' ' ')"
  printf "     완화: printf 'HMB_HEAL_MAX_PER_HOUR=6\\\\n' > %s   (원복: rm 그 파일)\n" \
         "${HMB_STATE_DIR:-$HOME/.local/state/hmb}/heal.conf"
  printf "     지금 복구: bash infra/start-tunnel.sh  또는  bash infra/publish-backend-url.sh <새URL>\n"
fi

# 1) 도커 백엔드
for c in hmb-java hmb-runner; do
  st=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo "없음")
  hl=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$c" 2>/dev/null)
  if [ "$st" = "running" ]; then ok "$c: running ${hl:+($hl)}"; else bad "$c: $st"; fi
done

# 2) AI 실행기 (호스트 프로세스)
# ⚠️ 체크아웃(pwd)으로 필터하면 안 된다 — executor 는 다른 워크트리에서 떠 있는 게 정상이고
#    (실측: spider10 에서 가동 중인데 spider14 에서 "없음" 오보), 그 grep -c 는 여러 줄을 세어
#    `[: 0\n0: integer expression expected` 도 냈다. 머신 전역으로 세고 어느 체크아웃인지 보여준다.
# (macOS pgrep 에는 -c 가 없다 — 셌다가 조용히 0 이 된다. wc 로 센다.)
n=$(ps -eo command | grep -c "[e]xecutor-main" | tr -d ' \n'); n=${n:-0}
if [ "$n" -ge 1 ]; then
  where=$(ps -eo command | grep "[e]xecutor-main" | grep -oE '/Users/[^ ]*/hmb-online' | head -1)
  ok "executor: 실행 중 ($n proc${where:+, $where})"
else
  warn "executor: 없음 (AI 매치 안 돌아감 — 모드 A 재기동 필요)"
fi

# 3) 백엔드 로컬(18080) — health. 토큰이 있으면 200, 없어도 **401 이면 java 는 살아있다**
#    (워크트리마다 infra/.env 가 있는 게 아니라, 토큰 부재를 백엔드 사망으로 오판하면 안 된다 — 실측).
TOK=$(grep -E '^SERVANT_TOKEN=' infra/.env 2>/dev/null | cut -d= -f2)
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -H "X-Servant-Token: $TOK" http://localhost:18080/internal/health 2>/dev/null)
case "$code" in
  200) ok "백엔드 로컬(18080): health 200";;
  401|403) ok "백엔드 로컬(18080): 응답함($code — 이 체크아웃에 SERVANT_TOKEN 없음, 백엔드는 정상)";;
  *) bad "백엔드 로컬(18080): $code";;
esac

# 4) 터널 (cloudflared) + 현재 URL
PIDF=/tmp/hmb-cf-tunnel.pid; LOG=/tmp/hmb-cf-tunnel.log
if [ -f "$PIDF" ] && ps -p "$(cat "$PIDF")" >/dev/null 2>&1; then
  # -a: 로그에 제어문자가 섞여도 URL 을 캡처한다(없으면 URL 칸이 빈다 — 2026-07-30 실장애)
  URL=$(grep -aoE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" 2>/dev/null | tail -1)
  ok "터널: 실행 중 (pid $(cat "$PIDF"))  URL=$URL"
  if [ -n "$URL" ]; then
    # 워치독(#183)과 **같은 방식**으로 판정한다: ① 이 머신 ISP DNS 는 trycloudflare 를 못 풀 때가
    # 있으므로 공개 해석기로 폴백해 IP 를 고정하고 ② 토큰 없는 GET /internal/health 의 401 을
    # "java 가 응답했다" 는 증거로 쓴다. (기존 POST 로그인 방식은 DNS 때문에 000 을 내며
    # 멀쩡한 터널을 죽었다고 보고했다 — 실측.)
    THOST="${URL#https://}"; THOST="${THOST%%/*}"; TIP=""
    for r in "" "@8.8.8.8" "@9.9.9.9"; do
      TIP=$(dig +short +time=3 +tries=1 $r "$THOST" 2>/dev/null | grep -E '^[0-9.]+$' | head -1)
      [ -n "$TIP" ] && break
    done
    if [ -n "$TIP" ]; then
      tcode=$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 --resolve "$THOST:443:$TIP" "https://$THOST/internal/health" 2>/dev/null)
    else
      tcode=$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 "$URL/internal/health" 2>/dev/null)
    fi
    case "$tcode" in
      200|401|403|404) ok "터널 경유 백엔드: 응답 $tcode (경로 정상)";;
      *) bad "터널 경유 백엔드: $tcode";;
    esac
  fi
else
  bad "터널: 없음 (테스터 접속 불가 — 'bash infra/start-tunnel.sh' 로 재기동)"
fi

# 5) web — 두 방식 지원: quick-tunnel serve(현 매니저 채택) 또는 Pages
if [ -f /tmp/hmb-web-serve.pid ] && ps -p "$(cat /tmp/hmb-web-serve.pid)" >/dev/null 2>&1; then
  scode=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:${WEB_PORT:-4321}/" 2>/dev/null)
  [ "$scode" = "200" ] && ok "web 정적서버(로컬 ${WEB_PORT:-4321}): 200" || bad "web 정적서버: $scode"
fi
if [ -f /tmp/hmb-web-tunnel.pid ] && ps -p "$(cat /tmp/hmb-web-tunnel.pid)" >/dev/null 2>&1; then
  WURL=$(grep -aoE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/hmb-web-tunnel.log 2>/dev/null | tail -1)
  ok "web 터널: 실행 중 (pid $(cat /tmp/hmb-web-tunnel.pid))  ⇒ 테스터 URL=$WURL"
  warn "테스터 URL 은 외부에서 열림 — 로컬 DNS 캐시로 이 머신 curl 은 실패할 수 있음(정상)"
else
  # Pages 방식 폴백 확인
  wcode=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$PAGES/" 2>/dev/null)
  [ "$wcode" = "200" ] && ok "web(Pages): $PAGES → 200" || warn "web 터널 없음 / Pages $PAGES → $wcode"
fi

# 6) CORS 결선 확인 (백엔드 허용 오리진 = 현재 web 오리진 = 테스터 URL 이어야 함)
cors=$(docker exec hmb-java sh -c 'echo $HMB_CORS_ALLOWEDORIGINS' 2>/dev/null)
if [ -n "${WURL:-}" ]; then EXPECT="$WURL"; else EXPECT="$PAGES"; fi
[ "$cors" = "$EXPECT" ] && ok "CORS 결선: $cors" || warn "CORS: '$cors' (web 오리진 '$EXPECT' 와 다름 — 왕복 막힐 수 있음)"

# 7) 자가복구 워치독 (#183) — 터널이 죽어도 사람이 안 가도 되는지
if launchctl print "gui/$(id -u)/online.hmb.tunnel-heal" >/dev/null 2>&1; then
  LAST=$(tail -1 "${HMB_STATE_DIR:-$HOME/.local/state/hmb}/tunnel-heal.log" 2>/dev/null | cut -f2,3)
  ok "자가복구 워치독: 가동 중${LAST:+ (최근: $LAST)}"
else
  warn "자가복구 워치독: 미설치 — 터널이 죽으면 사람이 가야 한다 ('bash infra/install-tunnel-heal.sh')"
fi

# 8) web 이 실제로 가리키는 백엔드 (런타임 config) — 터널과 어긋나면 테스터는 죽어 있다
SERVED=$(curl -fsS --max-time 10 "$PAGES/config.json?t=$(date +%s)" 2>/dev/null | sed -n 's/.*"apiBase" *: *"\([^"]*\)".*/\1/p' | head -1)
if [ -n "$SERVED" ]; then
  if [ -z "${URL:-}" ] || [ "$SERVED" = "$URL" ]; then ok "web→백엔드 결선: $SERVED"
  else warn "web 은 '$SERVED' 을 보는데 현재 터널은 '$URL' (워치독이 곧 맞춘다 / 급하면 'bash infra/publish-backend-url.sh $URL')"; fi
fi

echo "═══════════════════════════════"
echo "테스터 접속: ${WURL:-$PAGES}"
