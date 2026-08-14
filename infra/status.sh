#!/usr/bin/env bash
# 배포 상태 한 눈에 — 테스터 오픈 중 "지금 살아있나?" 를 이 한 줄로 확인한다.
#
#   bash infra/status.sh
#
# 검사: web(Pages) · 백엔드(로컬 18080 + 터널 경유) · 도커 3프로세스 · executor · 터널 URL.
# 읽기 전용(아무것도 안 바꿈).

cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
. infra/lib/portable.sh   # checkout_from_cmdline 등 OS 분기 (#472 AC1.1)
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
  printf "     완화: 위 사유가 말하는 축을 올린다 (예: printf 'HMB_HEAL_TRIES=8\\\\n' > %s, 원복: rm 그 파일)\n" \
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
  # 경로 추출은 홈 규약(/Users vs /home vs /opt)에 묶지 않는다 — 이사 후에도 같은 관측이 나와야 한다(#472).
  where=$(ps -eo command | grep "[e]xecutor-main" | checkout_from_cmdline)
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
#
# ⚠️ **"등록돼 있다" 는 "돌고 있다" 가 아니다** (#497, 2026-08-13 실장애).
#    구 판정은 ① 서비스 등록됐나 ② tunnel-heal.log 마지막 줄 — 둘 다 통과하는데 워치독이
#    33분간 한 틱도 못 돈 적이 있다. 그 로그는 **뭔가 일어났을 때만** 늘어나므로 "정상이라 조용"
#    과 "죽어서 조용" 이 구분되지 않고, 그날은 spawn 자체가 실패해 로그를 남길 수도 없었다.
#    → 매 틱 무조건 갱신되는 **심박**과 서비스 관리자의 **마지막 종료코드** 를 같이 본다.
#    ⚠️ 등록·종료코드 조회는 둘 다 `infra/lib/portable.sh`(#472 AC1.1) 를 거친다 — 여기서 서비스
#    관리자를 직접 부르면 리눅스에서 항상 "미설치/빈 값" 이 되어 이사 후 이 게이트가 통째로 죽는다.
HEAL_STATE="${HMB_STATE_DIR:-$HOME/.local/state/hmb}"
if watchdog_installed; then
  LAST=$(tail -1 "$HEAL_STATE/tunnel-heal.log" 2>/dev/null | cut -f2,3)
  XSTAT=$(watchdog_last_exit)
  BEAT=$(cut -f1 "$HEAL_STATE/last-tick" 2>/dev/null)
  AGE=""; [ -n "${BEAT:-}" ] && AGE=$(( $(date +%s) - BEAT ))
  # 틱 60초 → 3틱(180초) 넘게 심박이 없으면 안 도는 것이다.
  STALE="${HMB_HEAL_STALE:-180}"
  if [ -z "${BEAT:-}" ]; then
    warn "자가복구 워치독: 심박 없음 ($HEAL_STATE/last-tick) — 한 틱도 못 돌았거나 구버전 설치본이다"
    warn "  → bash infra/install-tunnel-heal.sh 로 재설치 (원본을 고쳤으면 반드시 재설치해야 반영된다)"
  elif [ "$AGE" -gt "$STALE" ]; then
    printf "  \033[1;31m▲ 자가복구 워치독이 %s초째 안 돈다 (심박 정지) — 터널이 죽어도 자동으로 안 고쳐진다\033[0m\n" "$AGE"
    printf "     마지막 종료코드=%s  ← 78(EX_CONFIG)이면 유닛의 기동 전제(경로)가 사라진 것이다 (#497)\n" "${XSTAT:-?}"
  else
    # ⚠️ **"돌고 있다" 는 "고치고 있다" 가 아니다** (#505, 2026-08-14 실장애).
    #    그날 이 화면은 10/10 ✓ 였고 워치독 줄도 ✓ 였다 — 그런데 직전에 자동복구가 **2연속 실패**
    #    했고 터널을 살린 것은 사람이었다. 심박(도는가)과 치유 결과(고쳤는가)는 다른 축인데
    #    한 줄이 심박만 보고 ✓ 를 찍었다. 최근 이벤트가 실패 계열이면 그 줄을 경고로 올린다.
    #    ⚠️ 영구 경고가 되면 노이즈다 → 창(기본 6시간) 안의 실패만 본다. 그 뒤 성공 이벤트가
    #    있으면 마지막 줄이 그 성공이라 자동으로 사라진다.
    LASTEV=$(tail -1 "$HEAL_STATE/tunnel-heal.log" 2>/dev/null | cut -f3)
    LASTTS=$(tail -1 "$HEAL_STATE/tunnel-heal.log" 2>/dev/null | cut -f1)
    EVAGE=999999; case "${LASTTS:-}" in ''|*[!0-9]*) ;; *) EVAGE=$(( $(date +%s) - LASTTS ));; esac
    case "$LASTEV" in
      HEAL_FAIL|HEAL_UNPROPAGATED|PUBLISH_FAIL|PUBLISH_UNVERIFIED|RUN_TIMEOUT|BACKEND_DOWN|DEGRADED|HEAL_DEFER)
        if [ "$EVAGE" -le "${HMB_HEAL_FAIL_WINDOW:-21600}" ]; then
          printf "  ${Y}!${N} 자가복구 워치독: 돌고는 있는데 ${Y}최근 자동복구가 실패했다${N} — $LAST\n"
          printf "     심박 ${AGE}초 전 · 지금 터널이 살아 있다면 그건 사람이 살린 것이다 (#505)\n"
        else
          ok "자가복구 워치독: 가동 중 (심박 ${AGE}초 전, exit=${XSTAT:-0})${LAST:+ · 최근 이벤트: $LAST}"
        fi;;
      *) ok "자가복구 워치독: 가동 중 (심박 ${AGE}초 전, exit=${XSTAT:-0})${LAST:+ · 최근 이벤트: $LAST}";;
    esac
    # 남은 재시도 예산 (#505 축1/축2/축3) — "자동으로 몇 발 더 쏘나" 가 안 보이면 판단할 수 없다.
    # ⚠️ **설치본을 먼저 묻는다** — 실제로 도는 것이 그것이고, 리포 판을 물으면 아직 배포 안 된
    #    노브 값을 현재 상태로 오독한다. 설치본이 구버전이라 `--budget` 을 모르면(usage 64) 그
    #    출력은 예산 줄이 아니므로 버리고 리포 판으로 폴백한다(그러면 "설치본이 낡았다"가 보인다).
    budget_of(){ [ -r "$1" ] && bash "$1" --budget 2>/dev/null | head -1 | grep '^재시도 예산' || true; }
    BUD=$(budget_of "$HOME/.local/bin/hmb-tunnel-heal.sh")
    if [ -n "$BUD" ]; then
      printf "     %s\n" "$BUD"
    else
      BUD=$(budget_of infra/tunnel-heal.sh)
      if [ -n "$BUD" ]; then
        printf "     %s  ${Y}(리포 판 기준 — 설치본은 --budget 을 모른다 = 낡았다)${N}\n" "$BUD"
        warn "워치독 설치본이 리포보다 낡았다 → bash infra/install-tunnel-heal.sh"
      fi
    fi
  fi
  # 스크립트가 돌더라도 종료코드가 비정상이면 그 자체가 신호다.
  case "${XSTAT:-0}" in
    0|"") ;;
    78) printf "  \033[1;31m▲ 마지막 종료코드 78 (EX_CONFIG) — 유닛의 WorkingDirectory/경로가 없어 실행조차 못 하고 있다 (#497)\033[0m\n";;
    *)  warn "워치독 마지막 종료코드 $XSTAT — $HEAL_STATE/tunnel-heal.err 를 볼 것";;
  esac
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
