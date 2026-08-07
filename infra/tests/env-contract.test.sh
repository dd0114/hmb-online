#!/usr/bin/env bash
# AC1.2 계약 — env 키셋 계약 파일 + 드리프트 검사기 (#472 W1)
#
# 왜 이 파일이 있나: 이사는 "코드를 옮기는 일"이 아니라 **키를 옮기는 일**이다. 그런데 지금
# 이 리포에는 "백엔드가 무슨 env 를 먹는가" 의 권위 목록이 없고, 유일한 후보인 .env.example 이
# 실제 소비처와 어긋나 있다. 실측된 두 부류(둘 다 이사 치명):
#   1. **이름 드리프트** — .env.example 은 `HMB_ADMIN_USERNAME` 을 문서화하는데 코드가 읽는 것은
#      `HMB_ADMIN_NICKNAME` 이다(application.yml:112). 예시대로 .env 를 다시 만들면 nickname 은
#      비고 password 만 차므로, application.yml:110 의 "하나만 채우면 부팅 실패" 에 그대로 걸린다.
#      → 새 머신에서 **java 가 안 뜬다**.
#   2. **보이지 않는 키** — `HMB_MATCH_AIJOBTIMEOUTSEC` 는 Spring relaxed binding 으로
#      `hmb.match.ai-job-timeout-sec` 에 꽂히므로 application.yml 을 `grep '${HMB_'` 해도 안 나오고,
#      .env.example·compose 어디에도 없다. 라이브 .env 에만 600 으로 있고 코드 기본값은 240 이다
#      (#166 완화, docs/deploy-log.md). 이사하며 조용히 떨어지면 **매치가 다시 FAILED 된다**.
#
# 그래서 계약을 리포 안에 둔다(값이 아니라 **키 이름만**) — 남의 세션 시크릿 파일을 읽지 않고도
# 검증되게. 검사기는 값을 절대 출력하지 않는다(T7 이 카나리아로 그 성질을 검정한다).
#
# 실행: bash infra/tests/env-contract.test.sh
# 판정: exit code. 실패 1건이라도 있으면 exit 1.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ✓ %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  ✗ %s\n' "$1"; }
head_() { printf '\n[%s] %s\n' "$1" "$2"; }

CONTRACT=infra/env-contract.txt
CHECKER=infra/check-env-contract.sh
EXAMPLE=infra/.env.example
COMPOSE=infra/docker-compose.yml

TD=$(mktemp -d); trap 'rm -rf "$TD"' EXIT

printf '=== AC1.2 env 키셋 계약 ===\n'

# 계약에서 키 이름만 뽑는다(주석·빈줄 제외, 1번째 필드).
keys_of_contract() { grep -vE '^\s*(#|$)' "$CONTRACT" 2>/dev/null | awk '{print $1}'; }

# ── T0: 계약 파일이 존재하고 파싱된다 ─────────────────────────────────
head_ T0 "계약 파일 존재·파싱"
if [ -f "$CONTRACT" ]; then
  ok "$CONTRACT 존재"
  n=$(keys_of_contract | wc -l | tr -d ' ')
  [ "${n:-0}" -ge 11 ] && ok "키 $n 개 파싱(≥11)" || bad "키 $n 개 — 권위 키셋 미달(≥11 기대)"
  # 2번째 필드 = 등급. req(없으면 못 뜬다) / opt(기본값 있음) / carry(기본값과 다른 라이브 운영값 → 이사 시 값까지 이관)
  ngrade=$(grep -vE '^\s*(#|$)' "$CONTRACT" 2>/dev/null | awk '$2!~/^(req|opt|carry)$/' | wc -l | tr -d ' ')
  [ "${ngrade:-1}" = "0" ] && ok "모든 키에 등급(req|opt|carry)" || bad "등급 없는/오타난 키 $ngrade 건"
else
  bad "$CONTRACT 없음 — 권위 키셋 미신설"
fi

