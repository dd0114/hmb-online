#!/usr/bin/env bash
# P4-E2 (#170) W4 통합 스모크 — **실제 3프로세스**에서 서버 권위 시계가 도는지 본다.
#
# 단위·통합 테스트는 전부 "phase_ends_at 을 과거로 밀고 sweep() 을 부른다"로 시간을 앞당긴다.
# 여기서는 반대로 **아무 것도 부르지 않고 진짜로 기다린다** — config 로 하프를 6초·감독시간 3초까지
# 압축해서, 킥오프 한 번으로 FIRST_HALF → HALFTIME → SECOND_HALF → FINISHED 가 저절로 흐르는지 본다.
# (AC-W3-2 "압축비·감독시간은 전부 config" 가 실제로 먹히는지도 여기서 같이 증명된다.)
#
# 데모(8080/8790)·배포(18080/18790) 무접촉: 28080/28790 + 임시 DB 를 쓴다.
# 실행: bash server-java/scripts/p4-clock-smoke.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
JAVA_PORT=28080
RUNNER_PORT=28790
BASE="http://localhost:${JAVA_PORT}"
TOKEN_SERVANT="smoke-token"
HALF_MS=6000        # 하프 = 실시간 6초 (운영 240000)
HALFTIME_MS=3000    # 감독시간 = 3초 (운영 60000)
TMP="$(mktemp -d /tmp/hmb-p4-smoke-XXXX)"
# gradle·부트는 JDK 17+ 가 필요하다. 셸 기본 JAVA_HOME 이 11 인 환경이 있어 **21 을 우선 탐색**한다
# (여기서 안 맞추면 "JVM runtime version 17" 로 빌드가 죽는다).
JAVA_HOME_21="$(/usr/libexec/java_home -v 21 2>/dev/null || true)"
export JAVA_HOME="${JAVA_HOME_21:-${JAVA_HOME:-}}"
[ -n "$JAVA_HOME" ] || { echo "JDK 21 을 못 찾았다"; exit 1; }
export PATH="$JAVA_HOME/bin:$PATH"

RUNNER_PID=""; JAVA_PID=""; EXEC_PID=""
cleanup() {
  # 패턴 kill 금지(다른 세션 스택을 죽인다) — 우리가 띄운 PID 만 정리한다.
  for pid in "$EXEC_PID" "$JAVA_PID" "$RUNNER_PID"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null
  done
  wait 2>/dev/null
  echo "로그: $TMP"
}
trap cleanup EXIT

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$*"; exit 1; }

wait_http() { # url, 초
  local url="$1" limit="${2:-60}" i=0
  while [ $i -lt "$limit" ]; do
    curl -sf "$url" >/dev/null 2>&1 && return 0
    sleep 1; i=$((i+1))
  done
  return 1
}

