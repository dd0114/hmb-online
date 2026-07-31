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
for t in "hmb/server-java:prev-live $PREV_JAVA" "hmb/servants:prev-live $PREV_RUNNER"; do
  tag="${t%% *}"; want="${t##* }"
  got="$(docker image inspect "$tag" --format '{{.Id}}' 2>/dev/null || echo MISSING)"
  if [ "$got" = "sha256:$want" ]; then echo "   ✓ $tag = ${want:0:12}…"
  else echo "   ✗ $tag = $got (기대 sha256:${want:0:12}…) — 롤백 불가, 중단"; exit 1; fi
done

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
