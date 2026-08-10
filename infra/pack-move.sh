#!/usr/bin/env bash
# 이송 팩 만들기 — 새 머신으로 옮겨야 할 **리포 밖 상태**를 하나로 묶는다 (#472 AC1.4).
#
#   bash infra/pack-move.sh --dry-run              # 무엇을 옮길지 점검만(아무것도 안 만듦)
#   bash infra/pack-move.sh --out ~/hmb-move.tar.gz
#   bash infra/pack-move.sh --out … --no-claude    # 모드 A 구독 세션은 안 옮긴다(의도적 제외)
#
# 왜 스크립트인가: 이사에서 잃는 것은 코드가 아니라 **목록에 없는 상태**다. 실제로 배포
# 플레이북의 자산 tar(`:620-621`)는 `notice-assets char-bundles` 만 잡아 **economy.override.json
# 38KB 를 빠뜨린 채** 운영돼 왔다. 빠지면 `initialGems 12000` 운영조정이 소멸하고 구운 값으로
# 돌아간다 — 화면은 멀쩡하고 숫자만 틀린 **무음 장애**다. 사람 기억으로 막는 방식은 이미 실패했다.
#
# ⚠️ **이 산출물은 시크릿 덩어리다** — SERVANT_TOKEN · admin 평문 비번 · CF API 토큰 ·
#    Claude 구독 세션. 그래서:
#      · 값은 **한 줄도 출력하지 않는다**(경로·크기·해시만)
#      · 산출물은 **600**
#      · 기본 출력은 **리포 밖**이고, 리포 안으로 쓰라고 하면 **거부**한다(실수 커밋 차단)
#      · 이사가 끝나면 **양쪽에서 지운다**(unpack 이 그렇게 안내한다)
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
# ⚠️ **물리 경로**로 잡는다(`pwd -P`). 논리 경로로 비교하면 별칭 하나에 아래 리포-내부 거부가
#    통째로 무력해진다 — macOS 의 `/tmp` → `/private/tmp` 가 그 예이고(워크트리를 /tmp 에 두면
#    git 은 /private/tmp 를, pwd 는 /tmp 를 준다), 심링크된 체크아웃도 같다.
#    이 결함은 실제로 독립 검증이 잡았고, 내 리포에서는 두 값이 같아 **우연히 통과**하고 있었다.
ROOT=$(pwd -P)

DRY=0; OUT=""; NO_CLAUDE=0; WITH_BACKUPS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)          DRY=1 ;;
    --out)              OUT="${2:-}"; shift ;;
    --no-claude)        NO_CLAUDE=1 ;;
    --with-db-backups)  WITH_BACKUPS=1 ;;
    -h|--help)          sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "알 수 없는 인자: $1"; exit 64 ;;
  esac
  shift
done
[ "$DRY" = 0 ] && [ -z "$OUT" ] && { echo "--out <파일> 또는 --dry-run 이 필요하다"; exit 64; }

ENVFILE="${HMB_ENV_FILE:-infra/.env}"
DB_VOLUME="${HMB_DB_VOLUME:-hmb-p3-db}"
STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
ERR=0

G='\033[32m'; R='\033[31m'; Y='\033[33m'; N='\033[0m'
ok(){   printf "  ${G}✓${N} %s\n" "$1"; }
bad(){  printf "  ${R}✗${N} %s\n" "$1"; ERR=$((ERR+1)); }
note(){ printf "  ${Y}!${N} %s\n" "$1"; }

echo "════════ 이송 팩 (#472) ════════"
[ "$DRY" = 1 ] && echo "모드: --dry-run (아무것도 만들지 않는다)" || echo "출력: $OUT"

