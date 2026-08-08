#!/usr/bin/env bash
# 모의 이사 리허설 — **같은 머신에서** 런북 P2/P3 을 실제로 집행한다 (#472 W3).
#
#   bash infra/rehearse-move.sh --check    # 격리 기준선만 찍는다(아무것도 안 바꿈)
#   bash infra/rehearse-move.sh --go       # 리허설 실행(별도 포트·볼륨)
#   bash infra/rehearse-move.sh --clean    # 리허설 잔재만 제거
#
# 무엇을 증명하나: "런북대로 하면 DB 가 온전히 옮겨지고 새 스택이 뜬다" 를 **정지 창 없이** 확인한다.
# 라우터 스왑(P4)은 리허설하지 않는다 — 그건 테스터가 보는 URL 을 실제로 바꾸는 일이라
# 같은 머신에서 흉내낼 수 없다(흉내내면 라이브를 건드리는 것이다).
#
# ⚠️ **이 스크립트의 절반은 격리 가드다.** 리허설이 라이브를 죽이면 그건 리허설이 아니라 사고다.
#    라이브 컨테이너의 **ID 와 기동시각**을 앞뒤로 찍어 대조하고, 하나라도 바뀌면 즉시 실패한다.
#    라이브 볼륨(hmb-p3-db)은 **:ro 로만** 붙는다.
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

MODE="${1:---check}"
LIVE_VOLUME="${HMB_DB_VOLUME:-hmb-p3-db}"
REH_VOLUME="hmb-rehearsal-db"
REH_JAVA_PORT="${REHEARSAL_JAVA_PORT:-28080}"
REH_RUNNER_PORT="${REHEARSAL_RUNNER_PORT:-28790}"
WORK="${HMB_REHEARSAL_DIR:-$HOME/.local/state/hmb/rehearsal}"
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.rehearsal.yml)

# 절대 건드리면 안 되는 것들 — 라이브 · growth · 데모.
PROTECTED=(hmb-java hmb-runner hmb-executor hmb-growth-java hmb-growth-runner hmb-growth-executor)

G='\033[32m'; R='\033[31m'; Y='\033[33m'; N='\033[0m'
ok(){   printf "  ${G}✓${N} %s\n" "$1"; }
bad(){  printf "  ${R}✗${N} %s\n" "$1"; ERR=$((ERR+1)); }
note(){ printf "  ${Y}!${N} %s\n" "$1"; }
say(){  printf "\n\033[1m%s\033[0m\n" "$*"; }
ERR=0

# ── 격리 기준선 ───────────────────────────────────────────────────────
# 컨테이너 **ID + StartedAt** 을 찍는다. 이름만 보면 재생성돼도 같아 보인다 —
# 그러면 "안 건드렸다" 를 이름으로 착각하게 된다.
snapshot(){
  for c in "${PROTECTED[@]}"; do
    line=$(docker inspect "$c" --format '{{.Id}} {{.State.StartedAt}} {{.State.Status}}' 2>/dev/null) \
      && printf '%s %s\n' "$c" "$line"
  done
  docker volume inspect "$LIVE_VOLUME" --format '{{.Name}} {{.CreatedAt}}' 2>/dev/null
}

say "0) 격리 기준선"
BASE=$(snapshot)
if [ -z "$BASE" ]; then bad "보호 대상이 하나도 안 잡힌다 — 도커가 떠 있나?"; else
  printf '%s\n' "$BASE" | sed 's/^/   /'
  ok "$(printf '%s\n' "$BASE" | wc -l | tr -d ' ') 항목 기록"
fi

# 포트 충돌 사전 차단 — 리허설 포트가 이미 누가 쓰고 있으면 시작조차 하지 않는다.
for p in "$REH_JAVA_PORT" "$REH_RUNNER_PORT"; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    bad "리허설 포트 $p 를 이미 누가 쓴다 — REHEARSAL_JAVA_PORT/REHEARSAL_RUNNER_PORT 로 바꿔라"
  else ok "리허설 포트 $p 비어 있음"; fi
done
# 리허설 포트가 라이브/growth/데모 포트와 같으면 그건 설정 사고다.
for p in "$REH_JAVA_PORT" "$REH_RUNNER_PORT"; do
  case "$p" in 8080|8790|18080|18790|19080|19790) bad "리허설 포트 $p 가 보호 포트와 겹친다";; esac
done
[ "$REH_VOLUME" = "$LIVE_VOLUME" ] && bad "리허설 볼륨이 라이브 볼륨과 같다" || ok "볼륨 분리($REH_VOLUME ≠ $LIVE_VOLUME)"

