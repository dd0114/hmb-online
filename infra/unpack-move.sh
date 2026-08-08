#!/usr/bin/env bash
# 이송 팩 풀기 — 새 머신에 리포 밖 상태를 복원한다 (#472 AC1.4).
#
#   bash infra/unpack-move.sh --in ~/hmb-move.tar.gz            # 검증 + 복원
#   bash infra/unpack-move.sh --in … --verify-only              # 대조만
#   bash infra/unpack-move.sh --in … --force                    # 기존 파일을 덮어쓴다
#
# ⚠️ **부분 복원이 tar 파손보다 나쁘다.** 절반만 복원된 머신은 "돌아가는 것처럼 보이다가"
#    특정 경로에서만 죽는다(예: dist-current 는 왔는데 .functions 가 없어 재배포가 OG Function 을
#    지운다). 그래서 순서가 고정이다 — **매니페스트 전량 대조 → 전부 통과해야 → 그때 쓴다.**
#    한 항목이라도 어긋나면 **아무것도 쓰지 않고** 멈춘다.
#
# ⚠️ 값은 출력하지 않는다(경로·개수만). 이 팩은 토큰·admin 평문·구독 세션을 담고 있다.
set -uo pipefail

IN=""; FORCE=0; VERIFY_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --in)          IN="${2:-}"; shift ;;
    --force)       FORCE=1 ;;
    --verify-only) VERIFY_ONLY=1 ;;
    -h|--help)     sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "알 수 없는 인자: $1"; exit 64 ;;
  esac
  shift
done
[ -n "$IN" ] || { echo "--in <팩파일> 이 필요하다"; exit 64; }
[ -f "$IN" ] || { echo "팩이 없다: $IN"; exit 66; }
MAN="$IN.manifest"
[ -f "$MAN" ] || { echo "매니페스트가 없다: $MAN  (팩과 같은 디렉토리에 있어야 한다)"; exit 66; }

G='\033[32m'; R='\033[31m'; Y='\033[33m'; N='\033[0m'
ok(){   printf "  ${G}✓${N} %s\n" "$1"; }
bad(){  printf "  ${R}✗${N} %s\n" "$1"; }
note(){ printf "  ${Y}!${N} %s\n" "$1"; }

STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
echo "════════ 이송 팩 복원 (#472) ════════"
echo "팩: $IN"
grep -E '^# (source-host|git|excluded):' "$MAN" | sed 's/^# /  /'

# ── 1) 스테이징에 풀고 **전량 대조** (아직 HOME 을 안 건드린다) ────────
tar -xzf "$IN" -C "$STAGE" 2>/dev/null || { bad "tar 해제 실패 — 전송 중 손상"; exit 1; }

echo ""
echo "── 무결성 대조 ──"
MISM=0; CHECKED=0
while read -r want path; do
  case "$want" in \#*|"") continue ;; esac
  f="$STAGE/$path"
  if [ ! -f "$f" ]; then bad "팩에 없음: $path"; MISM=$((MISM+1)); continue; fi
  got=$(shasum -a 256 "$f" 2>/dev/null | awk '{print $1}')
  CHECKED=$((CHECKED+1))
  [ "$got" = "$want" ] || { bad "해시 불일치: $path"; MISM=$((MISM+1)); }
done < "$MAN"

if [ "$MISM" -gt 0 ]; then
  echo ""
  printf "${R}FAIL${N}  불일치 %d 건 / 검사 %d 건 — **아무것도 복원하지 않았다.**\n" "$MISM" "$CHECKED"
  echo "  구 머신에서 팩을 다시 만들고 다시 전송할 것(부분 복원은 더 나쁘다)."
  exit 1
fi
ok "$CHECKED 개 파일 shasum 일치"

if [ "$VERIFY_ONLY" = 1 ]; then
  echo ""; printf "${G}OK${N}  대조만 수행 — 복원하지 않았다.\n"; exit 0
fi

# ── 2) 충돌 검사 — 말없이 덮어쓰지 않는다 ─────────────────────────────
# 새 머신에 이미 상태가 있을 수 있다(재시도·부분 수작업). 덮어쓰면 그게 소실이다.
ENVFILE="${HMB_ENV_FILE:-infra/.env}"
[ -f "$STAGE/MAP" ] || { bad "팩에 MAP 이 없다 — 어느 항목이 어디로 가는지 알 수 없다(구 버전 팩?)"; exit 1; }

