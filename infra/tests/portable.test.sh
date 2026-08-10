#!/usr/bin/env bash
# AC1.1 계약 — OS 분기 공통 유틸 + 소비처 3곳 배선 (#472 W1)
#
# 왜 이 파일이 있나: 이 리포의 infra 스크립트는 mac 에서만 돌아 본 적이 있다.
#   - `sed -i ''` = BSD 전용. GNU(리눅스)에서는 '' 를 **스크립트로 읽어** 첫 인자를 삼키고 실패한다.
#   - `/Users/...` 하드코딩 = mac 홈 경로 전제. 리눅스 체크아웃(/home, /opt, /srv)에서 관측이 빈값.
# 이사(#472)의 전제는 "같은 스크립트가 두 OS 에서 같게 돈다" 이므로, 그 성질을 계약으로 박는다.
#
# 실행: bash infra/tests/portable.test.sh          (mac 직접)
#       docker run --rm -v "$PWD":/w -w /w debian:stable-slim bash infra/tests/portable.test.sh
# 판정: exit code. 실패 1건이라도 있으면 exit 1.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ✓ %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  ✗ %s\n' "$1"; }
head_() { printf '\n[%s] %s\n' "$1" "$2"; }

printf '=== AC1.1 portable.sh 계약 (OS=%s) ===\n' "$(uname -s)"

# ── T0: 유틸이 존재하고 source 가능한가 ────────────────────────────────
head_ T0 "공통 유틸 존재·로드"
if [ -f infra/lib/portable.sh ]; then
  ok "infra/lib/portable.sh 존재"
  # shellcheck source=/dev/null
  if . infra/lib/portable.sh 2>/dev/null; then ok "source 성공"; else bad "source 실패"; fi
else
  bad "infra/lib/portable.sh 없음 — 유틸 미신설"
fi

# ── T1: sed_i 가 제자리 치환하고 백업 잔재를 남기지 않는다 ─────────────
# BSD 는 `-i ''`, GNU 는 `-i` 만 받는다. 잘못 쓰면 GNU 에서 `.env''` 같은 파일이 생기거나
# (또는 sed 가 첫 인자를 스크립트로 먹고) 원본이 안 바뀐다. 둘 다 여기서 잡는다.
head_ T1 "sed_i 제자리 치환 + 백업 잔재 0"
TD=$(mktemp -d)
trap 'rm -rf "$TD"' EXIT
printf 'A=1\nWEB_ORIGINS=https://old.example.com\nB=2\n' > "$TD/.env"
if command -v sed_i >/dev/null 2>&1; then
  NEW="https://hmb-online.pages.dev,https://x-y-z.trycloudflare.com"
  if sed_i "s|^WEB_ORIGINS=.*|WEB_ORIGINS=$NEW|" "$TD/.env" 2>"$TD/err"; then
    got=$(grep -E '^WEB_ORIGINS=' "$TD/.env" | cut -d= -f2-)
    [ "$got" = "$NEW" ] && ok "치환됨: $got" || bad "치환 실패: '$got' (기대 '$NEW')"
    # 다른 줄이 살아있는가(첫 인자 삼킴 사고 검출)
    grep -q '^A=1$' "$TD/.env" && grep -q '^B=2$' "$TD/.env" \
      && ok "인접 줄 보존" || bad "인접 줄 손상 — sed 인자 파싱 사고"
    # 백업 잔재 (BSD 의 `-i .bak`, GNU 의 `-i''` 오용 산물 등)
    leftovers=$(find "$TD" -mindepth 1 ! -name '.env' ! -name 'err' | wc -l | tr -d ' ')
    [ "$leftovers" = "0" ] && ok "백업파일 잔재 0" || { bad "잔재 $leftovers 건"; find "$TD" -mindepth 1 ! -name '.env' ! -name err; }
  else
    bad "sed_i 실행 실패: $(cat "$TD/err")"
  fi
