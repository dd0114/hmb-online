#!/usr/bin/env bash
# #297 AC4 — **기동된 서버에 실제 curl**. 통합테스트(MockMvc 아님, RANDOM_PORT)가 이미 있는데도
# 이걸 따로 도는 이유: 인증 인터셉터 제외는 **서블릿 경로 매칭**의 문제라, 진짜 톰캣 + 진짜
# HTTP 클라이언트로 한 번은 통과시켜야 "빌드에선 되는데 배포에선 401" 을 배제할 수 있다.
#
# 데모(8080/8790)·배포(18080/18790)·클럭스모크(28080) 무접촉: **28081** + 임시 DB 를 쓴다.
# 실행: bash evidence/sub-297/ac4-curl.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT=28081
BASE="http://localhost:${PORT}"
TMP="$(mktemp -d /tmp/hmb-notice-byid-XXXX)"
DB="$TMP/hmb.db"

# gradle·부트는 JDK 21 이 필요하다. 셸 기본 JAVA_HOME 이 낮은 환경이 있어 21 을 우선 탐색한다.
JAVA_HOME_21="$(/usr/libexec/java_home -v 21 2>/dev/null || true)"
export JAVA_HOME="${JAVA_HOME_21:-${JAVA_HOME:-}}"
[ -n "$JAVA_HOME" ] || { echo "JDK 21 을 못 찾았다"; exit 1; }
export PATH="$JAVA_HOME/bin:$PATH"

APP_PID=""
FAILURES=0
cleanup() {
  # 패턴 kill 금지(다른 세션 스택을 죽인다) — 우리가 띄운 PID 만 정리한다.
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null
  wait 2>/dev/null
  echo "로그: $TMP/app.log"
}
trap cleanup EXIT

say()  { printf '\n== %s\n' "$*"; }
ok()   { printf 'OK   %s\n' "$*"; }
bad()  { printf 'FAIL %s\n' "$*"; FAILURES=$((FAILURES+1)); }

# ── 1) 빌드 + 기동 ────────────────────────────────────────────────────────
say "server-java bootJar 빌드"
( cd "$ROOT/server-java" && ./gradlew bootJar -q ) || { echo "빌드 실패"; exit 1; }
JAR="$(ls "$ROOT/server-java"/build/libs/*.jar | grep -v plain | head -1)"
echo "jar = $JAR"

say "기동 :$PORT (임시 DB $DB)"
( cd "$ROOT/server-java" && java -jar "$JAR" \
    --server.port=$PORT --hmb.db.path="$DB" >"$TMP/app.log" 2>&1 ) &
APP_PID=$!

# /api/config 는 공개(미인증)라 readiness 로 쓴다.
for i in $(seq 1 90); do
  curl -sf "$BASE/api/config" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "$BASE/api/config" >/dev/null 2>&1 || { echo "서버가 안 뜬다 ($TMP/app.log)"; tail -40 "$TMP/app.log"; exit 1; }
ok "기동 완료 (/api/config 200)"

# ── 2) 픽스처 — Flyway 가 만든 스키마에 직접 넣는다(admin 자격 불필요) ──────
say "픽스처 3건 삽입 (LIVE / EXPIRED / — )"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
sqlite3 "$DB" <<SQL
INSERT INTO notices(id,title,body,starts_at,ends_at,active,priority,revision,deleted_at,created_by,created_at,updated_at)
VALUES ('N-CURL-LIVE','공유된 공지','본문 살아있음',NULL,NULL,1,3,2,NULL,NULL,'$NOW','$NOW');
INSERT INTO notices(id,title,body,starts_at,ends_at,active,priority,revision,deleted_at,created_by,created_at,updated_at)
VALUES ('N-CURL-EXPIRED','끝난 공지','본문 만료','2020-01-01T00:00:00Z','2020-01-02T00:00:00Z',1,0,1,NULL,NULL,'$NOW','$NOW');
INSERT INTO notices(id,title,body,starts_at,ends_at,active,priority,revision,deleted_at,created_by,created_at,updated_at)
VALUES ('N-CURL-SCHEDULED','예약 공지','아직 공개 전 — 새면 안 된다','2999-01-01T00:00:00Z',NULL,1,0,1,NULL,NULL,'$NOW','$NOW');
SQL
sqlite3 "$DB" "SELECT id,active,starts_at,ends_at,deleted_at FROM notices ORDER BY id;"