# 목적지는 **MAP 의 라벨**로 정한다(경로 모양 되추론 금지 — 그러다 항목을 통째로 놓친다).
dest_of(){
  case "$1" in
    infra/.env) echo "$ENVFILE" ;;
    '~/'*)      echo "$HOME/${1#\~/}" ;;
    *)          echo "" ;;
  esac
}

CONFLICT=0
while IFS='|' read -r slug label; do
  [ -n "${slug:-}" ] || continue
  d=$(dest_of "$label"); [ -n "$d" ] || { bad "MAP 에 알 수 없는 라벨: $label"; exit 1; }
  [ -e "$d" ] && { CONFLICT=$((CONFLICT+1)); [ "$FORCE" = 0 ] && bad "이미 존재: $d"; }
done < "$STAGE/MAP"

if [ "$CONFLICT" -gt 0 ] && [ "$FORCE" = 0 ]; then
  echo ""
  printf "${R}FAIL${N}  기존 파일 %d 건 — **아무것도 복원하지 않았다.**\n" "$CONFLICT"
  echo "  확인 후 덮어쓰려면: bash infra/unpack-move.sh --in $IN --force"
  exit 2
fi

# ── 3) 복원 ───────────────────────────────────────────────────────────
echo ""
echo "── 복원 ──"
# ⚠️ `--force` 로 덮기 **전에** 기존 것을 치워 둔다. 새 머신에 이미 상태가 있는데 그게 더 새로울
#    수 있고, 덮어쓰면 그 순간 소실이다. (개발 중 이 안전망이 없어서 라이브 `infra/.env` 를
#    한 번 날렸다 — 가동 중 컨테이너 env 에서 복원했지만, 컨테이너가 내려가 있었으면 못 살렸다.)
BK="${HMB_STATE_DIR:-$HOME/.local/state/hmb}/move/pre-unpack"
n=0
while IFS='|' read -r slug label; do
  [ -n "${slug:-}" ] || continue
  d=$(dest_of "$label")
  mkdir -p "$(dirname "$d")"
  if [ -e "$d" ]; then
    mkdir -p "$BK"
    cp -Rp "$d" "$BK/$slug" 2>/dev/null && note "기존 것을 백업: $BK/$slug"
  fi
  rm -rf "$d"
  cp -Rp "$STAGE/host/$slug" "$d" || { bad "복원 실패: $d"; exit 1; }
  ok "$label → $d"
  n=$((n+1))
done < "$STAGE/MAP"

# 권한 재확인 — cp -Rp 가 보존하지만, 시크릿은 **믿지 않고 다시 건다**.
for s in "$ENVFILE" "$HOME/.config/hmb/deploy.env" "$HOME/.local/state/hmb/admin-pw-v8.txt"; do
  [ -f "$s" ] && chmod 600 "$s" 2>/dev/null
done
ok "시크릿 파일 권한 600 재확인"

# ── 4) 볼륨 항목은 **여기서 넣지 않는다** ─────────────────────────────
# economy.override.json 은 DB 볼륨 안에 살아야 하는데, 이 시점엔 볼륨이 아직 없거나
# DB 복원(런북 P2)이 안 끝났을 수 있다. 순서를 어기면 P2 가 덮어쓰거나 권한이 어긋난다.
# 그래서 **꺼내 두고 명령만 알려준다** — 넣는 시점은 런북 P3 이 정한다.
if [ -f "$STAGE/volume/economy.override.json" ]; then
  ST="${HMB_STATE_DIR:-$HOME/.local/state/hmb}"
  mkdir -p "$ST/move"
  cp -p "$STAGE/volume/economy.override.json" "$ST/move/economy.override.json"
  echo ""
  note "economy.override.json 은 **DB 볼륨 안**에 들어가야 한다 — 지금 넣지 않는다."
  note "  DB 복원(런북 P2) 이 끝난 **뒤**, P3 에서:"
  echo "     docker run --rm -v ${HMB_DB_VOLUME:-hmb-p3-db}:/data -v $ST/move:/src:ro \\"
  echo "       alpine:3.20 sh -c 'cp /src/economy.override.json /data/ && chown 10001:999 /data/economy.override.json'"
  note "  확인: GET /api/admin/economy → source: OVERRIDE · overrideFilePresent: true"
fi

echo ""
printf "${G}OK${N}  %d 항목 복원 완료.\n" "$n"
note "다음: bash infra/check-env-contract.sh  (키셋 대조) → bash infra/install-tunnel-heal.sh (워치독)"
printf "${Y}!${N} 이사가 끝나면 **양쪽 머신에서 팩과 매니페스트를 삭제**할 것 — 시크릿 덩어리다.\n"
