#!/usr/bin/env bash
# 모의 이사 리허설 — **같은 머신에서** 런북 P2/P3 을 실제로 집행한다 (#472 W3).
#
#   bash infra/rehearse-move.sh --check    # 격리 기준선만 찍는다(아무것도 안 바꿈)
#   bash infra/rehearse-move.sh --go       # 리허설 실행(별도 포트·볼륨)
#   bash infra/rehearse-move.sh --clean    # 리허설 잔재만 제거
#
# 무엇을 증명하나: "런북대로 하면 DB 가 온전히 옮겨지고 새 스택이 뜬다" 를 **정지 창 없이** 확인한다.
#
# ⚠️ **무엇을 증명하지 않나**(green 이 곧 "이사 끝"이 아니다 — AC 는 이 범위 안에서만 참이다):
#   · **P0/P1(사전 준비)·P4(라우터 스왑)** — 리허설 밖이다. 특히 P4 는 테스터가 보는 URL 을 실제로
#     바꾸는 일이라 같은 머신에서 흉내낼 수 없다(흉내내면 그게 라이브를 건드리는 것이다).
#   · **이미지 빌드** — 이미 있는 로컬 이미지로 뜬다. 새 머신 첫 빌드의 실패(arch 불일치·캐시 부재)는
#     여기서 안 난다.
#   · **실제 네트워크 전송** — rsync(P2-15)를 타지 않고 같은 머신에서 볼륨→볼륨으로 옮긴다.
#   · **AI 모드 A** — executor 를 `AI_EXECUTOR=stub` 으로 띄운다(구독 세션을 리허설에 쓰지 않는다).
#   전문 = docs/plan-v4/migration-runbook.md "모의 이사 리허설" 절.
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

# 포트 **비어 있음** 검사 — 시작하려는 모드에서만 의미가 있다.
# ⚠️ `--clean` 에서 부르면 안 된다. 정리 시점에 리허설 포트가 점유돼 있는 것은 **정상**이고
#    (그게 지금 내리려는 리허설 스택이다) 그걸 결함으로 세면 **정리에 전부 성공하고도 exit 1**
#    이 된다. 실제로 그랬다 — AC3-clean.log 가 ✗ 둘을 찍고도 "clean exit=0" 으로 끝나
#    "증빙이 조작됐나" 로 읽혔다(#472 D2). 결함은 exit code 가 아니라 **검사 범위**였다.
check_free_ports(){
  for p in "$REH_JAVA_PORT" "$REH_RUNNER_PORT"; do
    if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
      bad "리허설 포트 $p 를 이미 누가 쓴다 — REHEARSAL_JAVA_PORT/REHEARSAL_RUNNER_PORT 로 바꿔라"
    else ok "리허설 포트 $p 비어 있음"; fi
  done
}
# 아래 둘은 **설정 정합성**이라 모드와 무관하게 항상 본다(정리 중에도 참이어야 한다).
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
    check_free_ports
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
  --go) check_free_ports ;;
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
# ⚠️ 두 쿼리를 따로 던지고 **각각을 검증**한다. 여기엔 무음 부분실패 함정이 둘 겹쳐 있다:
#   ⓐ `||"/"||` 로 붙이면 SQLite 가 `"/"` 를 **식별자**로 읽어 조용히 빈 결과를 낸다
#      (셸 중첩 따옴표까지 겹쳐 원인이 안 보인다).
#   ⓑ 그렇다고 두 SELECT 를 한 호출에 묶고 `2>/dev/null | tr '\n' '/'` 로 받으면 **절반만 성공해도**
#      `[ -n … ]` 를 통과한다(users 만 나오면 `"12/"` — 비어 있지 않다). 이게 이 리포 세 번째
#      무음 부분실패다(WAL+mode=ro · `||"/"||` · 여기). 검사가 통과하는데 값이 반쪽이면
#      "행수 일치"라는 결론 자체가 반쪽 위에 선다.
#   그래서 컨테이너 안에서 **라벨을 붙여** 내보내고, 밖에서 **둘 다 정수인지** 본다.
rows_of(){ # <docker -v 인자> <db 경로> → "users=N matches=M" · 하나라도 비면 exit 1
  raw=$(docker run --rm $1 alpine:3.20 sh -c \
    "apk add --no-cache sqlite >/dev/null 2>&1 && \
     printf 'users=%s\n' \"\$(sqlite3 'file:$2?mode=ro&immutable=1' 'SELECT COUNT(*) FROM users;')\" && \
     printf 'matches=%s\n' \"\$(sqlite3 'file:$2?mode=ro&immutable=1' 'SELECT COUNT(*) FROM matches;')\"" 2>/dev/null)
  u=$(printf '%s\n' "$raw" | sed -n 's/^users=\([0-9][0-9]*\)$/\1/p')
  m=$(printf '%s\n' "$raw" | sed -n 's/^matches=\([0-9][0-9]*\)$/\1/p')
  [ -n "$u" ] && [ -n "$m" ] || return 1
  printf 'users=%s matches=%s' "$u" "$m"
}
# 해시는 **양쪽 다 같은 컨테이너 안에서** 잰다 — 자[尺]가 같아야 앞뒤 대조가 성립하고,
# 호스트 OS 분기(shasum vs sha256sum)도 필요 없어진다.
sha_of(){ docker run --rm $1 alpine:3.20 sha256sum "$2" 2>/dev/null | awk '{print $1}'; }