# ── 3) 미인증 curl ────────────────────────────────────────────────────────
# 헤더를 아예 안 붙인다 = 카톡 링크를 처음 여는 사람과 같은 조건.
code_of() { curl -s -o "$TMP/body-$2.json" -w '%{http_code}' "$BASE/api/notices/$1"; }

say "① LIVE — 미인증 200 + 본문"
CODE_LIVE="$(code_of N-CURL-LIVE live)"
BODY_LIVE="$(cat "$TMP/body-live.json")"
echo "HTTP $CODE_LIVE"
echo "body = $BODY_LIVE"
[ "$CODE_LIVE" = "200" ] && ok "LIVE = 200 (Authorization 헤더 없음)" || bad "LIVE 가 $CODE_LIVE (기대 200)"

say "①-b 응답 키 집합 == 화이트리스트 (AC3 — 운영 필드 미노출)"
KEYS="$(python3 -c "import json,sys; print(','.join(sorted(json.load(open(sys.argv[1])).keys())))" "$TMP/body-live.json")"
EXPECTED_KEYS="body,endsAt,id,priority,revision,startsAt,title"
echo "keys     = $KEYS"
echo "expected = $EXPECTED_KEYS"
[ "$KEYS" = "$EXPECTED_KEYS" ] && ok "키 집합 정확히 일치 (active·deletedAt·createdBy·updatedAt 0개)" \
  || bad "키 집합이 다르다"

say "② EXPIRED — 410"
CODE_GONE="$(code_of N-CURL-EXPIRED gone)"
echo "HTTP $CODE_GONE / body = $(cat "$TMP/body-gone.json")"
[ "$CODE_GONE" = "410" ] && ok "EXPIRED = 410" || bad "EXPIRED 가 $CODE_GONE (기대 410)"

say "③ 없는 id — 404"
CODE_404="$(code_of N-CURL-NOPE absent)"
echo "HTTP $CODE_404 / body = $(cat "$TMP/body-absent.json")"
[ "$CODE_404" = "404" ] && ok "없는 id = 404" || bad "없는 id 가 $CODE_404 (기대 404)"

say "④ 예약(SCHEDULED) — 404 이고 '없는 id' 와 응답이 구분 불가능"
CODE_SCHED="$(code_of N-CURL-SCHEDULED sched)"
echo "HTTP $CODE_SCHED / body = $(cat "$TMP/body-sched.json")"
[ "$CODE_SCHED" = "404" ] && ok "예약 = 404" || bad "예약이 $CODE_SCHED (기대 404)"
if diff -q "$TMP/body-sched.json" "$TMP/body-absent.json" >/dev/null; then
  ok "예약 응답 본문 == 없는 id 응답 본문 (존재 누출 없음)"
else
  bad "예약 응답이 없는 id 와 다르다 — 존재가 샌다"
fi
grep -q "아직 공개 전" "$TMP/body-sched.json" && bad "예약 공지 본문이 샜다" || ok "예약 공지 본문 미노출"

# ── 4) openapi 계약 선언 ──────────────────────────────────────────────────
say "⑤ openapi 계약에 엔드포인트 선언 존재"
if grep -q '^  /api/notices/{id}:' "$ROOT/docs/plan-v2/api/openapi.yaml"; then
  grep -n -A 3 '^  /api/notices/{id}:' "$ROOT/docs/plan-v2/api/openapi.yaml"
  ok "openapi.yaml 에 /api/notices/{id} 선언"
else
  bad "openapi.yaml 에 선언이 없다"
fi

say "결과"
if [ "$FAILURES" -eq 0 ]; then
  echo "ALL CHECKS PASSED (LIVE=$CODE_LIVE EXPIRED=$CODE_GONE ABSENT=$CODE_404 SCHEDULED=$CODE_SCHED)"
else
  echo "$FAILURES 건 실패"
fi
exit "$FAILURES"
