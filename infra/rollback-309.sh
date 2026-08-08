#!/usr/bin/env bash
# 배포 v3.09(engine@0.28.0) → v3.08(engine@0.23.0) 롤백. hero 지시가 오면 그대로 실행한다.
#
#   bash infra/rollback-309.sh --check     # 아무것도 안 바꾸고 준비상태만 점검(기본값)
#   bash infra/rollback-309.sh --go        # 실제 롤백
#   bash infra/rollback-309.sh --go --web  # 백엔드 롤백 + web 도 v3.08 SHA 로 재빌드/재배포
#
# ⚠️ 왜 스크립트인가: 되돌리기도 **와이어 포맷 파괴**다(0.28.0 → 0.23.0 도 방향만 반대일 뿐
#    같은 #241). 손으로 치면 진행 중 매치 확인을 건너뛰기 쉬워서 가드를 코드에 박았다.
# ⚠️ DB 복원은 없다 — v3.09 는 마이그레이션 0건이라 스키마가 안 바뀌었다(Flyway v35 유지).
#    그래서 이미지만 되돌리면 끝이고, 백업(pre-deploy309-…)은 쓸 일이 없다.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

MODE="${1:---check}"
WEB="${2:-}"
PREV_JAVA=af3e0bcb247dd5dccb7c9cc881ffbad434f103bb3da1a444c6d33d8aa2280547
PREV_RUNNER=7f73d3154d1ffb2a8bb966afa7a36f641603b07010a54e30eaa30e80f03a0e28
V308_SHA=4782f54

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "1) 롤백 이미지 고정 확인"
MISS=0; BAD=0
for t in "hmb/server-java:prev-live $PREV_JAVA" "hmb/servants:prev-live $PREV_RUNNER"; do
  tag="${t%% *}"; want="${t##* }"
  got="$(docker image inspect "$tag" --format '{{.Id}}' 2>/dev/null || echo MISSING)"
  if [ "$got" = "sha256:$want" ]; then echo "   ✓ $tag = ${want:0:12}…"
  elif [ "$got" = "MISSING" ]; then echo "   ✗ $tag 없음"; MISS=$((MISS+1))
  else echo "   ✗ $tag = $got (기대 sha256:${want:0:12}…)"; BAD=$((BAD+1)); fi
done

# ⚠️ **이사(#472) 후 이 스크립트는 사문화된다 — 그 사실을 명시하고 끝낸다.**
# PREV_JAVA/PREV_RUNNER 는 **구 머신의 로컬 도커에만** 있는 이미지 다이제스트다. 레지스트리에
# push 된 적이 없으므로 새 머신에는 원리적으로 존재하지 않는다. 그런데 이전 판의 종료 문구는
# "롤백 불가, 중단" 뿐이라, 새 머신 운영자가 **장애 중에** 이걸 보면 "롤백 자산이 깨졌다" 로
# 읽고 복구를 시도하며 시간을 태운다. 실제 상태는 "이 스크립트가 그 머신에서 무의미하다" 이고,
# 그때 필요한 것은 이 스크립트가 아니라 **다른 경로**(아래 안내)다.
# 두 이미지가 **모두** 없으면 = 이사한 머신. 하나만 어긋나면 = 진짜 이상(구 머신에서 훼손).
if [ "$MISS" = 2 ]; then
  say "⛔ 이 머신에서 rollback-309.sh 는 **사문화**다 (이사 후 정상)"
  cat <<'EOS'
   이유: v3.08 롤백 이미지는 구 머신 로컬 도커에만 있던 다이제스트다(레지스트리 미push).
         이사한 머신에는 존재할 수 없다 — 훼손이 아니라 **이 스크립트의 전제가 사라진 것**이다.
   지금 롤백이 필요하다면 이 스크립트가 아니라:
     1) docs/deploy-log.md 에서 되돌릴 대상 SHA 를 고르고
     2) 그 SHA 로 이미지를 재빌드(cd infra && docker compose build java runner)
     3) docker compose up -d java runner
   ⚠️ 이 스크립트는 v3.09→v3.08 **한 지점 전용**이다. 이사 후에는 삭제하거나,
      새 머신 기준으로 다이제스트를 다시 고정하고 나서 쓴다.