if SRC_ROWS=$(rows_of "-v $WORK:/w:ro" /w/rehearsal.db); then
  ok "표본 행수($SRC_ROWS)"
else
  bad "행수 조회 실패 — users·matches 중 하나라도 비면 여기서 잡는다(부분실패 포함)"; SRC_ROWS=""
fi
SRC_SHA=$(sha_of "-v $WORK:/w:ro" /w/rehearsal.db)
[ -n "$SRC_SHA" ] && ok "백업 sha256 = ${SRC_SHA:0:16}…" || bad "백업 sha256 측정 실패"

# ── P2-16 상당 — 리허설 볼륨 적재. chown 은 **디렉토리까지**(함정 ③) ──
say "4) 리허설 볼륨 적재 (런북 P2-16 — chown 디렉토리까지)"
docker volume create "$REH_VOLUME" >/dev/null
docker run --rm -v "$REH_VOLUME":/data -v "$WORK:/src:ro" alpine:3.20 sh -c \
  "cp /src/rehearsal.db /data/hmb.db && tar xzf /src/assets.tgz -C /data 2>/dev/null; \
   chown -R 10001:999 /data && chmod 775 /data" || { bad "적재 실패"; exit 1; }
ok "적재 + chown -R 10001:999 /data"

# ① 이송 무결성 = **두 시점의 sha256 대조** (#472 AC3.2).
# ⚠️ 반드시 **스택 기동 전에** 잰다 — java 가 뜨면 WAL 체크포인트로 파일이 바뀐다. 기동 후에 재면
#    같은 내용인데 해시가 달라 **거짓 red** 가 나고, 그걸 무마하려고 대조를 느슨하게 만들게 된다.
DST_SHA=$(sha_of "-v $REH_VOLUME:/data:ro" /data/hmb.db)
if [ -n "$SRC_SHA" ] && [ "$SRC_SHA" = "$DST_SHA" ]; then
  ok "이송 sha256 일치 — 백업시점 = 볼륨적재후 (${SRC_SHA:0:16}…)"
else
  bad "이송 sha256 불일치 — 백업 ${SRC_SHA:-측정실패} ≠ 볼륨 ${DST_SHA:-측정실패}"
fi

# 행수 대조도 **여기서** 한다 — sha 와 같은 시점(적재 직후·기동 전).
# ⚠️ 한때 이 대조가 스모크 **뒤**에 있었다. 그랬더니 매치 1판 완주(P5-28)가 만든 쓰기를
#    같이 세어 `dst matches 124 ≠ src 123` 으로 red 가 났다(#472 D3) — 이송이 깨진 게 아니라
#    **자[尺]가 리허설 자신의 쓰기를 센 것**이다. 기동 후에 재는 것은 원리적으로 불가능하다:
#    java 는 뜨는 것만으로도 쓴다(WAL·세션·스위퍼). 임계를 느슨하게 하는 방향으로 고치면
#    진짜 유실을 못 잡으므로, 고칠 곳은 임계가 아니라 **시점**이다.
if DST_ROWS=$(rows_of "-v $REH_VOLUME:/data:ro" /data/hmb.db); then
  [ -n "$SRC_ROWS" ] && [ "$SRC_ROWS" = "$DST_ROWS" ] \
    && ok "행수 일치 — 백업($SRC_ROWS) = 볼륨적재후" \
    || bad "행수 불일치 src=[$SRC_ROWS] dst=[$DST_ROWS]"
else
  bad "볼륨 행수 조회 실패(부분실패 포함)"
fi

