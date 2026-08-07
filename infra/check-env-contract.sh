#!/usr/bin/env bash
# env 키셋 드리프트 검사 (#472 AC1.2) — 이사 전에 "무엇이 빠졌나" 를 기계로 답한다.
#
#   bash infra/check-env-contract.sh            # infra/.env 대상
#   HMB_ENV_FILE=/path/to/.env bash infra/check-env-contract.sh
#
# 읽기 전용. **값은 절대 출력하지 않는다 — 키 이름만.** (이 출력은 이슈·PR·로그로 흘러간다.)
# 판정: req 누락 / 계약 밖 키 / admin 짝 불일치 → exit 1. carry 누락 → WARN(exit 0).
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

CONTRACT=infra/env-contract.txt
EXAMPLE=infra/.env.example
COMPOSE=infra/docker-compose.yml
ENVFILE="${HMB_ENV_FILE:-infra/.env}"

G='\033[32m'; R='\033[31m'; Y='\033[33m'; N='\033[0m'
ok(){   printf "  ${G}✓${N} %s\n" "$1"; }
bad(){  printf "  ${R}✗${N} %s\n" "$1"; ERR=$((ERR+1)); }
warn(){ printf "  ${Y}!${N} %s\n" "$1"; WRN=$((WRN+1)); }
ERR=0; WRN=0

[ -f "$CONTRACT" ] || { printf "${R}계약 파일 없음: %s${N}\n" "$CONTRACT"; exit 1; }

# 계약 파싱 — 주석/빈줄 제외. (값은 계약에 애초에 없다.)
rows(){ grep -vE '^[[:space:]]*(#|$)' "$CONTRACT"; }
keys(){ rows | awk '{print $1}'; }
grade_of(){ rows | awk -v k="$1" '$1==k{print $2}'; }

echo "════════ env 키셋 계약 대조 ════════"
printf "계약: %s (%s 키)   대상: %s\n" "$CONTRACT" "$(keys | wc -l | tr -d ' ')" "$ENVFILE"

# ── 1) 계약 → .env.example : 문서화 누락 ───────────────────────────────
miss=""
while read -r k; do
  [ -z "$k" ] && continue
  grep -qE "^#? *${k}=" "$EXAMPLE" 2>/dev/null || miss="$miss $k"
done < <(keys)
[ -z "$miss" ] && ok ".env.example 문서화 누락 0" || bad ".env.example 미문서화:$miss"

# ── 2) compose → 계약 : 역드리프트(계약이 뒤처짐) ──────────────────────
unk=""
for v in $(grep -oE '\$\{[A-Z_][A-Z0-9_]*' "$COMPOSE" 2>/dev/null | sed 's/^\${//' | sort -u); do
  keys | grep -qx "$v" || unk="$unk $v"
done
[ -z "$unk" ] && ok "compose 참조 전부 계약에 등재" || bad "compose 는 쓰는데 계약에 없음:$unk"

# ── 3) .env 대조 ───────────────────────────────────────────────────────
if [ ! -f "$ENVFILE" ]; then
  warn "$ENVFILE 없음 — .env 대조 생략(개발 체크아웃이면 정상). 이사 전에는 **라이브 머신에서** 돌려라"
else
  # 키 이름만 추출. 값은 여기서 이미 버린다(아래로 절대 안 내려간다).
  present=$(grep -oE '^[[:space:]]*[A-Z_][A-Z0-9_]*=' "$ENVFILE" | tr -d ' ' | sed 's/=$//' | sort -u)

  # 3a) req 누락
  m=""
  while read -r k g _; do
    [ "$g" = req ] || continue
    printf '%s\n' "$present" | grep -qx "$k" || m="$m $k"
  done < <(rows)
  [ -z "$m" ] && ok "req 키 전부 존재" || bad "req 누락:$m"

  # 3b) carry 누락 — 이사에서 조용히 떨어지는 부류. 사람이 봐야 한다.
  m=""
  while read -r k g _; do
    [ "$g" = carry ] || continue
    printf '%s\n' "$present" | grep -qx "$k" || m="$m $k"
  done < <(rows)
  [ -z "$m" ] && ok "carry 키 전부 존재" \
    || warn "carry 누락:$m  (코드 기본값과 다른 라이브 운영값 — 이사 시 값까지 옮겨야 한다)"

  # 3c) 계약 밖 키 — **이사 손실 방지의 핵심 방향**.
  #     라이브 .env 에 있는데 계약이 모르는 키 = 옮길 때 빠뜨릴 키다.
  m=""
  for k in $present; do
    keys | grep -qx "$k" || m="$m $k"
  done
  [ -z "$m" ] && ok "계약 밖 키 0" \
    || bad "계약에 없는 키:$m  (env-contract.txt 에 등재하고 등급을 매겨라 — 안 그러면 이사에서 소실)"

  # 3d) admin 짝 — application.yml:110 "하나만 채우면 부팅 실패"
  hn=$(printf '%s\n' "$present" | grep -cx HMB_ADMIN_NICKNAME | tr -d ' ')
  hp=$(printf '%s\n' "$present" | grep -cx HMB_ADMIN_PASSWORD | tr -d ' ')
  if [ "${hn:-0}" = "${hp:-0}" ]; then
    [ "${hn:-0}" = "1" ] && ok "admin 짝 정상(둘 다 설정)" || ok "admin 미설정(둘 다 없음 = admin 0명, 안전 기본)"
  else
    bad "admin 짝 불일치 — 하나만 설정되면 **java 부팅 실패**(nickname=$hn password=$hp)"
  fi
fi

echo "═══════════════════════════════════"
if [ "$ERR" -gt 0 ]; then
  printf "${R}FAIL${N}  오류 %d · 경고 %d\n" "$ERR" "$WRN"; exit 1
fi
printf "${G}OK${N}  오류 0 · 경고 %d\n" "$WRN"
