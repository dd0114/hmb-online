#!/usr/bin/env bash
# 워치독 재시도 예산·게이트·증거보존 계약 (#505) — **주입 가능한 실패 경로로** 재현한다.
#
#   bash infra/test-tunnel-heal.sh
#
# ⚠️ 실장애를 만들 수 없으니 부품을 갈아끼운다. 이 하네스는 **라이브를 절대 건드리지 않는다**:
#   · STATE_DIR·TUNNEL_LOG·TUNNEL_PID 전부 스크래치 디렉토리로 격리 (락도 STATE_DIR 아래다)
#   · `cloudflared` 는 PATH 앞의 **가짜**다 — URL 을 절대 안 찍는다(= "새 URL 획득 실패" 주입)
#   · `curl` 도 가짜다 — **소켓을 하나도 열지 않는다**(라이브 18080·Pages·터널 무접촉)
#   · `dig` 도 가짜로 갈아끼워 **DNS 사망을 주입**한다 (2026-08-14 1차 실패의 실제 원인)
# 그래서 이 테스트는 라이브 터널·라이브 Pages·라이브 도커를 한 번도 부르지 않는다.
#
# 판정은 **종료코드와 로그 사실**로만 한다(눈으로 읽고 "맞아 보인다" 금지).

set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
HEAL="$PWD/infra/tunnel-heal.sh"

SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/hmb-healtest.XXXXXX")
trap 'rm -rf "$SCRATCH"' EXIT

PASS=0; FAIL=0
G='\033[32m'; R='\033[31m'; N='\033[0m'
check(){ # check "이름" "기대" "실제"
  if [ "$2" = "$3" ]; then printf "  ${G}✓${N} %s\n" "$1"; PASS=$((PASS+1))
  else printf "  ${R}✗${N} %s — 기대 '%s' 실제 '%s'\n" "$1" "$2" "$3"; FAIL=$((FAIL+1)); fi
}
grep_check(){ # grep_check "이름" <패턴> <파일>
  if grep -q "$2" "$3" 2>/dev/null; then printf "  ${G}✓${N} %s\n" "$1"; PASS=$((PASS+1))
  else printf "  ${R}✗${N} %s — '%s' 가 %s 에 없다\n" "$1" "$2" "$3"; FAIL=$((FAIL+1)); fi
}

# ── 가짜 도구 ──────────────────────────────────────────────────────────────────────
BIN="$SCRATCH/bin"; mkdir -p "$BIN"
# cloudflared: 등록 실패만 찍고 산다(URL 없음). 살아 있어야 heal 의 kill 경로도 태운다.
cat > "$BIN/cloudflared" <<'EOF'
#!/usr/bin/env bash
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) INF Requesting new quick Tunnel on trycloudflare.com..."
echo "failed to request quick Tunnel: Post \"https://api.trycloudflare.com/tunnel\": dial tcp: lookup api.trycloudflare.com: no such host"
sleep 600
EOF
# dig: HMB_TEST_DNS=dead 면 아무것도 안 준다(=이름 해석 실패 주입). 아니면 더미 IP.
cat > "$BIN/dig" <<'EOF'
#!/usr/bin/env bash
[ "${HMB_TEST_DNS:-ok}" = "dead" ] && exit 1
echo "203.0.113.7"
EOF
cat > "$BIN/publish" <<'EOF'
#!/usr/bin/env bash
# 호출됐다는 사실과 넘겨받은 배포 상한을 남긴다 — "시작하지 않았다"를 계약으로 걸 수 있어야 한다.
printf '%s\tHMB_DEPLOY_TIMEOUT=%s\n' "$*" "${HMB_DEPLOY_TIMEOUT:-<없음>}" >> "${HMB_TEST_PUBLISH_MARK:-/dev/null}"
echo "fake publish $*"
EOF
# curl 도 가짜다 — 이 하네스는 **소켓을 하나도 열지 않는다**(샌드박스·오프라인에서도 같은 판정이
# 나와야 하고, 실 네트워크에 기대면 '네트워크가 막혔다' 가 '예산 회계가 틀렸다' 로 오독된다).
#   · 로컬 백엔드 헬스 → 401 (= "java 가 응답했다", tunnel-heal 의 판정 규약 그대로)
#   · 그 밖 전부 → 000 (터널 왕복은 이 테스트의 대상이 아니다 — URL 획득에서 이미 실패한다)
cat > "$BIN/curl" <<'EOF'
#!/usr/bin/env bash
# -fsS 계열 = pages_backend 의 config.json 조회. 테스트가 심어 둔 "Pages 가 서빙 중인 값"을 준다
# (파일이 없으면 응답 없음 = 종전 동작).
for a in "$@"; do case "$a" in -fsS*|-fs)
  [ -s "${HMB_TEST_SERVED_FILE:-}" ] || exit 1
  cat "$HMB_TEST_SERVED_FILE"; exit 0;; esac
