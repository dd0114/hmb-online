#!/usr/bin/env bash
# #506 계약 — deploy-web.sh 경로도 version.json 을 남긴다 + 엣지가 그것을 캐시하지 못한다.
#
#   bash infra/tests/deploy-web-manifest.test.sh
#
# 왜 이 테스트인가: version.json 을 만드는 배포 경로가 deploy-pages.sh **하나뿐**이라,
# 장애 복구 경로(start-tunnel.sh → deploy-web.sh)로 재배포할 때마다 version.json 이 배포물에서
# 빠졌다. 그런데 엣지가 s-maxage 7일 캐시로 **두 세대 전 매니페스트를 200 으로** 계속 줬다 —
# 실패가 404 가 아니라 그럴듯한 오답이라 조용히 오독된다(#506 실측: age 3.7일, cf-cache HIT).
#
# ⚠️ 이 하네스는 **라이브를 절대 건드리지 않는다**:
#   · `npx`(→wrangler)·`docker`·`curl` 을 PATH 앞의 가짜로 갈아끼운다 — 소켓 0, 배포 0.
#   · 실빌드(npm ci)는 워크트리 node_modules 를 프루닝하므로 **가짜 빌드**를 주입한다
#     (`HMB_BUILD_CMD` — deploy-web.sh 의 테스트 이음매, 기본값은 종전 build.sh 그대로).
#   · STATE_DIR(락)·DIST_CACHE(스냅샷) 전부 스크래치로 격리.
#   · 리포에 남는 산출물은 gitignore 된 것뿐(apps/web/dist, infra/deploy-manifest.json).
#
# 판정은 종료코드와 파일 사실로만 한다.

set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/hmb-506test.XXXXXX")
trap 'rm -rf "$SCRATCH"' EXIT

PASS=0; FAIL=0
G='\033[32m'; R='\033[31m'; N='\033[0m'
check(){ if [ "$2" = "$3" ]; then printf "  ${G}✓${N} %s\n" "$1"; PASS=$((PASS+1))
  else printf "  ${R}✗${N} %s — 기대 '%s' 실제 '%s'\n" "$1" "$2" "$3"; FAIL=$((FAIL+1)); fi }

# ── 가짜 도구 ──────────────────────────────────────────────────────────────────────
BIN="$SCRATCH/bin"; mkdir -p "$BIN"
# npx → wrangler 호출을 가로챈다. **호출 시점의 dist 내용물**을 기록한다 — "배포물에 들어
# 있었나"는 사후 검사로는 못 잡는다(배포 뒤에 파일을 넣어도 사후 검사는 통과한다).
cat > "$BIN/npx" <<EOF
#!/usr/bin/env bash
echo "FAKE-NPX \$*" >> "$SCRATCH/npx.calls"
for a in "\$@"; do
  case "\$a" in apps/web/dist|*/dist) ls "\$a" > "$SCRATCH/dist-at-deploy.ls" 2>/dev/null;; esac
done
exit 0
EOF
# docker/curl → version-manifest.sh 가 부른다. 오프라인에서도 같은 판정이 나야 한다.
printf '#!/usr/bin/env bash\nexit 1\n' > "$BIN/docker"
printf '#!/usr/bin/env bash\nexit 1\n' > "$BIN/curl"
chmod +x "$BIN"/*

# 가짜 빌드 — 실빌드가 만드는 최소 형태(index.html + assets + config.json)만 만든다.
cat > "$SCRATCH/fake-build.sh" <<'EOF'
#!/usr/bin/env bash
set -eu
mkdir -p apps/web/dist/assets
printf '<html></html>' > apps/web/dist/index.html
printf '/* x */' > apps/web/dist/assets/app.js
cp infra/pages/_redirects infra/pages/_headers apps/web/dist/
printf '{"apiBase":"%s"}\n' "${VITE_API_BASE:-}" > apps/web/dist/config.json
EOF
chmod +x "$SCRATCH/fake-build.sh"

BACKEND="https://fake-506-backend.trycloudflare.com"

echo "════════ #506 deploy-web version.json 계약 ════════"
rm -rf apps/web/dist
PATH="$BIN:$PATH" \
HMB_STATE_DIR="$SCRATCH/state" HMB_DIST_CACHE="$SCRATCH/cache" \
HMB_BUILD_CMD="bash $SCRATCH/fake-build.sh" \
bash infra/deploy-web.sh "$BACKEND" > "$SCRATCH/run.out" 2>&1
rc=$?
check "T0 deploy-web.sh 정상 종료" "0" "$rc"

# T1. 배포물에 version.json 이 있다 — 그리고 내용이 이 배포를 가리킨다(스테일 복사가 아니다).
apiurl=$(node -e "try{console.log(require('$PWD/apps/web/dist/version.json').tunnel.apiUrl)}catch(e){console.log('<없음>')}")
check "T1 dist/version.json 의 tunnel.apiUrl = 이번 배포의 백엔드" "$BACKEND" "$apiurl"

# T2. wrangler 가 불린 **그 시점의** dist 에 version.json 이 있었다.
check "T2 배포 시점 dist 에 version.json 포함" "1" "$(grep -c '^version.json$' "$SCRATCH/dist-at-deploy.ls" 2>/dev/null | tr -d ' ')"

# T3. 워치독이 쓰는 스냅샷 캐시에도 남는다 — 이게 없으면 다음 워치독 재배포가 도로 지운다
#     (rsync --delete 라 캐시에 없는 파일은 배포물에서도 사라진다 = 사고 재발 경로).
check "T3 dist 스냅샷 캐시에 version.json 보존" "1" "$([ -f "$SCRATCH/cache/version.json" ] && echo 1 || echo 0)"

# T4. 엣지 캐시 계약 — /version.json 은 no-store. 이게 없으면 고쳐도 다음 7일간 낡은 답이 나온다
#     (#506 실측: s-maxage=604800 · age 3.7일 · cf-cache-status HIT).
hdr_rule=$(awk '/^\/version\.json$/{f=1;next} f&&/Cache-Control/{print "no-store-ok"; exit} f&&/^\//{exit}' infra/pages/_headers | head -1)
check "T4 _headers 에 /version.json Cache-Control 규칙" "no-store-ok" "$hdr_rule"

# T5. 이음매의 기본값은 종전과 같다 — HMB_BUILD_CMD 미지정이면 build.sh 를 부른다(정적 계약).
check "T5 HMB_BUILD_CMD 기본값 = infra/pages/build.sh" "1" "$(grep -c 'HMB_BUILD_CMD:-bash infra/pages/build.sh' infra/deploy-web.sh | tr -d ' ')"

echo "═══════════════════════════════"
echo "PASS $PASS · FAIL $FAIL"
[ "$FAIL" -eq 0 ]