EOS
  exit 2   # 1(진짜 실패)과 구분되는 코드 — 자동화가 "사문화" 를 장애로 오독하지 않게.
fi
[ $((MISS + BAD)) -gt 0 ] && { echo "   → 롤백 불가, 중단"; exit 1; }

say "2) 진행 중 매치 확인 (역방향 #241 — 되돌려도 하프 경계 매치는 끊긴다)"
INPROG="$(docker run --rm -v hmb-p3-db:/data:ro alpine:3.20 sh -c \
  "apk add --no-cache sqlite >/dev/null 2>&1 && sqlite3 'file:/data/hmb.db?mode=ro' \
   \"SELECT id||' '||state||' '||COALESCE(phase_ends_at,'-') FROM matches \
     WHERE state NOT IN ('FINISHED','FAILED','ABANDONED')\"" || true)"
if [ -z "$INPROG" ]; then
  echo "   ✓ 진행 중 매치 0건 — 즉시 전환 가능"
else
  echo "   ⚠️ 진행 중 매치 있음:"; echo "$INPROG" | sed 's/^/      /'
  echo "      → 잔여가 짧으면 끝나길 기다리고(v3.09 배포 때 145초 기다려 절단 0건),"
  echo "        길거나 급하면 그대로 진행(#217 ABANDONED 가 회수 안전망)."
  if [ "$MODE" = "--go" ]; then
    read -r -p "      계속할까? (yes/no) " a; [ "$a" = "yes" ] || { echo "중단"; exit 1; }
  fi
fi

say "3) 현재 라이브"
docker inspect hmb-java   --format '   java   {{.Image}}'
docker inspect hmb-runner --format '   runner {{.Image}}'

if [ "$MODE" != "--go" ]; then
  say "점검 모드 — 아무것도 바꾸지 않았다. 실행하려면: bash infra/rollback-309.sh --go"
  exit 0
fi

say "4) 이미지 되돌리고 재기동"
docker tag hmb/server-java:prev-live hmb/server-java:p3
docker tag hmb/servants:prev-live    hmb/servants:p3
set -a; . infra/.env; set +a
( cd infra && docker compose up -d java runner )
until [ "$(docker inspect -f '{{.State.Health.Status}}' hmb-java 2>/dev/null)" = healthy ]; do sleep 3; done

say "5) 확인"
docker inspect hmb-java   --format '   java   {{.Image}}'
docker inspect hmb-runner --format '   runner {{.Image}}'
docker logs hmb-java --tail 30 2>&1 | grep -E "Current version of schema|No migration|Started Application" | sed 's/^/   /'
curl -s http://localhost:18790/health 2>/dev/null | head -c 200; echo

if [ "$WEB" = "--web" ]; then
  say "6) web 을 v3.08($V308_SHA) 로 되돌려 재배포"
  echo "   ⚠️ apps/web 소스는 v3.08↔v3.09 가 동일하다(변경 0). 되돌리는 실익은 version.json 표기뿐이고,"
  echo "      백엔드만 롤백해도 화면은 정상 동작한다. 급하면 이 단계는 나중에 해도 된다."
  git stash list >/dev/null
  git checkout -q "$V308_SHA" -- apps/web packages/shared
  bash infra/deploy-pages.sh "$(curl -s https://hmb-online.pages.dev/config.json | python3 -c 'import sys,json;print(json.load(sys.stdin)["apiBase"])')"
  git checkout -q HEAD -- apps/web packages/shared
else
  say "6) web 은 건드리지 않았다"
  echo "   apps/web 소스가 v3.08↔v3.09 동일이라 번들은 사실상 같다. 다만 version.json 은"
  echo "   계속 8ac6245/engine@0.28.0 으로 보인다 — 백엔드와 어긋나므로 롤백을 유지할 거면"
  echo "   --web 으로 한 번 더 돌려 표기를 맞춘다."
fi

say "롤백 완료 — docs/deploy-log.md 에 [롤백] 항목을 append 하고 push 할 것(§0.8: main 계보)."
