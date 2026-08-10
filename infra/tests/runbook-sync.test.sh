#!/usr/bin/env bash
# AC2.4 계약 — 런북↔스크립트 싱크 검사가 **드리프트를 실제로 잡는가** (#472)
#
# 왜 이 파일이 있나: 검사기 자체가 한 번 뚫렸다. 옛 탐지는 파일 전체에서 플래그 리터럴을 찾아서,
# **사용법 주석에 이름만 남아 있으면** 진짜 인자 파싱부를 갈아도 green 이었다. 그 상태로
# 런북대로 실행하면 `알 수 없는 인자` exit 64 — 그것도 **정지 창 안(P0-4)** 에서 난다.
#
# 검사기의 pass 조건("플래그 미스 0")이 정확히 그 사고를 막겠다는 약속이므로,
# 여기서는 **그 약속을 변이로 검정한다**: 진짜 case 분기를 갈면 red 여야 하고,
# 산문이 그대로 남아 있어도 그 red 를 되돌리지 못해야 한다.
#
# 실행: bash infra/tests/runbook-sync.test.sh      판정: exit code
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ✓ %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  ✗ %s\n' "$1"; }

TARGET=infra/pack-move.sh
CHECKER=infra/check-runbook-sync.sh
echo "=== AC2.4 싱크 검사기 변이 계약 ==="

md5_of(){ md5 -q "$1" 2>/dev/null || md5sum "$1" 2>/dev/null | awk '{print $1}'; }
BEFORE=$(md5_of "$TARGET")
BACKUP=$(mktemp); cp "$TARGET" "$BACKUP"
# ⚠️ 어떤 경로로 끝나든 원본을 되돌린다 — 변이가 트리에 남으면 다음 세션이 그것을 코드로 읽는다.
restore(){ cp "$BACKUP" "$TARGET"; rm -f "$BACKUP"; }
trap restore EXIT

# ── T0: 하네스 생존 — 변이가 없으면 green 이어야 한다 ──────────────────
# 이걸 먼저 안 보면 "전부 죽었다" 가 사실은 "검사기가 항상 red" 였을 수 있다.
printf '\n[T0] 무변이 기준선\n'
if bash "$CHECKER" >/dev/null 2>&1; then ok "무변이에서 검사기 green (하네스 생존)"
else bad "무변이인데 red — 이 상태의 변이 결과는 아무것도 증명하지 못한다"; fi

# ── T1: 진짜 인자 파싱부를 갈면 red ────────────────────────────────────
printf '\n[T1] case 분기 리네임 변이 (--no-claude → --skip-claude)\n'
if ! grep -qE '^[[:space:]]*--no-claude\)' "$TARGET"; then
  bad "변이 대상 case 분기를 못 찾았다 — 이 테스트는 대상이 바뀌면 조용히 무력해진다"
else
  sed -i.bak 's/^\([[:space:]]*\)--no-claude)/\1--skip-claude)/' "$TARGET" && rm -f "$TARGET.bak"
  # 변이가 **실제로 주입됐는지** 확인한다(주입 실패를 "죽였다"로 오독하지 않기 위해).
  if grep -qE '^[[:space:]]*--skip-claude\)' "$TARGET" && ! grep -qE '^[[:space:]]*--no-claude\)' "$TARGET"; then
    ok "변이 주입 확인"
    out=$(bash "$CHECKER" 2>&1); rc=$?
    [ "$rc" -ne 0 ] && ok "검사기 red (exit $rc) — 드리프트를 잡았다" \
      || bad "검사기가 여전히 green — 산문이 통과시키고 있다(옛 구멍 재현)"
    printf '%s' "$out" | grep -q -- '--no-claude' \
      && ok "메시지가 어느 플래그인지 지목한다" || bad "어느 플래그인지 안 알려준다"
    # 이 red 가 **산문이 사라져서** 난 것이 아님을 못 박는다 — 사용법 주석은 그대로다.
    grep -q -- '--no-claude' "$TARGET" \
      && ok "산문(사용법 주석)의 --no-claude 는 그대로인데도 red — 앵커가 형태를 본다" \
      || bad "산문까지 지워졌다 — 그러면 이 변이는 앵커를 검정하지 못한다"
    # 그리고 그 드리프트는 실제로 런북을 깨뜨린다(계약의 존재 이유).
    bash "$TARGET" --dry-run --no-claude >/dev/null 2>&1
    [ $? -eq 64 ] && ok "런북 명령이 exit 64 — 잡지 못하면 정지 창에서 터진다" \
      || bad "exit 64 가 아니다 — 변이의 실제 영향이 달라졌으니 계약을 재설계할 것"
  else
    bad "변이 주입 실패 — 이후 판정은 무효"
  fi
fi

# ── T2: 원본 복구 ──────────────────────────────────────────────────────
printf '\n[T2] 복구\n'
restore; trap - EXIT
AFTER=$(md5_of "$TARGET")
[ "$BEFORE" = "$AFTER" ] && ok "md5 원상복구 ($BEFORE)" || bad "복구 실패 — 트리에 변이가 남았다"

printf '\n=== 결과: PASS=%d FAIL=%d ===\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ]