# ── 출력 경로 안전장치 ────────────────────────────────────────────────
# 리포 안에 만들면 언젠가 커밋된다. gitignore 를 믿지 않는다 — 규칙은 바뀌고 실수는 남는다.
if [ -n "$OUT" ]; then
  OUTDIR=$(cd "$(dirname "$OUT")" 2>/dev/null && pwd -P || echo "")
  [ -z "$OUTDIR" ] && { echo "출력 디렉토리가 없다: $(dirname "$OUT")"; exit 64; }
  # 리포 루트 **자신**과 그 **하위** 둘 다 막는다(`case` 의 `*` 는 빈 문자열도 먹지만,
  # 의도를 코드에 남긴다 — 이 한 줄이 실수 커밋을 막는 전부다).
  case "$OUTDIR" in
    "$ROOT"|"$ROOT"/*) printf "${R}✗ 출력 경로가 리포 안이다: %s${N}\n" "$OUT"
               echo "  이 팩은 시크릿 덩어리다 — 리포 안에 두면 실수로 커밋된다."
               echo "  리포 밖으로: bash infra/pack-move.sh --out ~/hmb-move.tar.gz"
               exit 3 ;;
  esac
fi

# ── 이송 목록 ─────────────────────────────────────────────────────────
# 형식: 라벨|원본경로|필수여부(req|opt)|설명
#   ⚠️ 여기가 **단일 출처**다. 항목을 늘리면 검사·팩·매니페스트가 같이 따라온다.
#   /tmp/hmb-* 런타임 핸들은 **일부러 없다** — 재생성되므로 옮기지 않는다(옮기면 죽은 PID 를 물고 온다).
#   ~/Library/LaunchAgents/*.plist 도 없다 — 새 머신에서 install-tunnel-heal.sh 가 다시 만든다
#   (그리고 리눅스면 plist 자체가 무의미하다, AC1.3).
ITEMS=(
  "infra/.env|$ENVFILE|req|SERVANT_TOKEN·admin 짝·HMB_MATCH_* — 없으면 java 가 안 뜬다"
  "~/.config/hmb/deploy.env|$HOME/.config/hmb/deploy.env|req|CF 토큰 — 없으면 라우터 스왑(web 재배포) 불가"
  "~/.cache/hmb/dist-current|$HOME/.cache/hmb/dist-current|req|마지막 성공 배포 스냅샷 — 없으면 publish-backend-url exit 2"
  "~/.cache/hmb/dist-current.functions|$HOME/.cache/hmb/dist-current.functions|req|OG Function(#299) — 없으면 재배포가 Function 을 삭제한다"
  "~/.cache/hmb/dist-current.meta|$HOME/.cache/hmb/dist-current.meta|req|배포 출처 기록"
  "~/.local/state/hmb|$HOME/.local/state/hmb|req|deploy.lock·admin-pw·heal 상태"
)
if [ "$NO_CLAUDE" = 1 ]; then
  note "~/.claude 는 **의도적으로 제외**한다(--no-claude). 모드 A 구독 AI 는 새 머신에서 재로그인이 필요하다."
  note "  이 선택은 매니페스트에 기록된다 — 조용한 누락과 구분하기 위해서다."
else
  ITEMS+=("~/.claude|$HOME/.claude|req|모드 A 구독 세션 — 이사의 최대 난점(#472 §④)")
fi

# ── db-backups 제외 ───────────────────────────────────────────────────
# ⚠️ 실측(2026-08-09 라이브): `~/.local/state/hmb` 8.9GB 중 **8.9GB 가 `db-backups/`(66개)** 다.
#    그대로 싸면 이송이 13GB 가 되고, 그 전송이 **정지 창 안에** 들어간다.
#    그런데 이 백업들은 **이사에 필요 없다**:
#      · DB 본체는 런북 P2 의 정지 창 안 `.backup` 으로 따로 간다(일관성 보장 경로)
#      · 과거 백업은 **구 머신에 그대로 남는다** — 롤백 자산은 거기 있지 여기 있지 않다
#    그래서 기본 제외하되 **조용히 빼지 않는다**(매니페스트에 기록 + 크기를 출력).
#    다 옮기려면 --with-db-backups.
TAR_EXCL=()
if [ "$WITH_BACKUPS" = 0 ]; then
  TAR_EXCL+=(--exclude='db-backups')
fi

echo ""
echo "── 호스트 상태 ──"
COPIED=0; TOTAL_KB=0
for row in "${ITEMS[@]}"; do
  IFS='|' read -r label src _req desc <<< "$row"
  if [ -e "$src" ]; then
    sz=$(du -skL "$src" 2>/dev/null | awk '{print $1}')
    # state/hmb 는 제외분을 빼고 센다 — 안 그러면 "13GB 를 옮긴다" 로 보인다.
    if [ "$WITH_BACKUPS" = 0 ] && [ -d "$src/db-backups" ]; then
      bk=$(du -skL "$src/db-backups" 2>/dev/null | awk '{print $1}')
      sz=$(( ${sz:-0} - ${bk:-0} ))
      note "$label 의 db-backups/ $(( ${bk:-0} / 1048576 ))GB 는 **제외**한다(구 머신에 남는다. 포함: --with-db-backups)"
    fi
    TOTAL_KB=$(( TOTAL_KB + ${sz:-0} ))
    ok "$label  (${sz:-?}KB)"
    if [ "$DRY" = 0 ]; then
      # ⚠️ 팩 안에서는 **슬러그 한 칸**으로 저장한다. 라벨을 그대로 디렉토리로 쓰면
      #    `host/~/.config/...` 처럼 중첩이 생겨, 푸는 쪽이 "어디까지가 한 항목인가" 를
      #    경로 모양으로 되추론해야 한다(그러다 항목을 통째로 놓친다). 매핑은 되추론하지 않고
      #    **싸는 쪽이 MAP 에 적는다** — #378 의 "배정한 쪽이 라벨을 단다" 와 같은 처방.
      slug=$(printf '%s' "$label" | tr '/' '_' | sed 's/^~_/HOME_/')
      mkdir -p "$STAGE/host"
      if [ -d "$src" ] && [ ${#TAR_EXCL[@]} -gt 0 ]; then
        # 제외를 걸어야 하는 디렉토리는 tar 파이프로 옮긴다(cp 엔 --exclude 가 없다).
        mkdir -p "$STAGE/host/$slug"
        ( cd "$src" && tar -cf - "${TAR_EXCL[@]}" . ) | ( cd "$STAGE/host/$slug" && tar -xpf - ) \
          || { bad "$label 복사 실패"; continue; }
      else
        cp -Rp "$src" "$STAGE/host/$slug" 2>/dev/null || { bad "$label 복사 실패"; continue; }
      fi
      printf '%s|%s\n' "$slug" "$label" >> "$STAGE/MAP"
      COPIED=$((COPIED+1))
    fi
  else
    bad "$label 없음 — $desc"
  fi
done

# ── DB 볼륨 안의 항목 ─────────────────────────────────────────────────
# ⚠️ 라이브 DB(659MB)가 사는 볼륨이다. **read-only 로만** 만진다.
#    (DB 본체 이송은 이 스크립트가 아니라 런북 P2 의 `.backup` 소관이다 — 정지 창 안에서 해야
#     일관성이 보장된다. 여기서 뜨면 WAL 이 살아 있는 채로 복사돼 조용히 어긋난다.)
echo ""
echo "── DB 볼륨($DB_VOLUME) 안 ──"
ECON=$(docker run --rm -v "$DB_VOLUME":/data:ro alpine:3.20 cat /data/economy.override.json 2>/dev/null)
if [ -n "$ECON" ]; then
  ok "economy.override.json  ($(printf '%s' "$ECON" | wc -c | tr -d ' ')B)"
  if [ "$DRY" = 0 ]; then
    mkdir -p "$STAGE/volume"
    printf '%s' "$ECON" > "$STAGE/volume/economy.override.json"
    COPIED=$((COPIED+1))
  fi
else
  bad "economy.override.json 없음 — 빠뜨리면 initialGems 운영조정이 소멸한다(플레이북 :620-621 이 실제로 빠뜨린 항목)"
fi
note "DB 본체(hmb.db)는 이 팩에 없다 — 런북 P2 의 정지 창 안 \`.backup\` 소관이다(WAL 일관성)."

# ── 판정 ──────────────────────────────────────────────────────────────
echo ""
if [ "$ERR" -gt 0 ]; then
  printf "${R}FAIL${N}  누락 %d 건 — 이대로 이사하면 그만큼 잃는다.\n" "$ERR"
  exit 1
fi

printf "  전송량(압축 전) 약 %d MB\n" $(( TOTAL_KB / 1024 ))

if [ "$DRY" = 1 ]; then
  printf "${G}OK${N}  이송 목록 전부 존재. 만들려면: bash infra/pack-move.sh --out ~/hmb-move.tar.gz\n"
  exit 0
fi

# ── 매니페스트 + tar ──────────────────────────────────────────────────
# 매니페스트는 **항목별 shasum** 이다. tar 하나짜리 해시로는 "무엇이 깨졌나" 를 못 말한다.
MAN="$OUT.manifest"
{
  echo "# hmb 이송 팩 매니페스트 (#472 AC1.4)"
  echo "# 형식: <sha256> <경로>   — unpack-move.sh 가 복원 **전에** 대조한다."
  echo "# source-host: $(hostname 2>/dev/null || echo unknown)"
  echo "# git: $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  [ "$NO_CLAUDE" = 1 ] && echo "# excluded: ~/.claude (--no-claude, 의도적 제외)"
  [ "$WITH_BACKUPS" = 0 ] && echo "# excluded: ~/.local/state/hmb/db-backups (기본 제외 — 구 머신에 남는다. 포함: --with-db-backups)"
} > "$MAN"
( cd "$STAGE" && find . -type f -print0 | LC_ALL=C sort -z | \
    xargs -0 shasum -a 256 2>/dev/null | sed 's#\./##' ) >> "$MAN"

tar -czf "$OUT" -C "$STAGE" . 2>/dev/null || { bad "tar 실패"; exit 1; }
chmod 600 "$OUT" "$MAN"

nsha=$(grep -cE '^[0-9a-f]{64} ' "$MAN" | tr -d ' ')
echo ""
ok "팩: $OUT  ($(du -sk "$OUT" | awk '{print $1}')KB)"
ok "매니페스트: $MAN  (파일 $nsha 개 shasum)"
printf "${Y}!${N} 이 파일은 시크릿을 담고 있다 — 권한 600, 리포 밖. 옮긴 뒤 **양쪽에서 삭제**할 것.\n"
echo ""
echo "새 머신에서: bash infra/unpack-move.sh --in <옮긴경로>/$(basename "$OUT")"