# ── P3 상당 — 리허설 스택 기동 ────────────────────────────────────────
say "5) 리허설 스택 기동 (런북 P3-17, 포트 $REH_JAVA_PORT/$REH_RUNNER_PORT)"
# ⚠️ executor 를 **AI_EXECUTOR=stub 로 명시**해 띄운다. 두 가지를 동시에 지킨다:
#   ⓐ 매치 1판 완주(P5-28)를 하려면 GEN1/GEN2 잡을 소비할 주체가 있어야 한다.
#   ⓑ 그런데 라이브 모드 A 는 hero 의 **구독 세션**을 쓴다 — 리허설이 그걸 물면 리허설 비용이
#      사람의 쿼터가 된다. stub 은 claude CLI 없이 인풋을 만들어 오프라인으로 끝난다.
#   .env 의 AI_EXECUTOR 값에 의존하지 않는다(라이브가 나중에 live 로 바뀌어도 리허설은 stub).
( cd infra && JAVA_HOST_PORT="$REH_JAVA_PORT" RUNNER_HOST_PORT="$REH_RUNNER_PORT" AI_EXECUTOR=stub \
    "${COMPOSE[@]}" up -d java runner executor ) || { bad "기동 실패"; verify_untouched; exit 1; }

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

# .env 값 읽기 — **값은 절대 출력하지 않는다**(이 파일엔 토큰·admin 평문이 있다).
env_val(){ grep -E "^$1=" infra/.env 2>/dev/null | head -1 | cut -d= -f2-; }

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://localhost:$REH_JAVA_PORT/internal/health")
[ "$code" = "401" ] && ok "/internal/health 토큰없이 401(경로 생존)" || bad "401 아님($code)"
# ⑥ 런북 P3-21 은 **토큰 있는 200 도** 요구한다. 401 만 보면 "게이트가 살아있다"는 알지만
#    "토큰이 실제로 통한다"는 모른다 — 이사에서 깨지는 건 보통 후자다(.env 가 안 따라왔다,
#    java 와 executor 의 SERVANT_TOKEN 이 어긋났다). 그 둘은 서로를 대체하지 못한다.
STOK=$(env_val SERVANT_TOKEN)
if [ -n "$STOK" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
    -H "X-Servant-Token: $STOK" "http://localhost:$REH_JAVA_PORT/internal/health")
  [ "$code" = "200" ] && ok "/internal/health 토큰있이 200(토큰 결선 정상)" || bad "토큰있이 200 아님($code)"
else
  bad "infra/.env 에 SERVANT_TOKEN 이 없다 — P3-21 의 200 케이스를 칠 수 없다"
fi
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://localhost:$REH_RUNNER_PORT/health")
[ "$code" = "200" ] && ok "runner /health 200" || bad "runner 200 아님($code)"