state_of() { curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/matches/$MATCH/" 2>/dev/null; }

# ── 1) 엔진 러너(서번트①) ────────────────────────────────────────────────
say "엔진 러너 기동 :$RUNNER_PORT"
( cd "$ROOT" && RUNNER_PORT=$RUNNER_PORT npm run runner --workspace=@hmb/server >"$TMP/runner.log" 2>&1 ) &
RUNNER_PID=$!
wait_http "http://localhost:$RUNNER_PORT/health" 60 || fail "러너가 안 뜬다 ($TMP/runner.log)"

# ── 2) 권위 서버(java) — 시계를 압축한 config 로 ──────────────────────────
say "server-java 빌드 + 기동 :$JAVA_PORT (하프 ${HALF_MS}ms · 감독시간 ${HALFTIME_MS}ms)"
( cd "$ROOT/server-java" && ./gradlew bootJar -q ) || fail "bootJar 실패"
JAR="$(ls "$ROOT"/server-java/build/libs/*.jar | grep -v plain | head -1)"
( cd "$ROOT/server-java" && java \
    -Dserver.port=$JAVA_PORT \
    -Dhmb.db.path="$TMP/hmb.db" \
    -Dhmb.servant.engine-runner-url="http://localhost:$RUNNER_PORT" \
    -Dhmb.servant.internal-token="$TOKEN_SERVANT" \
    -Dhmb.match.clock.half-real-ms=$HALF_MS \
    -Dhmb.match.clock.halftime-ms=$HALFTIME_MS \
    -jar "$JAR" >"$TMP/java.log" 2>&1 ) &
JAVA_PID=$!
wait_http "$BASE/api/modes" 90 || wait_http "$BASE/actuator/health" 5 || {
  # /api/modes 는 인증이 필요할 수 있다 — 포트만 열렸으면 진행.
  curl -s -o /dev/null "$BASE/api/modes" || fail "java 가 안 뜬다 ($TMP/java.log)"
}

# ── 3) AI 실행기(서번트②) — stub 모드(오프라인) ──────────────────────────
say "AI 실행기 기동 (stub)"
( cd "$ROOT" && AI_EXECUTOR=stub JAVA_URL="$BASE" SERVANT_TOKEN="$TOKEN_SERVANT" \
    npm run executor --workspace=@hmb/server >"$TMP/executor.log" 2>&1 ) &
EXEC_PID=$!
sleep 2

# ── 4) 유저·덱·매치 ──────────────────────────────────────────────────────
say "가입 → 덱 → 매치 생성"
NICK="smoke$(date +%s)"
TOKEN="$(curl -s -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"nickname\":\"$NICK\",\"password\":\"pw1234\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')"
[ -n "$TOKEN" ] || fail "가입 실패 ($TMP/java.log)"

# 스타터 팩에서 받은 선수로 선발 11 + 벤치 2 를 채운다(포지션 무관 — 시계 스모크라 라인업 품질은 무관).
# /api/players = 카탈로그 전체 + owned 병합. 보유(owned=true)한 선수만 골라 GK 1 + 필드 10 + 벤치 2.
DECK_JSON="$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/players" \
  | python3 -c '
import sys, json
owned = [p for p in json.load(sys.stdin) if p.get("owned")]
gk = [p for p in owned if p.get("position") == "GK"]
if not gk:
    sys.exit("스타터 팩에 GK 가 없다")
gk_id = gk[0]["id"]
rest = [p["id"] for p in owned if p["id"] != gk_id]
slots = [{"playerId": gk_id, "role": "starter", "slotIndex": 0}]
slots += [{"playerId": pid, "role": "starter", "slotIndex": i + 1} for i, pid in enumerate(rest[:10])]
slots += [{"playerId": pid, "role": "bench", "slotIndex": i} for i, pid in enumerate(rest[10:12])]
print(json.dumps({"formation": "4-3-3", "slots": slots}))
')"
curl -s -o "$TMP/deck.json" -w '%{http_code}\n' -X PUT "$BASE/api/deck" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$DECK_JSON" | grep -q 200 \
  || fail "덱 저장 실패: $(cat "$TMP/deck.json")"

MATCH="$(curl -s -X POST "$BASE/api/matches" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')"
[ -n "$MATCH" ] || fail "매치 생성 실패"

# ── 5) 킥오프 후 **아무 것도 하지 않고** 상태 변화를 관찰한다 ────────────
say "킥오프 → 관찰 (수동 개입 0)"
curl -s -X POST "$BASE/api/matches/$MATCH/kickoff" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{}' >/dev/null

START=$(date +%s)
: > "$TMP/states.txt"     # macOS bash 3.2 라 연관배열이 없다 — 관찰 결과를 파일에 적고 끝에서 판정한다
SEEN_LIST=""
MAXLAT=0
for _ in $(seq 1 200); do   # 최대 ~100초 관찰(0.5s 간격)
  T0=$(python3 -c 'import time;print(int(time.time()*1000))')
  BODY="$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/matches/$MATCH")"
  T1=$(python3 -c 'import time;print(int(time.time()*1000))')
  LAT=$((T1-T0)); [ "$LAT" -gt "$MAXLAT" ] && MAXLAT=$LAT
  ST="$(printf '%s' "$BODY" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("state",""))' 2>/dev/null)"
  case " $SEEN_LIST " in
    *" $ST "*) : ;;
    *)
      if [ -n "$ST" ]; then
        ELAPSED=$(( $(date +%s) - START ))
        SEEN_LIST="$SEEN_LIST $ST"
        echo "$ST $ELAPSED" >> "$TMP/states.txt"
        printf '  t+%02ds  %s   (GET %sms)\n' "$ELAPSED" "$ST" "$LAT"
        printf '%s' "$BODY" | python3 -c '
import sys, json
c = json.load(sys.stdin).get("clock")
if c:
    print("          clock phase=%s ends=%s halfRealMs=%s halftimeMs=%s"
          % (c["phase"], c["phaseEndsAt"], c["halfRealMs"], c["halftimeMs"]))
' 2>/dev/null
      fi
      ;;
  esac
  [ "$ST" = "FINISHED" ] && break
  [ "$ST" = "FAILED" ] && fail "매치가 FAILED ($TMP/java.log)"
  sleep 0.5
done

say "결과"
echo "관찰된 상태 순서:$SEEN_LIST"
echo "폴링 GET 최대 지연: ${MAXLAT}ms"

python3 - "$TMP/states.txt" "$HALF_MS" "$HALFTIME_MS" "$MAXLAT" <<'PY' || fail "시계 판정 실패(위 사유)"
import sys
seen = {}
for line in open(sys.argv[1]):
    st, t = line.split()
    seen.setdefault(st, int(t))
half_s, halftime_s, maxlat = int(sys.argv[2]) / 1000, int(sys.argv[3]) / 1000, int(sys.argv[4])

for st in ("FIRST_HALF", "HALFTIME", "SECOND_HALF", "FINISHED"):
    if st not in seen:
        sys.exit("%s 를 못 봤다 (관찰: %s)" % (st, ", ".join(seen)))

d1 = seen["HALFTIME"] - seen["FIRST_HALF"]      # 전반 재생 창
d2 = seen["SECOND_HALF"] - seen["HALFTIME"]     # 감독시간(+후반 생성)
d3 = seen["FINISHED"] - seen["SECOND_HALF"]     # 후반 재생 창
print("전반 %ss (config %ss) · 감독시간+생성 %ss (config %ss) · 후반 %ss (config %ss)"
      % (d1, half_s, d2, halftime_s, d3, half_s))

# 폴링 주기(0.5s)+스위퍼 주기(1s) 오차를 감안한 밴드. config 를 안 읽는 구현이면 여기서 크게 벗어난다.
def band(name, actual, expect, slack=3):
    if not (expect - 1 <= actual <= expect + slack):
        sys.exit("%s 가 config 와 안 맞는다: %ss (기대 %ss)" % (name, actual, expect))

band("전반 길이", d1, half_s)
band("감독시간", d2, halftime_s)
band("후반 길이", d3, half_s)
if maxlat >= 3000:
    sys.exit("폴링 GET 이 %sms 붙잡혔다(무거운 전이가 요청 스레드에 남아 있다)" % maxlat)
PY

printf '\n\033[32mPASS — 서버 시계만으로 전반→감독시간→후반→종료가 흘렀다(수동 개입 0)\033[0m\n'
