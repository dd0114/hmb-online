#!/usr/bin/env bash
# 러너 롤백 선행 점검 (#396 · #383 파생) — **읽기 전용. 아무것도 안 바꾼다.**
#
#   bash infra/preflight-runner-rollback.sh            # 판정만
#   bash infra/preflight-runner-rollback.sh --api URL  # 백엔드 주소 직접 지정
#
# 왜 필요한가 — #383 이후 러너는 `SimulateRequest.configOverrides` 를 받고 resumeState 에 오버레이
# 지문을 실어 전·후반이 같은 계수로 도는지 확인한다. **앞으로 굴리는 배포는 안전하다**(신규 필드가
# 전부 optional 이라 구 resumeState 가 통과한다). **되돌리는 배포는 아니다**:
#
#   h1 (신 러너, overrides 적용) → [러너 롤백] → h2 (구 러너)
#     구 러너의 zod 가 미선언 키 `configOverrides` 를 **조용히 strip** 하고 `overridesHash` 도 모른다
#     → 후반이 기본값으로 돈다. 전반은 튜닝값, 후반은 기본값인 매치가 만들어진다.
#
# ⚠️ **어디에도 신호가 남지 않는다.** 구 러너는 `effective_config_hash` 자체를 안 보내므로
#    `match_halves` 에 기록조차 없다. #383 의 무음 desync 가드는 **롤백 방향에서는 존재하지 않고**,
#    과거 이미지를 바꿀 수 없으므로 코드로는 고칠 수 없다. 그래서 절차이고, 그래서 이 스크립트다.
#
# 판정: 0 = 롤백해도 된다 / 1 = 하지 마라(사유 출력) / 2 = 판정 불가(사람이 봐야 한다)

set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
G='\033[32m'; R='\033[31m'; Y='\033[33m'; B='\033[1m'; N='\033[0m'
ok(){   printf "  ${G}✓${N} %s\n" "$1"; }
bad(){  printf "  ${R}✗${N} %s\n" "$1"; }
warn(){ printf "  ${Y}!${N} %s\n" "$1"; }

API="${HMB_API:-http://localhost:${HMB_JAVA_PORT:-18080}}"
[ "${1:-}" = "--api" ] && { API="$2"; shift 2; }
ADMIN_TOKEN="${HMB_ADMIN_TOKEN:-}"

echo "════════ 러너 롤백 선행 점검 (#396) ════════"
echo "  대상 백엔드: $API"

rc=0

# ── 1) 라이브 오버레이가 걸려 있나 ────────────────────────────────────────────────
# 이게 이 스크립트의 본론이다. 비어 있으면(= '{}') 롤백해도 무음 desync 가 날 자리가 없다.
body=""; code=""
if [ -n "$ADMIN_TOKEN" ]; then
  body=$(curl -s -m 10 -w '\n%{http_code}' -H "Authorization: Bearer $ADMIN_TOKEN" \
         "$API/api/admin/engine-config" 2>/dev/null)
else
  body=$(curl -s -m 10 -w '\n%{http_code}' "$API/api/admin/engine-config" 2>/dev/null)
fi
code="${body##*$'\n'}"; body="${body%$'\n'*}"