say "6b) 스모크 — 로그인 → /api/me → 덱 → 매치 1판 완주 (런북 P5-28 **전부**)"
# ⚠️ 이 블록은 한때 `(런북 P5-28)` 라벨을 달고 **정의의 절반**(로그인·/api/me)만 했다. 라벨이
#    붙어 있으니 읽는 사람은 완주했다고 믿고, 싱크 계약(AC2.4)은 "스텝이 있나"만 보지
#    "스텝대로 하나"는 안 본다 — 그 틈으로 통과했다(#472 sk3). 그래서 정의를 다 친다:
#    **덱 확인 + 매치 1판 완주**. 이사에서 실제로 깨지는 것은 부팅이 아니라 이 왕복이다.
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

  # ── 덱 + 매치 1판 ───────────────────────────────────────────────────
  # JSON 은 **파서로** 읽는다. 정규식으로 `"id"` 를 긁으면 중첩 객체의 id 를 집어 매치가 아닌
  # 것을 매치 id 로 쓰게 되고, 그 오류는 "매치가 안 끝난다" 로만 보여 원인이 안 보인다.
  jpath(){ node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      try { let o=JSON.parse(s); for (const k of process.argv[1].split(".")) o = o?.[k];
            process.stdout.write(o==null?"":String(o)); } catch(e) {}
    });' "$1" 2>/dev/null; }
  # ⚠️ `api` 는 **명령치환으로 부르지 않는다**(`X=$(api …)`). 그러면 함수가 서브셸에서 돌아
  #    `API_CODE` 대입이 부모로 올라오지 않고, `set -u` 아래에서 unbound 로 죽는다(실제로 죽었다).
  #    호출 규약: `api METHOD 경로 [본문] >/dev/null` 로 부르고 본문은 `body` 로 읽는다.
  API_CODE=""
  body(){ cat "$WORK/api.out"; }
  api(){ # <METHOD> <경로> [본문] → 본문을 $WORK/api.out(+stdout), 상태코드를 $API_CODE
    if [ -n "${3:-}" ]; then
      API_CODE=$(curl -s -o "$WORK/api.out" -w '%{http_code}' --max-time 40 -X "$1" \
        -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$3" \
        "http://localhost:$REH_JAVA_PORT$2")
    else
      API_CODE=$(curl -s -o "$WORK/api.out" -w '%{http_code}' --max-time 40 -X "$1" \
        -H "Authorization: Bearer $TOKEN" "http://localhost:$REH_JAVA_PORT$2")
    fi
    cat "$WORK/api.out"
  }
  wait_state(){ # <matchId> <기대 상태…> — 최대 120초
    local mid="$1"; shift; local st=""
    for _ in $(seq 1 60); do
      st=$(api GET "/api/matches/$mid" | jpath state)
      for w in "$@"; do [ "$st" = "$w" ] && { printf '%s' "$st"; return 0; }; done
      case "$st" in FAILED|ABANDONED) printf '%s' "$st"; return 1 ;; esac
      sleep 2
    done
    printf '%s' "${st:-무응답}"; return 1
  }

  if ! command -v node >/dev/null 2>&1; then
    bad "node 가 없다 — 매치 스모크는 JSON 파싱이 필요하다(정규식 대체 금지)"
  else
    api GET /api/deck >/dev/null; DECKJ=$(body)
    case "$API_CODE" in
      200) ok "GET /api/deck 200 (포메이션=$(printf '%s' "$DECKJ" | jpath formation))" ;;
      404) bad "GET /api/deck 404 — 덱이 없으면 매치를 만들 수 없다(라이브 사본엔 있어야 정상)" ;;
      *)   bad "GET /api/deck $API_CODE" ;;
    esac

    api POST /api/matches '{}' >/dev/null; MJ=$(body)
    if [ "$API_CODE" = "409" ]; then
      # 라이브 **사본**이라 끝나지 않은 매치가 딸려올 수 있다 — 결함이 아니라 스냅샷 시점이다.
      OLD=$(printf '%s' "$MJ" | jpath detail.matchId)
      if [ -n "$OLD" ]; then
        api POST "/api/matches/$OLD/abandon" >/dev/null
        note "사본에 진행 중이던 매치 1건을 정리하고 다시 만든다(리허설 볼륨 안에서만 일어난다)"
        api POST /api/matches '{}' >/dev/null; MJ=$(body)
      fi
    fi
    MID=$(printf '%s' "$MJ" | jpath id)
    if [ "$API_CODE" != "201" ] || [ -z "$MID" ]; then
      bad "매치 생성 실패($API_CODE)"
    else
      ok "매치 생성 201 (id=${MID:0:8}…)"
      api POST "/api/matches/$MID/kickoff" '{}' >/dev/null
      st=$(wait_state "$MID" FIRST_HALF) \
        && ok "킥오프 → 전반 재생 진입(GEN1 소비됨 = executor·runner 결선 정상)" \
        || bad "전반 진입 실패(마지막 상태 $st) — 인풋 생성이 안 돌았다"
      if [ "$st" = "FIRST_HALF" ]; then
        api POST "/api/matches/$MID/skip" '{"phase":"FIRST_HALF"}' >/dev/null
        [ "$API_CODE" = "200" ] && ok "전반 스킵 200" || bad "전반 스킵 $API_CODE"
        api POST "/api/matches/$MID/halftime" '{"substitutions":[]}' >/dev/null
        api POST "/api/matches/$MID/resume" >/dev/null
        st=$(wait_state "$MID" SECOND_HALF) \
          && ok "감독시간 → 후반 재생 진입(GEN2 소비됨)" \
          || bad "후반 진입 실패(마지막 상태 $st)"
        if [ "$st" = "SECOND_HALF" ]; then
          api POST "/api/matches/$MID/skip" '{"phase":"SECOND_HALF"}' >/dev/null
          st=$(wait_state "$MID" FINISHED) \
            && ok "**매치 1판 완주** → FINISHED" || bad "완주 실패(마지막 상태 $st)"
          api GET "/api/matches/$MID/result" >/dev/null; RES=$(body)
          # ⚠️ 필드명은 `scoreHome/scoreAway` 다(`MatchService.MatchResult`). 처음엔 추측한 이름
          #    (`homeGoals/awayGoals`)을 써서 `스코어 :` 로 **빈 값이 찍혔다** — 200 은 났으니
          #    통과했지만, 빈 값이 찍힌 증빙은 "0 대 0" 인지 "못 읽은 것"인지 구별되지 않는다.
          #    그래서 값이 비면 **여기서 red 를 낸다**(증빙은 읽혀야 증빙이다).
          SH=$(printf '%s' "$RES" | jpath scoreHome); SA=$(printf '%s' "$RES" | jpath scoreAway)
          if [ "$API_CODE" != "200" ]; then
            bad "결과 $API_CODE"
          elif [ -z "$SH" ] || [ -z "$SA" ]; then
            bad "결과 200 인데 스코어를 못 읽었다(필드명 드리프트 — scoreHome/scoreAway 확인)"
          else
            ok "결과 200 (스코어 $SH:$SA · $(printf '%s' "$RES" | jpath result))"
          fi
        fi
      fi
    fi
  fi
