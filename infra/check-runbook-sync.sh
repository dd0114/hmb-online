#!/usr/bin/env bash
# 런북 ↔ 스크립트 싱크 검사 (#472 AC2.4)
#
#   bash infra/check-runbook-sync.sh
#
# 왜 있나: 런북은 **정지 창 안에서 그대로 붙여넣는 문서**다. 그 안의 명령이 스크립트와 어긋나면
# 어긋난 사실을 **가장 나쁜 순간에** 알게 된다. 그런데 스크립트는 계속 바뀌고 문서는 안 바뀐다 —
# 이 리포는 그 부류를 이미 세 번 겪었다(플레이북의 `~/spider10` 경로 · `sed -i ''` · 자산 tar 의
# economy 누락). 세 번 다 "사람이 문서를 갱신한다" 로는 안 막혔다.
#
# 그래서 기계가 대조한다:
#   1. 런북이 부르는 **스크립트 파일이 실재**하는가
#   2. 런북이 쓰는 **플래그를 그 스크립트가 실제로 받는가**(오타·구 플래그)
#   3. 이사 함정 4종이 런북에 **스텝으로** 남아 있는가 (#472 AC2.2)
# 읽기 전용. 아무것도 바꾸지 않는다.
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

RB="${HMB_RUNBOOK:-docs/plan-v4/migration-runbook.md}"
G='\033[32m'; R='\033[31m'; Y='\033[33m'; N='\033[0m'
ok(){   printf "  ${G}✓${N} %s\n" "$1"; }
bad(){  printf "  ${R}✗${N} %s\n" "$1"; ERR=$((ERR+1)); }
ERR=0

[ -f "$RB" ] || { printf "${R}런북이 없다: %s${N}\n" "$RB"; exit 1; }
echo "════════ 런북 ↔ 스크립트 싱크 ════════"
echo "런북: $RB"

# ── 1) 참조된 스크립트가 실재하는가 ───────────────────────────────────
echo ""
echo "── 참조 경로 ──"
miss=""; gen=""
for p in $(grep -oE '\b(infra|docs|server-java|packages)/[A-Za-z0-9._/-]+\.(sh|md|json|yml|java|ts|mjs)' "$RB" \
            | sed 's/[.,)]*$//' | sort -u); do
  # `deploy-playbook.md:622` 같은 라인참조는 파일명까지만 본다.
  [ -e "$p" ] && continue
  # ⚠️ gitignore 된 경로는 **런타임 산출물**이다(deploy-manifest.json·.env 등). fresh 체크아웃에
  #    없는 것이 정상이고, 런북이 그걸 참조하는 것도 정상이다(구 머신에서 읽는다).
  #    그래서 "없음"을 곧바로 드리프트로 세지 않되, **조용히 넘기지도 않는다** — 목록으로 남긴다.
  #    (오타난 경로는 gitignore 에 안 걸리므로 여전히 잡힌다.)
  if git check-ignore -q "$p" 2>/dev/null; then gen="$gen $p"; else miss="$miss $p"; fi
done
[ -z "$miss" ] && ok "참조 경로 전부 실재" || bad "실재하지 않는 경로:$miss"
[ -n "$gen" ] && printf "  ${Y}!${N} 런타임 산출물(gitignore, 체크아웃엔 없음):%s\n" "$gen"