# ── T1: 이사에서 실제로 떨어졌을 키가 계약에 있다 ──────────────────────
head_ T1 "이사 치명 키 3종 등재"
for k in HMB_ADMIN_NICKNAME HMB_ADMIN_PASSWORD HMB_MATCH_AIJOBTIMEOUTSEC; do
  keys_of_contract | grep -qx "$k" && ok "$k 등재" || bad "$k 미등재 — 이사 시 조용히 소실된다"
done
# AIJOBTIMEOUTSEC 는 코드 기본값(240)과 라이브(600)가 다르다 → 등급이 carry 여야 한다.
g=$(grep -vE '^\s*(#|$)' "$CONTRACT" 2>/dev/null | awk '$1=="HMB_MATCH_AIJOBTIMEOUTSEC"{print $2}')
[ "$g" = "carry" ] && ok "HMB_MATCH_AIJOBTIMEOUTSEC=carry (값까지 이관 대상)" \
  || bad "등급 '$g' — 코드 기본 240 ≠ 라이브 600 이므로 carry 여야 한다"

# ── T2: .env.example 의 이름 드리프트 해소 ────────────────────────────
head_ T2 ".env.example 이름 드리프트"
# ⚠️ **대입 형태**만 본다(`HMB_ADMIN_USERNAME=`, 주석 처리 포함). 결함은 예시가 잘못된 키를
#    **처방**하는 것이지, 산문에 그 단어가 나오는 것이 아니다 — 오히려 "예전엔 이 이름이었다"는
#    이력 주석은 남겨야 다음 사람이 되돌리지 않는다.
grep -qE '^#? *HMB_ADMIN_USERNAME=' "$EXAMPLE" 2>/dev/null \
  && bad "HMB_ADMIN_USERNAME= 처방 잔존 — 코드는 HMB_ADMIN_NICKNAME 을 읽는다(부팅 실패 유발)" \
  || ok "잘못된 HMB_ADMIN_USERNAME= 처방 0건"
grep -q 'HMB_ADMIN_NICKNAME' "$EXAMPLE" 2>/dev/null \
  && ok "HMB_ADMIN_NICKNAME 문서화됨" || bad "HMB_ADMIN_NICKNAME 미문서화"

# ── T3: 계약 ↔ .env.example 문서화 누락 0 ─────────────────────────────
head_ T3 "계약의 모든 키가 .env.example 에 문서화(주석 자리표시자 허용)"
miss=""
while read -r k; do
  [ -z "$k" ] && continue
  grep -qE "^#? *${k}=" "$EXAMPLE" 2>/dev/null || miss="$miss $k"
done < <(keys_of_contract)
[ -z "$miss" ] && ok "누락 0" || bad "미문서화:$miss"

# ── T4: compose 역드리프트 — ${VAR} 전부 계약에 있다 ──────────────────
# 계약이 리포보다 뒤처지는 방향(누가 compose 에 새 키를 넣고 계약엔 안 넣음)을 잡는다.
head_ T4 "docker-compose 의 \${VAR} 전부 계약에 등재"
unk=""
for v in $(grep -oE '\$\{[A-Z_][A-Z0-9_]*' "$COMPOSE" 2>/dev/null | sed 's/^\${//' | sort -u); do
  keys_of_contract | grep -qx "$v" || unk="$unk $v"
done
[ -z "$unk" ] && ok "미등재 0" || bad "compose 는 쓰는데 계약에 없음:$unk"

# ── T5: 검사기가 깨끗한 .env 를 통과시킨다 ────────────────────────────
head_ T5 "검사기 — 정상 .env 통과"
if [ -f "$CHECKER" ]; then
  ok "$CHECKER 존재"
  # 계약의 req/carry 키를 전부 채운 합성 .env (값은 전부 가짜)
  : > "$TD/clean.env"
  while read -r k g _; do
    case "$g" in req|carry) printf '%s=synthetic-value-%s\n' "$k" "$k" >> "$TD/clean.env";; esac
  done < <(grep -vE '^\s*(#|$)' "$CONTRACT" 2>/dev/null)
  if HMB_ENV_FILE="$TD/clean.env" bash "$CHECKER" > "$TD/clean.out" 2>&1; then
    ok "exit 0"
  else
    bad "exit $? — 정상 .env 를 거부: $(head -3 "$TD/clean.out" | tr '\n' ' ')"
  fi