else
  bad "로그인 실패 — 응답에 token 없음"
fi

# ── ② economy override 가 **실효**인가 (런북 P3, #472 AC3.3) ──────────
say "6c) economy override 실효 확인 (파일 존재가 아니라 서버가 그 값을 쓰는가)"
# ⚠️ 파일이 볼륨에 있다는 것과 java 가 그걸 **읽어 적용했다**는 것은 다른 명제다. 이 함정은
#    무음이다 — 화면은 멀쩡하고 initialGems 숫자만 구운 발행물로 돌아간다. 그래서 권위 조회로 본다.
ANICK=$(env_val HMB_ADMIN_NICKNAME); APW=$(env_val HMB_ADMIN_PASSWORD)
if [ -z "$ANICK" ] || [ -z "$APW" ]; then
  bad "infra/.env 에 HMB_ADMIN_NICKNAME/PASSWORD 가 없다 — admin 권위 조회를 칠 수 없다"
else
  ALOGIN=$(curl -s --max-time 15 -X POST "http://localhost:$REH_JAVA_PORT/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "$(ANICK="$ANICK" APW="$APW" node -e 'process.stdout.write(JSON.stringify({nickname:process.env.ANICK,provider:"local",password:process.env.APW}))')" 2>/dev/null)
  ATOK=$(printf '%s' "$ALOGIN" | sed -n 's/.*"token" *: *"\([^"]*\)".*/\1/p')
  if [ -z "$ATOK" ]; then
    bad "admin 로그인 실패 — 토큰 없음(.env 의 HMB_ADMIN_* 짝 확인)"
  else
    ECOJ=$(curl -s --max-time 15 -H "Authorization: Bearer $ATOK" \
      "http://localhost:$REH_JAVA_PORT/api/admin/economy" 2>/dev/null)
    ESRC=$(printf '%s' "$ECOJ" | sed -n 's/.*"source" *: *"\([^"]*\)".*/\1/p')
    EPRE=$(printf '%s' "$ECOJ" | sed -n 's/.*"overrideFilePresent" *: *\([a-z]*\).*/\1/p')
    [ "$ESRC" = "OVERRIDE" ] && ok "GET /api/admin/economy → source=OVERRIDE" \
      || bad "source=${ESRC:-없음} (OVERRIDE 가 아니다 — 운영조정이 소멸했다)"
    [ "$EPRE" = "true" ] && ok "overrideFilePresent=true" \
      || bad "overrideFilePresent=${EPRE:-없음}"
  fi
fi

say "7) 이송 자산 확인 (런북 P5 상당)"
# 행수·sha 대조는 **4단계**로 옮겼다(기동 전 시점) — 이유는 그 자리 주석 참조(#472 D3).
# 파일 존재는 **선행조건**이지 판정이 아니다 — 판정은 위 6c 의 권위 조회가 한다.
# (파일이 있어도 권한·경로·리로드 어느 하나가 어긋나면 서버는 구운 발행물을 쓴다. 그 둘을
#  같은 것으로 취급했던 것이 AC3.3 이 FAIL 난 이유다 — 존재를 실효로 읽었다.)
ECON=$(docker run --rm -v "$REH_VOLUME":/data:ro alpine:3.20 sh -c 'wc -c < /data/economy.override.json' 2>/dev/null | tr -d ' ')
[ "${ECON:-0}" -gt 0 ] && ok "economy.override.json 파일 이송됨 (${ECON}B — 실효 판정은 6c)" \
  || bad "economy.override.json 이 리허설 볼륨에 없다 — 런북 P2-13 tar 목록 확인"

verify_untouched

say "결과"
if [ "$ERR" -gt 0 ]; then printf "${R}FAIL${N}  %d 건\n" "$ERR"; exit 1; fi
printf "${G}OK${N}  런북 P2~P3 가 같은 머신에서 재현됐다. 정리: bash infra/rehearse-move.sh --clean\n"