case "$code" in
  404)
    # #383 이전 백엔드 = 오버레이 개념 자체가 없다 = 이 축의 위험이 없다.
    ok "오버레이 API 없음(404) — #383 이전 백엔드다. 이 축의 위험 없음";;
  401|403)
    warn "오버레이 API 가 인증을 요구한다($code) — 판정 불가."
    warn "  HMB_ADMIN_TOKEN=<토큰> 을 주고 다시 실행하라(자격은 infra/.env · ~/.local/state/hmb/admin-pw-v8.txt)."
    rc=2;;
  200)
    # 정본 판정은 "overrides 가 빈 객체인가" 하나다. jq 없이도 되게 python 으로 읽는다.
    verdict=$(printf '%s' "$body" | python3 -c '
import sys, json
try: d = json.load(sys.stdin)
except Exception: print("PARSE"); raise SystemExit
ov = d.get("overrides", d.get("overridesJson"))
if isinstance(ov, str):
    try: ov = json.loads(ov)
    except Exception: print("PARSE"); raise SystemExit
if ov is None: print("PARSE")
elif len(ov) == 0: print("EMPTY")
else: print("SET\t" + ", ".join(sorted(ov)) + "\t" + str(d.get("revisionId") or d.get("id") or "?"))
' 2>/dev/null)
    case "${verdict%%$'\t'*}" in
      EMPTY) ok "라이브 오버레이 = {} (비어 있음) — 롤백해도 무음 desync 가 날 자리가 없다";;
      SET)
        keys=$(printf '%s' "$verdict" | cut -f2); rev=$(printf '%s' "$verdict" | cut -f3)
        bad "라이브 오버레이가 **걸려 있다** — 이 상태로 러너를 롤백하면 안 된다"
        printf "     걸린 키: ${B}%s${N}\n     리비전 : %s\n" "$keys" "$rev"
        rc=1;;
      *) warn "오버레이 응답을 해석하지 못했다 — 사람이 봐야 한다"; printf '     %s\n' "$(printf '%s' "$body" | head -c 200)"; rc=2;;
    esac;;
  000|"") bad "백엔드 무응답 — 판정 불가($API)"; rc=2;;
  *)      warn "예상 못한 응답 코드 $code — 판정 불가"; rc=2;;
esac

# ── 2) 진행 중 매치 (드레인) ──────────────────────────────────────────────────────
# 오버레이를 비워도 **이미 진행 중인 매치는 자기 스냅샷을 들고 있다**(V37 설계: 값 복사).
# 그래서 비우는 것만으로는 부족하고 소진까지 기다려야 한다. #241·#395 와도 같은 관문이다.
inprog=$(docker run --rm -v hmb-p3-db:/data:ro alpine:3.20 sh -c \
  "apk add --no-cache sqlite >/dev/null 2>&1 && sqlite3 'file:/data/hmb.db?mode=ro' \
   \"SELECT COUNT(*) FROM matches WHERE state NOT IN ('FINISHED','FAILED','ABANDONED')\"" 2>/dev/null)
case "${inprog:-x}" in
  0) ok "진행 중 매치 0 — 드레인 완료";;
  ''|x) warn "진행 중 매치 수를 못 읽었다(볼륨 hmb-p3-db 접근 실패) — 판정 불가"; [ "$rc" = 0 ] && rc=2;;
  *) bad "진행 중 매치 ${inprog}건 — 자기 config 스냅샷을 들고 있다. 끝날 때까지 기다려라"; rc=1;;
esac

echo "═══════════════════════════════════════════"
case "$rc" in
  0) printf "  ${G}${B}롤백 가능${N} — 위 두 관문 통과\n";;
  1) printf "  ${R}${B}롤백 금지${N} — 먼저 이렇게 한다:\n"
     cat <<'EOS'

     1) 오버레이를 비운다 (원장에 '왜' 가 남는다 — reason 필수)
        curl -s -X PUT "$API/api/admin/engine-config" \
          -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
          -H "Idempotency-Key: $(uuidgen)" \
          -d '{"overrides":{}, "reason":"러너 롤백 준비 — 무음 desync 방지 (#396)"}'

     2) 진행 중 매치가 **끝날 때까지 기다린다**(비워도 그 매치들은 자기 스냅샷으로 돈다)

     3) 이 스크립트를 다시 돌려 ✓ 두 개를 확인하고 롤백한다
EOS
     ;;
  2) printf "  ${Y}${B}판정 불가${N} — 위 사유를 해소하고 다시 돌려라. 모르는 채로 롤백하지 마라\n";;
esac
exit "$rc"