else
  bad "$CHECKER 없음 — 검사기 미신설"
fi

# ── T6: 검사기가 **미지의 키**를 잡는다 (이사 손실 검출 방향) ──────────
# 라이브 머신에서 이걸 돌리면, 계약이 모르는 키가 .env 에 있을 때 red 가 된다.
# = "옮길 때 빠뜨릴 뻔한 키" 를 이름으로 보여준다. AC1.2 의 존재 이유.
head_ T6 "검사기 — 계약 밖 키 검출"
if [ -f "$CHECKER" ]; then
  cp "$TD/clean.env" "$TD/unknown.env" 2>/dev/null
  printf 'HMB_SOME_UNDOCUMENTED_KNOB=1\n' >> "$TD/unknown.env"
  if HMB_ENV_FILE="$TD/unknown.env" bash "$CHECKER" > "$TD/unk.out" 2>&1; then
    bad "미지의 키를 통과시킴 — 이사 손실을 못 잡는다"
  else
    ok "exit≠0"
    grep -q 'HMB_SOME_UNDOCUMENTED_KNOB' "$TD/unk.out" \
      && ok "키 이름을 보고" || bad "어떤 키인지 안 알려줌 — 조치 불가"
  fi
fi

# ── T7: 검사기가 **값을 절대 출력하지 않는다** ────────────────────────
# 이 스크립트의 출력은 이슈·PR·로그로 흘러간다. 시크릿이 한 번이라도 실리면 그게 사고다.
head_ T7 "검사기 — 값 비노출(카나리아)"
if [ -f "$CHECKER" ]; then
  CANARY='c4n4ry-t0k3n-do-not-print-9z8y7x'
  { printf 'SERVANT_TOKEN=%s\n' "$CANARY"
    printf 'HMB_ADMIN_PASSWORD=%s\n' "$CANARY"
    printf 'HMB_TOTALLY_UNKNOWN=%s\n' "$CANARY"; } > "$TD/secret.env"
  HMB_ENV_FILE="$TD/secret.env" bash "$CHECKER" > "$TD/secret.out" 2>&1
  if grep -q "$CANARY" "$TD/secret.out"; then
    bad "출력에 값이 실렸다 — 시크릿 유출 경로"
  else
    ok "카나리아 값 출력 0건"
  fi
  # 값을 안 찍으면서 키 이름은 찍어야 쓸모가 있다(비노출을 '아무것도 안 찍기'로 달성 금지)
  grep -q 'HMB_TOTALLY_UNKNOWN' "$TD/secret.out" \
    && ok "값 없이 키 이름은 보고" || bad "키 이름조차 안 찍음 — 비노출을 침묵으로 달성"
fi

# ── T8: 계약·예시 파일 자체에 실제 시크릿이 없다 ──────────────────────
head_ T8 "계약·예시에 실 시크릿 0"
n=0
for f in "$CONTRACT" "$EXAMPLE"; do
  [ -f "$f" ] || continue
  # 32자 이상 hex(=openssl rand -hex 32 산물) 또는 CF 토큰 형태
  h=$(grep -cE '=[0-9a-f]{32,}' "$f" 2>/dev/null | tr -d ' ')
  n=$((n + ${h:-0}))
done
[ "$n" = "0" ] && ok "hex 시크릿 패턴 0건" || bad "$n 건 — 실 토큰이 커밋된 것으로 보인다"

# ── T9: 문법 ──────────────────────────────────────────────────────────
head_ T9 "스크립트 문법"
for f in "$CHECKER" infra/tests/env-contract.test.sh; do
  [ -f "$f" ] || { bad "$f 없음"; continue; }
  bash -n "$f" 2>"$TD/syn" && ok "$(basename "$f"): syntax ok" || bad "$(basename "$f"): $(cat "$TD/syn")"
done

printf '\n=== 결과: PASS=%d FAIL=%d ===\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ]