# ── 2) 플래그가 실제로 먹히는가 ───────────────────────────────────────
# 런북 한 줄에서 `infra/foo.sh … --bar` 를 뽑아, foo.sh 가 --bar 를 파싱하는지 본다.
#
# ⚠️ **이 검사는 한 번 뚫렸다**(#472 sk2 소수의견). 옛 정규식은 파일 전체에서 그 리터럴을 찾아
#    `(^|[[:space:]|(])--flag[)|[:space:]]` 로 봤는데, 그러면 **산문이 검사를 만족시킨다** —
#    사용법 주석의 `--no-claude`, 안내문 `note "…(--no-claude)…"`, `echo "사용: […|--go|…]"` 가
#    전부 통과한다. 실제 변이로 확인됐다: `pack-move.sh` 의 **진짜 case 분기**를
#    `--no-claude)` → `--skip-claude)` 로 갈아도 이 검사는 green 이고, 런북대로 실행하면
#    `알 수 없는 인자` **exit 64** 가 난다 — 그것도 **정지 창 안(P0-4)** 에서.
#    검사의 pass 조건("플래그 미스 0")이 정확히 그 사고를 막겠다는 약속이었으므로 구멍이었다.
#
# 그래서 **처방 형태**로 앵커한다 — 언급이 아니라 *받는 코드*만 센다:
#   ⓐ 주석을 걷어낸다(이력·사용법 주석은 남아야 하지만, 통과 근거가 되면 안 된다)
#   ⓑ `case` 분기 **패턴 자리**에서만 찾는다(줄머리 → `|` 로 이어진 패턴 목록 → `)`)
#   ⓒ `[ "$1" = "--flag" ]` 형태의 비교도 인정한다(파싱 방식이 case 가 아닐 수 있다)
# 문자열 안의 언급은 줄머리 앵커에 걸려 ⓑ 를 통과하지 못한다(usage 문자열 `[--a|--b]` 포함).
echo ""
echo "── 플래그 ──"
accepts_flag(){ # <스크립트> <--플래그> → 인자 파싱부가 실제로 받으면 0
  local body; body=$(sed 's/#.*//' "$1")
  printf '%s\n' "$body" | grep -qE "^[[:space:]]*\(?([^|)]*\|)*[[:space:]]*$2[[:space:]]*(\||\))" && return 0
  printf '%s\n' "$body" | grep -qE "==?[[:space:]]*\"?$2\"?" && return 0
  return 1
}
badflag=""
while IFS= read -r line; do
  script=$(printf '%s' "$line" | grep -oE 'infra/[A-Za-z0-9._-]+\.sh' | head -1)
  [ -n "$script" ] && [ -f "$script" ] || continue
  for fl in $(printf '%s' "$line" | grep -oE ' --[a-z][a-z0-9-]*' | tr -d ' ' | sort -u); do
    accepts_flag "$script" "$fl" || badflag="$badflag ${script}${fl}"
  done
done < <(grep -E 'infra/[A-Za-z0-9._-]+\.sh' "$RB")
[ -z "$badflag" ] && ok "플래그 미스 0 (case 분기·비교문 기준 — 산문 언급은 근거로 안 센다)" \
  || bad "스크립트가 받지 않는 플래그:$badflag"

# ── 3) 이사 함정 4종이 스텝으로 남아 있는가 (#472 AC2.2) ──────────────
# 이 넷은 **조사에서 실제로 발견된** 함정이다. 문서를 줄이다가 조용히 빠지는 것을 막는다.
echo ""
echo "── 함정 4종 ──"
trap_check(){ # <라벨> <정규식> <빠졌을 때의 사고>
  grep -qE "$2" "$RB" && ok "$1" || bad "$1 누락 — $3"
}
trap_check "① 구 머신 워치독 정지" \
  'install-tunnel-heal\.sh --uninstall' \
  "구 머신 워치독이 터널을 되살려 config.json 을 되돌린다(배포 락은 머신 간 공유 안 됨)"
trap_check "② economy.override.json 이송" \
  'economy\.override\.json' \
  "initialGems 운영조정이 소멸하고 구운 발행물로 돌아간다(무음 장애)"
trap_check "③ chown 이 디렉토리까지" \
  'chown -R 10001:999 /data' \
  "파일만 chown 하면 java 가 WAL 을 못 만든다(v3.19 실패 사례)"
trap_check "④ 스왑 후 롤백 = 쓰기 유실" \
  '쓰기를 잃는다|쓰기 유실' \
  "P4 이후 되돌리면 신 DB 의 쓰기가 사라지는데 그걸 모르고 롤백한다"

# ── 4) 파괴적 명령 금지 문구 ──────────────────────────────────────────
echo ""
echo "── 안전장치 ──"
grep -qE '`down -v` 금지|down -v.*금지' "$RB" \
  && ok "\`down -v\` 금지 명시" || bad "\`down -v\` 경고 없음 — 볼륨 삭제 = DB 소멸"
grep -q 'pkill -f' "$RB" && grep -qE 'pkill -f.*금지' "$RB" \
  && ok "pkill -f 금지 명시" || bad "PID 종료 규칙 없음 — pkill -f 는 다른 세션 스택을 죽인다"

echo "═══════════════════════════════════"
if [ "$ERR" -gt 0 ]; then printf "${R}FAIL${N}  불일치 %d 건\n" "$ERR"; exit 1; fi
printf "${G}OK${N}  런북과 스크립트가 일치한다\n"