done
# 헬스 프로브(로컬 백엔드·터널 왕복 둘 다) = 401 (java 가 응답했다는 규약, tunnel-heal §3)
for a in "$@"; do case "$a" in *internal/health*) printf '401'; exit 0;; esac; done
printf '000'; exit 0
EOF
chmod +x "$BIN"/*
# ⚠️ `export PATH=…` 로는 안 된다 — tunnel-heal.sh 가 시스템 경로를 **앞에** 재설정하므로
#    가짜가 뒤로 밀려 시스템 바이너리가 이긴다. 그 스크립트가 여는 주입 이음매를 쓴다.
export HMB_BIN_PREFIX="$BIN"
PORT=18099   # 가짜 curl 이 응답하므로 실제로 열리는 포트가 아니다 (라이브 18080 무접촉)

# ── 격리 환경 ──────────────────────────────────────────────────────────────────────
export HMB_STATE_DIR="$SCRATCH/state"
export HMB_TUNNEL_LOG="$SCRATCH/cf.log"
export HMB_TUNNEL_PID="$SCRATCH/cf.pid"
export HMB_BACKEND_PORT="$PORT"
export HMB_PUBLISH_CMD="$BIN/publish"
export HMB_TUNNEL_GRACE=0        # 갓 뜬 터널 유예 끄기
export HMB_CONFIRM_SLEEP=0       # blip 재확인 대기 0
export HMB_RUN_DEADLINE=0        # 자기 마감 감시자 끄기(테스트가 알아서 짧다)
mkdir -p "$HMB_STATE_DIR"
HEALLOG="$HMB_STATE_DIR/tunnel-heal.log"
HEALS="$HMB_STATE_DIR/heals.tsv"

# heals.tsv 를 원하는 모양으로 심는다. 인자 = 지금으로부터 몇 초 전들.
seed_heals(){ : > "$HEALS"; local n; for n in "$@"; do printf '%s\t seeded\tattempt\n' "$(( $(date +%s) - n ))" >> "$HEALS"; done; }

echo "════════ #505 워치독 예산 계약 ════════"

# ── T1. DNS 게이트: 등록 엔드포인트가 안 풀리면 예산을 쓰지 않는다 ────────────────
seed_heals
: > "$HMB_TUNNEL_LOG"
HMB_TEST_DNS=dead bash "$HEAL" --once >"$SCRATCH/t1.out" 2>&1; rc=$?
check "T1 DNS 사망 → 유예(exit 3)" "3" "$rc"
check "T1 예산 무소모 (heals.tsv 0줄)" "0" "$(wc -l < "$HEALS" | tr -d ' ')"
grep_check "T1 HEAL_DEFER 기록" "HEAL_DEFER" "$HEALLOG"
check "T1 새 cloudflared 안 띄움" "0" "$([ -f "$HMB_TUNNEL_PID" ] && echo 1 || echo 0)"

# ── T2. 게이트 데드라인: 오래 유예되면 게이트를 무시하고 시도한다 ─────────────────
# (dig 가 죽었는데 cloudflared 는 되는 경우가 있다 — 게이트가 영구 차단이 되면 안 된다)
printf '%s\t seeded\n' "$(( $(date +%s) - 700 ))" > "$HMB_STATE_DIR/heal-defer"
HMB_TEST_DNS=dead bash "$HEAL" --once >"$SCRATCH/t2.out" 2>&1; rc=$?
check "T2 데드라인 초과 → 시도함(exit 1 = 치유 실패)" "1" "$rc"
grep_check "T2 게이트 무시 기록" "HEAL_GATE_OVERRIDE" "$HEALLOG"
check "T2 예산 1 소모" "1" "$(wc -l < "$HEALS" | tr -d ' ')"

# ── T3. 증거 보존: 실패 사유가 heal 로그와 보관함에 남는다 ────────────────────────
grep_check "T3 실패 사유(cf 줄)가 heal 로그에" "no such host" "$HEALLOG"
check "T3 시도별 로그 보관됨" "1" "$(ls -1 "$HMB_STATE_DIR"/tunnel-logs/*.log 2>/dev/null | wc -l | tr -d ' ' | awk '{print ($1>=1)?1:0}')"
# 사람이 start-tunnel.sh 로 원본을 덮어도 보관본은 남아 있어야 한다(2026-08-14 소실 재현 방지)
: > "$HMB_TUNNEL_LOG"
grep_check "T3 원본이 덮여도 보관본에 사유 생존" "no such host" "$(ls -1t "$HMB_STATE_DIR"/tunnel-logs/*.log 2>/dev/null | head -1)"

# ── T4. 백오프: 방금 소모한 직후엔 예산을 더 쓰지 않는다 ──────────────────────────
seed_heals 5
rm -f "$HMB_STATE_DIR/heal-defer"
bash "$HEAL" --once >"$SCRATCH/t4.out" 2>&1; rc=$?
check "T4 백오프 대기(exit 3)" "3" "$rc"
check "T4 예산 무소모 (1줄 유지)" "1" "$(wc -l < "$HEALS" | tr -d ' ')"
grep_check "T4 백오프 사유 표시" "백오프" "$SCRATCH/t4.out"

# ── T5. 재시도 예산: 같은 장애에 5회 쓰면 DEGRADED ────────────────────────────────
# 장애 내부 간격(≤900s)으로 5개를 심고, 마지막은 백오프를 넘긴 시각으로 둔다.
seed_heals 1500 1200 900 600 310
bash "$HEAL" --once >"$SCRATCH/t5.out" 2>&1; rc=$?
check "T5 예산 소진 → DEGRADED(exit 5)" "5" "$rc"
grep_check "T5 축1 이름으로 사유 표시" "재시도 예산 소진" "$HEALLOG"
check "T5 DEGRADED 마커 생성" "1" "$([ -f "$HMB_STATE_DIR/DEGRADED" ] && echo 1 || echo 0)"

# ── T6. 구 상한(3)이 막던 자리가 이제 산다 ────────────────────────────────────────
# ⚠️ 경계를 정확히 쓴다: 08-13 12:09 건은 **3번째 시도에 성공**했고 그건 구 규칙에서도 허용됐다
#    (n=2 < 3). 구 규칙이 막는 것은 **4번째**다 — 그래서 "여유가 한 번뿐" 이었고, 그 장애가
#    3번째에 안 살았으면 자동복구는 거기서 끝이었다. 이 계약이 재는 것은 그 **4번째**다.
#    (초판은 3번째를 막힌다고 썼다가 아래 A2 아블레이션에 잡혔다.)
rm -f "$HMB_STATE_DIR/DEGRADED"
seed_heals 1000 700 400
bash "$HEAL" --once >"$SCRATCH/t6.out" 2>&1; rc=$?
check "T6 같은 장애 4번째 시도 허용(구 상한 3 은 여기서 막았다)" "1" "$rc"
check "T6 실제로 시도했다 (4줄)" "4" "$(wc -l < "$HEALS" | tr -d ' ')"

# ── T7. 장애 상한(축2): 서로 다른 장애 3건 뒤 4번째는 막는다 ──────────────────────
# 간격 > INCIDENT_GAP(900) 이면 별개 장애. 1시간 안에 3건이면 새 장애를 더 열지 않는다.
rm -f "$HMB_STATE_DIR/DEGRADED"
seed_heals 3400 2200 1100
bash "$HEAL" --once >"$SCRATCH/t7.out" 2>&1; rc=$?
check "T7 시간당 장애 상한 → DEGRADED(exit 5)" "5" "$rc"
grep_check "T7 축2 이름으로 사유 표시" "장애 상한" "$HEALLOG"

# ── T8. 폭주 방지선(축3)은 살아 있다 ──────────────────────────────────────────────
rm -f "$HMB_STATE_DIR/DEGRADED"
seed_heals 3500 3400 3300 3200 3100 3000 2900 2800 2700 2600 2500 2400 2300 2200 400
bash "$HEAL" --once >"$SCRATCH/t8.out" 2>&1; rc=$?
check "T8 절대 방지선 → DEGRADED(exit 5)" "5" "$rc"
grep_check "T8 방지선 이름으로 사유 표시" "폭주방지선" "$HEALLOG"

# ── T9. --budget 은 읽기 전용이다 (심박을 오염시키지 않는다) ──────────────────────
# status.sh 가 이걸 부른다 — 여기서 심박을 찍으면 죽은 워치독이 살아 있는 것으로 보인다(#497).
printf '1\t2000-01-01T00:00:00Z\t--once\n' > "$HMB_STATE_DIR/last-tick"
bash "$HEAL" --budget >"$SCRATCH/t9.out" 2>&1; rc=$?
check "T9 --budget exit 0" "0" "$rc"
check "T9 심박 무오염" "1" "$(cut -f1 "$HMB_STATE_DIR/last-tick")"
grep_check "T9 세 축을 다 보여준다" "재시도 예산" "$SCRATCH/t9.out"

# ── T10. 구 노브 이름 호환 (조용히 무시되면 최악) ─────────────────────────────────
rm -f "$HMB_STATE_DIR/DEGRADED"; seed_heals 400
HMB_MAX_HEALS_PER_HOUR=1 bash "$HEAL" --once >"$SCRATCH/t10.out" 2>&1; rc=$?
check "T10 구 이름 HMB_MAX_HEALS_PER_HOUR 가 방지선으로 먹힌다" "5" "$rc"

# ── P. 전파 예산이 실행 상한을 안다 (#508, 2026-08-17 라이브 장애) ────────────────
# 그날: 배포 1회 최악 ≈295s vs 자기마감 420s → 2번째 시도 완주부터 마감을 넘는다. 실측은
# 마감 자체가 trap 레이스로 무장해제돼 한 틱이 28분을 돌았다(#514 재검증 — tunnel-heal.sh
# 상단 주석 참조). 이 게이트는 어느 쪽이든 "못 끝낼 시도를 시작하지 않는다"로 막는다.
# 주입: "터널은 정상인데 web 이 옛 주소를 본다"(= publish_only 경로) + 실행 잔여를 짧게.
setup_publish_only(){   # $1 = HMB_RUN_DEADLINE
  rm -f "$HMB_STATE_DIR/DEGRADED" "$SCRATCH/pubmark"
  : > "$HEALLOG"; seed_heals
  printf 'https://new-tunnel-abc.trycloudflare.com\n' > "$HMB_TUNNEL_LOG"
  printf '{"apiBase":"https://old-tunnel-xyz.trycloudflare.com"}\n' > "$SCRATCH/served.json"
  export HMB_TEST_SERVED_FILE="$SCRATCH/served.json" HMB_TEST_PUBLISH_MARK="$SCRATCH/pubmark"
}

# P1. 남은 실행시간으로 1회를 못 끝내면 **시작하지 않는다**.
setup_publish_only
HMB_RUN_DEADLINE=50 bash "$HEAL" --once >"$SCRATCH/p1.out" 2>&1; rc=$?
check "P1 전파 시작 안 함(exit 1)" "1" "$rc"
grep_check "P1 PUBLISH_DEFER 로 사유를 남긴다" "PUBLISH_DEFER" "$HEALLOG"
check "P1 publish 를 부르지 않았다" "0" "$([ -s "$SCRATCH/pubmark" ] && echo 1 || echo 0)"
check "P1 RUN_TIMEOUT 으로 죽지 않았다" "0" "$(grep -c RUN_TIMEOUT "$HEALLOG" 2>/dev/null | tr -d ' ')"

# P2. 잔여가 상한보다 짧으면 **줄여서** 넘긴다(그래야 마감 안에 끝난다).
setup_publish_only
HMB_RUN_DEADLINE=200 HMB_PUBLISH_TRIES=1 bash "$HEAL" --once >"$SCRATCH/p2.out" 2>&1
grep_check "P2 배포 상한을 줄였다고 기록" "PUBLISH_CAP" "$HEALLOG"
check "P2 줄인 상한이 실제로 publish 에 전달됐다" "1" \
  "$(awk -F'HMB_DEPLOY_TIMEOUT=' 'NF>1{v=$2+0; if (v>0 && v<240) print 1}' "$SCRATCH/pubmark" 2>/dev/null | head -1 | tr -d ' \n' || echo 0)"

# P3. 마감이 넉넉하면 그냥 돈다(= P1 이 마감을 재는 것이지 전파를 막는 게 아니다).
setup_publish_only
HMB_RUN_DEADLINE=0 HMB_PUBLISH_TRIES=1 bash "$HEAL" --once >"$SCRATCH/p3.out" 2>&1
check "P3 마감 없음 → publish 를 실제로 부른다" "1" "$([ -s "$SCRATCH/pubmark" ] && echo 1 || echo 0)"
unset HMB_TEST_SERVED_FILE HMB_TEST_PUBLISH_MARK

# ── R. publish 가 실패를 **실패로** 보고한다 (#508 결함1) ─────────────────────────
# 2026-08-17 라이브: wrangler 가 SIGKILL(137) 로 죽었는데 로그는 `실패(rc=0)` 였고 종료코드도 0 이었다.
# 원인 = `if ! cmd; then rc=$?` — 그 `$?` 는 명령이 아니라 `!` 의 결과(실패 시 항상 0)다.
# 주입: 가짜 wrangler 를 `HMB_WRANGLER` 로 물려 원하는 종료코드를 내게 한다(네트워크 0).
PUB="$PWD/infra/publish-backend-url.sh"
# 캐시 온전성 게이트(index.html + assets/)를 통과시켜야 run_deploy 까지 간다 — 그 게이트가
# 이 테스트의 대상이 아니다(빈 사이트 배포를 막는 별개 방어선이고 이미 잘 돈다).
mkdir -p "$SCRATCH/dist/assets"; printf '<html></html>' > "$SCRATCH/dist/index.html"
printf '/* x */' > "$SCRATCH/dist/assets/app.js"
printf '#!/usr/bin/env bash\nexit 137\n' > "$BIN/wrangler137"; printf '#!/usr/bin/env bash\nexit 1\n' > "$BIN/wrangler1"
chmod +x "$BIN/wrangler137" "$BIN/wrangler1"
> "$SCRATCH/r.out"
# R0. 캐시에 config.json 이 없어도 **조용히 죽지 않는다**(위 dist 에 일부러 안 만들었다).
#     구 코드는 `PREV=$(sed …)` 가 set -e 로 exit 1 하며 아무것도 안 찍었다.
run_pub(){ # $1 = 가짜 wrangler
  env HMB_LOCK_HELD=1 HMB_STATE_DIR="$HMB_STATE_DIR" HMB_DIST_CACHE="$SCRATCH/dist" \
      HMB_WORK_DIR="$SCRATCH/work" PAGES_PROJECT=hmb-test-nonexistent HMB_WRANGLER="$1" \
      CLOUDFLARE_API_TOKEN=x CLOUDFLARE_ACCOUNT_ID=y \
      bash "$PUB" https://new-tunnel-abc.trycloudflare.com >"$SCRATCH/r.out" 2>&1
}
run_pub "$BIN/wrangler137"; rc=$?
grep_check "R0 config.json 없는 캐시에서도 조용히 안 죽는다" "config.json:" "$SCRATCH/r.out"
check "R1 SIGKILL(137) 이 137 로 나간다 (구동작 0)" "137" "$rc"
grep_check "R1 사람이 읽을 사유 — 시간초과/강제종료(rc=137)" "rc=137" "$SCRATCH/r.out"
run_pub "$BIN/wrangler1"; rc=$?
check "R2 일반 실패(1) 도 그대로 나간다" "1" "$rc"
grep_check "R2 rc 를 사유에 찍는다" "rc=1" "$SCRATCH/r.out"