else
  bad "sed_i 함수 미정의"
fi

# ── T2: 체크아웃 경로 추출이 OS 홈 규약에 안 묶인다 ────────────────────
head_ T2 "executor 체크아웃 경로 추출 (mac/linux 공통)"
if command -v checkout_from_cmdline >/dev/null 2>&1; then
  m=$(printf 'node /Users/peter.park/spider2/hmb-online/packages/server/dist/executor-main.js\n' | checkout_from_cmdline)
  l=$(printf 'node /home/ubuntu/hmb/hmb-online/packages/server/dist/executor-main.js\n' | checkout_from_cmdline)
  o=$(printf 'node /opt/hmb-online/packages/server/dist/executor-main.js\n' | checkout_from_cmdline)
  [ "$m" = "/Users/peter.park/spider2/hmb-online" ] && ok "mac: $m"   || bad "mac 추출 '$m'"
  [ "$l" = "/home/ubuntu/hmb/hmb-online" ]          && ok "linux: $l" || bad "linux 추출 '$l' (빈값이면 /Users 전제 잔존)"
  [ "$o" = "/opt/hmb-online" ]                      && ok "opt: $o"   || bad "opt 추출 '$o'"
else
  bad "checkout_from_cmdline 함수 미정의"
fi

# ── T3: 소비처 3곳에 비이식 패턴이 남아있지 않다 (grep 계약) ───────────
# ⚠️ 이식 계층(lib/portable.sh) 자신은 제외한다 — OS 분기를 **담는 것이 그 파일의 일**이라
#    거기 있는 `sed -i ''` 는 결함이 아니라 수정 그 자체다. 제외가 결함을 숨기지 않도록
#    T3b 가 "양 분기가 실제로 있다"를 역으로 단언한다(BSD 경로가 조용히 사라지면 red).
head_ T3 "소비처 배선 — 비이식 패턴 잔존 0 (이식 계층 제외)"
EXCL='infra/tests/|infra/lib/portable.sh'
# ⚠️ **주석은 제외한다 — 처방 형태만 문다.** 결함은 `sed -i ''` 를 *실행*하는 것이지 그 문자열을
#    *언급*하는 것이 아니다. 오히려 "예전에 이래서 깨졌다" 는 이력 주석은 남아야 다음 사람이
#    되돌리지 않는다(AC1.2 T2 · AC2.3 T3c 에서 같은 판단을 이미 내렸다).
#    제외의 대가는 바로 아래 변이 확인이 치른다 — 실제 명령을 되살리면 여전히 red 다.
scan_sed(){ grep -rn "sed -i ''" infra/ --include='*.sh' 2>/dev/null | grep -Ev "$EXCL" | grep -vE '^[^:]+:[0-9]+: *#'; }
n=$(scan_sed | wc -l | tr -d ' ')
[ "$n" = "0" ] && ok "BSD 전용 \`sed -i ''\` 처방 0건" || { bad "\`sed -i ''\` 처방 $n 건 잔존"; scan_sed; }

n=$(grep -rn "/Users/" infra/ --include='*.sh' 2>/dev/null | grep -Ev "$EXCL" | wc -l | tr -d ' ')
[ "$n" = "0" ] && ok "\`/Users/\` 하드코딩 0건" || { bad "\`/Users/\` $n 건 잔존"; grep -rn "/Users/" infra/ --include='*.sh' | grep -Ev "$EXCL"; }