verify_untouched(){
  say "격리 재확인"
  now=$(snapshot)
  if [ "$now" = "$BASE" ]; then
    ok "라이브·growth 컨테이너 ID·기동시각 **완전 동일** · 라이브 볼륨 무변경"
  else
    bad "보호 대상이 바뀌었다 — 아래 diff"
    diff <(printf '%s\n' "$BASE") <(printf '%s\n' "$now") | sed 's/^/   /'
  fi
}

case "$MODE" in
  --check)
    verify_untouched
    say "점검 모드 — 아무것도 바꾸지 않았다. 실행: bash infra/rehearse-move.sh --go"
    [ "$ERR" -gt 0 ] && exit 1 || exit 0 ;;
  --clean)
    say "리허설 잔재 제거 (라이브 무접촉)"
    ( cd infra && "${COMPOSE[@]}" down 2>/dev/null ) || true
    docker volume rm "$REH_VOLUME" >/dev/null 2>&1 && ok "볼륨 $REH_VOLUME 삭제" || note "볼륨 없음"
    rm -rf "$WORK" && ok "작업 디렉토리 정리"
    verify_untouched
    [ "$ERR" -gt 0 ] && exit 1 || exit 0 ;;
  --go) : ;;
  *) echo "사용: $0 [--check|--go|--clean]"; exit 64 ;;
esac

[ "$ERR" -gt 0 ] && { say "사전 점검 실패 — 리허설을 시작하지 않는다"; exit 1; }

# ── P2 상당 — 라이브 DB 를 read-only 로 뜬다 ──────────────────────────
say "1) 라이브 DB 백업 (:ro — 런북 P2-12)"
mkdir -p "$WORK"
docker run --rm -v "$LIVE_VOLUME":/data:ro -v "$WORK:/backup" alpine:3.20 sh -c \
  "apk add --no-cache sqlite >/dev/null 2>&1 && sqlite3 'file:/data/hmb.db?mode=ro' '.backup /backup/rehearsal.db'" \
  || { bad ".backup 실패"; exit 1; }
[ -s "$WORK/rehearsal.db" ] && ok "백업 생성 ($(du -m "$WORK/rehearsal.db" | awk '{print $1}')MB)" || { bad "백업이 비었다"; exit 1; }

say "2) 자산 + economy tar (런북 P2-13)"
docker run --rm -v "$LIVE_VOLUME":/data:ro -v "$WORK:/backup" alpine:3.20 sh -c \
  "tar czf /backup/assets.tgz -C /data notice-assets char-bundles economy.override.json 2>/dev/null || echo '(일부 자산 없음)'"
ok "자산 tar"

say "3) 백업 검증 (런북 P2-14)"
IC=$(docker run --rm -v "$WORK:/w:ro" alpine:3.20 sh -c \
     "apk add --no-cache sqlite >/dev/null 2>&1 && sqlite3 'file:/w/rehearsal.db?mode=ro&immutable=1' 'PRAGMA integrity_check;'" 2>/dev/null)
[ "$IC" = "ok" ] && ok "integrity_check = ok" || bad "integrity_check = '$IC'"
FLY=$(docker run --rm -v "$WORK:/w:ro" alpine:3.20 sh -c \
      "apk add --no-cache sqlite >/dev/null 2>&1 && sqlite3 'file:/w/rehearsal.db?mode=ro&immutable=1' 'SELECT MAX(version) FROM flyway_schema_history;'" 2>/dev/null)
[ -n "${FLY:-}" ] && ok "flyway 최대 버전 = $FLY" || bad "flyway 조회가 **빈 결과** — :ro 마운트에서 sqlite 가 저널을 못 만들면 조용히 빈다"
# ⚠️ 두 쿼리를 따로 던진다. `||"/"||` 로 붙이면 SQLite 가 `"/"` 를 **식별자**로 읽어
#    조용히 빈 결과를 낸다(셸 중첩 따옴표까지 겹쳐 원인이 안 보인다).
rows_of(){ # <docker -v 인자> <db 경로>
  docker run --rm $1 alpine:3.20 sh -c \
    "apk add --no-cache sqlite >/dev/null 2>&1 && sqlite3 'file:$2?mode=ro&immutable=1' \
     'SELECT COUNT(*) FROM users;' 'SELECT COUNT(*) FROM matches;'" 2>/dev/null | tr '\n' '/'
}
SRC_ROWS=$(rows_of "-v $WORK:/w:ro" /w/rehearsal.db)
[ -n "${SRC_ROWS:-}" ] && ok "표본 행수(users/matches) = $SRC_ROWS" || bad "행수 조회가 **빈 결과**"