# ── 아블레이션: 각 계약이 정말 하중을 받는가 ──────────────────────────────────────
# ⚠️ "26개 다 green" 은 하네스가 아무것도 안 봐도 나올 수 있는 결과다. 그래서 **끄면 판정이
#    뒤집히는지**를 같이 본다. (구 스크립트로 돌려 보는 카나리아도 23/26 red 이지만, 그쪽은
#    주입 이음매가 없어 전부 exit 4(backend down)로 죽으므로 "예산 로직이 바뀌었다"의 증거로는
#    약하다 — 그래서 노브 단위로 다시 판별한다.)
echo "──────── 아블레이션 (끄면 뒤집히나) ────────"
# ⚠️ P 섹션이 터널 로그에 URL 을 심어 뒀다 — 비우지 않으면 `--once` 가 "터널 정상" 으로 빠져
#    heal 경로에 아예 들어가지 않고 셋 다 exit 0 이 된다(실제로 한 번 그렇게 나왔다).
: > "$HMB_TUNNEL_LOG"

# A1. DNS 게이트를 끄면 유예가 사라진다 → 같은 입력이 예산 판정으로 넘어간다.
rm -f "$HMB_STATE_DIR/DEGRADED" "$HMB_STATE_DIR/heal-defer"; seed_heals 1500 1200 900 600 310
HMB_TEST_DNS=dead HMB_HEAL_DNS_GATE=0 bash "$HEAL" --once >"$SCRATCH/a1.out" 2>&1; rc=$?
check "A1 게이트 off → 유예(3) 아님, 예산 판정(5)로" "5" "$rc"

# A2. 예산을 구 상한(3)으로 되돌리면 T6 이 뒤집힌다 = T6 은 예산을 재고 있다.
#     (이 아블레이션이 T6 초판의 경계 오류를 잡았다 — 하네스가 무는지 보는 값이 여기 있다.)
rm -f "$HMB_STATE_DIR/DEGRADED"; seed_heals 1000 700 400
HMB_HEAL_TRIES=3 bash "$HEAL" --once >"$SCRATCH/a2.out" 2>&1; rc=$?
check "A2 예산 3 으로 되돌리면 4번째가 다시 막힌다(5)" "5" "$rc"

# A3. 백오프를 0 으로 두면 T4 가 뒤집힌다 = T4 는 백오프를 재고 있다.
rm -f "$HMB_STATE_DIR/DEGRADED"; seed_heals 5
HMB_HEAL_RETRY_BASE=0 HMB_HEAL_RETRY_MAX=0 bash "$HEAL" --once >"$SCRATCH/a3.out" 2>&1; rc=$?
check "A3 백오프 0 → 대기(3) 아님, 곧바로 시도(1)" "1" "$rc"

echo "═══════════════════════════════"
printf "PASS %d · FAIL %d\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