# ── T3c: 문서도 소비처다 (#472 AC2.3) ─────────────────────────────────
# ⚠️ 운영자는 스크립트가 아니라 **플레이북을 복사해 붙여넣는다.** 그래서 스크립트만 이식하고
#    문서에 비이식 명령이 남아 있으면 결함은 그대로 살아 있다 — 실제로 그랬다:
#      · `deploy-playbook.md:301,313` → `cd ~/spider10/hmb-online` (새 머신엔 그 경로가 없다)
#      · `:304,442` → `sed -i ''` (리눅스에서 첫 표현식을 삼킨다)
#    **처방 형태**만 본다(코드블록의 명령). "예전엔 이랬다" 는 산문 주석은 남겨야 다음 사람이
#    되돌리지 않는다 — AC1.2 T2 와 같은 판단이다.
head_ T3c "문서(plan-v4) 의 비이식 처방 0"
DOCS='docs/plan-v4/deploy-playbook.md'
n=$(grep -nE '^[^#]*(cd|source|\.) +[~"$]*[^ ]*spider[0-9]+/hmb-online' $DOCS 2>/dev/null | wc -l | tr -d ' ')
[ "$n" = "0" ] && ok "체크아웃 경로 하드코딩 0건" \
  || { bad "spiderN 경로 처방 $n 건 — 새 머신에서 그대로 붙여넣으면 실패"; grep -nE 'spider[0-9]+/hmb-online' $DOCS; }
n=$(grep -n "sed -i ''" $DOCS 2>/dev/null | grep -v '⚠️\|BSD 전용이라' | wc -l | tr -d ' ')
[ "$n" = "0" ] && ok "BSD 전용 \`sed -i ''\` 처방 0건" \
  || { bad "\`sed -i ''\` 처방 $n 건 잔존"; grep -n "sed -i ''" $DOCS; }

# ── T3d: 자산 백업 tar 에 economy.override.json (#472 AC2.3) ───────────
# 조사가 실제로 잡은 누락이다(`:620-621` 이 notice-assets char-bundles 만 잡았다).
# 빠지면 initialGems 12000 운영조정이 소멸하고 구운 발행물로 돌아간다 — 화면은 멀쩡하고
# 숫자만 틀리는 무음 장애라, 백업/복원 **양쪽 다** 걸어야 의미가 있다.
head_ T3d "플레이북 자산 tar 에 economy.override.json (백업·복원 양쪽)"
grep -q 'tar czf .*notice-assets char-bundles economy.override.json' $DOCS \
  && ok "백업 tar 에 포함" || bad "백업 tar 누락 — initialGems 운영조정이 이사에서 소멸한다"
grep -q 'chown -R 10001:999 .*economy.override.json' $DOCS \
  && ok "복원 chown 에 포함" || bad "복원에서 economy 소유권 누락 — java(10001) 가 못 읽는다"

head_ T3b "이식 계층이 양 OS 분기를 실제로 보유 (제외의 대가 지불)"
grep -q "sed -i ''" infra/lib/portable.sh 2>/dev/null \
  && ok "BSD 분기 존재" || bad "BSD 분기 소실 — mac 에서 sed_i 가 깨진다"
grep -qE 'sed -i "\$@"' infra/lib/portable.sh 2>/dev/null \
  && ok "GNU 분기 존재" || bad "GNU 분기 소실 — 리눅스에서 sed_i 가 깨진다"

# 소비처가 유틸을 실제로 로드하는가 (선언만 하고 안 쓰는 사문화 방지)
for f in infra/deploy-pages.sh infra/deploy-quicktunnel.sh infra/status.sh; do
  grep -q 'lib/portable.sh' "$f" && ok "$(basename "$f"): 유틸 로드" || bad "$(basename "$f"): 유틸 미로드"
done

# ── T4: 소비처가 실제로 GNU sed 아래에서 도는가 (문법 파싱) ────────────
head_ T4 "소비처 스크립트 문법 (현 OS 의 bash 로 파싱)"
for f in infra/deploy-pages.sh infra/deploy-quicktunnel.sh infra/status.sh infra/lib/portable.sh; do
  [ -f "$f" ] || { bad "$f 없음"; continue; }
  bash -n "$f" 2>"$TD/synerr" && ok "$(basename "$f"): syntax ok" || bad "$(basename "$f"): $(cat "$TD/synerr")"
done

printf '\n=== 결과: PASS=%d FAIL=%d ===\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ]