# ── P2-16 상당 — 리허설 볼륨 적재. chown 은 **디렉토리까지**(함정 ③) ──
say "4) 리허설 볼륨 적재 (런북 P2-16 — chown 디렉토리까지)"
docker volume create "$REH_VOLUME" >/dev/null
docker run --rm -v "$REH_VOLUME":/data -v "$WORK:/src:ro" alpine:3.20 sh -c \
  "cp /src/rehearsal.db /data/hmb.db && tar xzf /src/assets.tgz -C /data 2>/dev/null; \
   chown -R 10001:999 /data && chmod 775 /data" || { bad "적재 실패"; exit 1; }
ok "적재 + chown -R 10001:999 /data"

# ── P3 상당 — 리허설 스택 기동 ────────────────────────────────────────
say "5) 리허설 스택 기동 (런북 P3-17, 포트 $REH_JAVA_PORT/$REH_RUNNER_PORT)"
( cd infra && JAVA_HOST_PORT="$REH_JAVA_PORT" RUNNER_HOST_PORT="$REH_RUNNER_PORT" \
    "${COMPOSE[@]}" up -d java runner ) || { bad "기동 실패"; verify_untouched; exit 1; }

for i in $(seq 1 40); do
  st=$(docker inspect -f '{{.State.Health.Status}}' hmb-rehearsal-java 2>/dev/null)
  [ "$st" = healthy ] && break
  sleep 3
done
[ "$st" = healthy ] && ok "hmb-rehearsal-java healthy" || bad "healthy 도달 실패(마지막 상태 '$st')"

say "6) 기동 검증 (런북 P3-18/19/21)"
docker logs hmb-rehearsal-java 2>&1 | grep -q 'AdminBootstrap.*admins=1' \
  && ok "AdminBootstrap admins=1" \
  || bad "admins=1 아님 — .env 의 HMB_ADMIN_* 짝 확인(P0-6)"

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://localhost:$REH_JAVA_PORT/internal/health")
[ "$code" = "401" ] && ok "/internal/health 토큰없이 401(경로 생존)" || bad "401 아님($code)"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://localhost:$REH_RUNNER_PORT/health")
[ "$code" = "200" ] && ok "runner /health 200" || bad "runner 200 아님($code)"

say "6b) 스모크 — 로그인 → /api/me (런북 P5-28)"
# ⚠️ **고정 계정** `deploy-smoke` 로만 친다(플레이북 :52). 새 계정으로 경기를 돌리면
#    실유저 통계·랭킹에 섞인다. 게스트 로그인은 닉네임으로 기존 계정을 이어받는다.
#    리허설 볼륨은 라이브 DB 의 사본이라, 여기서 무엇을 하든 라이브에는 닿지 않는다.
LOGIN=$(curl -s --max-time 15 -X POST "http://localhost:$REH_JAVA_PORT/api/auth/login" \
  -H 'Content-Type: application/json' -d '{"nickname":"deploy-smoke"}' 2>/dev/null)
TOKEN=$(printf '%s' "$LOGIN" | sed -n 's/.*"token" *: *"\([^"]*\)".*/\1/p')
if [ -n "$TOKEN" ]; then
  ok "로그인 성공 (토큰 발급 · isNew=$(printf '%s' "$LOGIN" | sed -n 's/.*"isNew" *: *\([a-z]*\).*/\1/p'))"
  code=$(curl -s -o "$WORK/me.json" -w '%{http_code}' --max-time 15 \
    -H "Authorization: Bearer $TOKEN" "http://localhost:$REH_JAVA_PORT/api/me")
  if [ "$code" = "200" ]; then
    ok "/api/me 200 (닉네임=$(sed -n 's/.*"nickname" *: *"\([^"]*\)".*/\1/p' "$WORK/me.json" | head -1))"
  else bad "/api/me $code"; fi
else
  bad "로그인 실패 — 응답에 token 없음"
fi

say "7) 이사 전후 DB 대조 (런북 P5 상당)"
DST_ROWS=$(rows_of "-v $REH_VOLUME:/data:ro" /data/hmb.db)
[ -n "$SRC_ROWS" ] && [ "$SRC_ROWS" = "$DST_ROWS" ] \
  && ok "행수 일치: $SRC_ROWS" || bad "행수 불일치 src=$SRC_ROWS dst=$DST_ROWS"
ECON=$(docker run --rm -v "$REH_VOLUME":/data:ro alpine:3.20 sh -c 'wc -c < /data/economy.override.json' 2>/dev/null | tr -d ' ')
[ "${ECON:-0}" -gt 0 ] && ok "economy.override.json 이송됨 (${ECON}B)" \
  || bad "economy.override.json 이 리허설 볼륨에 없다 — 런북 P2-13 tar 목록 확인"

verify_untouched

say "결과"
if [ "$ERR" -gt 0 ]; then printf "${R}FAIL${N}  %d 건\n" "$ERR"; exit 1; fi
printf "${G}OK${N}  런북 P2~P3 가 같은 머신에서 재현됐다. 정리: bash infra/rehearse-move.sh --clean\n"
