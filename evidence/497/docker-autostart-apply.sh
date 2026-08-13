#!/usr/bin/env bash
# #497 항목 3 — Docker Desktop autoStart 를 켠다.
#
#   bash evidence/497/docker-autostart-apply.sh
#
# 왜 이 형태인가
#   Docker Desktop 4.21.1 에는 `docker desktop` CLI 서브커맨드가 없다(4.37+ 기능).
#   설정을 파일에 박는 경로는 GUI 토글 아니면 "종료된 상태에서 settings.json 수정" 뿐이다.
#   ⚠️ 돌아가는 중에 파일을 고치면 Docker Desktop 이 종료할 때 자기 메모리 상태로 덮어써서
#      조용히 되돌아간다. 그래서 순서가 **종료 → 수정 → 기동** 이어야 한다.
#
#   그리고 이 순서는 매니저가 승인한 "데몬 1회 정지·기동으로 컨테이너 자동복귀 실측" 과
#   같은 동작이다 — 검증을 위해 따로 한 번 더 내리지 않는다(정지 창을 두 번 열지 않는다).
#
# ⚠️ 반경: Docker Desktop 은 VM 통째로 내려가므로 이 맥의 컨테이너 8개가 전부 멈춘다
#         (hmb 2 + tfs-ledger-view + hmb-growth 3 + komodo 2). 전부 restart:unless-stopped 라
#         데몬이 뜨면 정책이 발화해 돌아온다 — 그게 이 스크립트가 실측하려는 바로 그 성질이다.
#
# ✅ **이미 적용됐다 — 다시 돌리지 마라(2026-08-13).** hero 승인 후 **매니저가 직접** 플립했다
#    (#497 코멘트 5280856314: autoStart=true · 컨테이너 8/8 자동 복귀 · 총 다운타임 약 1분 ·
#     기동 후에도 true 유지 · 워치독 규칙 4 실증으로 터널 URL 불변). 이 파일은 **절차 기록**이다.
#    지금 돌리면 `autoStart` 가 이미 True 라 초반에 빠져나가지만(67행), 그 전에 **재확인용으로라도
#    데몬을 내리지 마라** — 반경은 여전히 컨테이너 8개다.
#
# ⛔ 그래서 가드는 그대로 둔다 — 2026-08-13 매니저 정지 시 넣은 것.
#    반경이 hmb 밖(다른 도메인 컨테이너 6개, tfs-ledger-view 는 살아 있는 소비자 있음)이라
#    hmb 단독 판단으로는 못 내린다 → 매번 hero 결정.
#    ⭐ 그리고 대개 이걸 돌 필요가 없다: infra/install-docker-autostart.sh 가 **정지 없이**
#       같은 결과(로그인 시 Docker 기동)를 얻는다. 이 파일은 "Docker 자체 설정을 켜는 것"이
#       목적일 때만 쓴다.
set -uo pipefail

if [ "${HMB_DOCKER_RESTART_OK:-0}" != "1" ]; then
  cat <<'GUARD'
⛔ 이 스크립트는 Docker Desktop 을 종료·기동한다 = 이 맥의 컨테이너 8개가 전부 멈춘다
   (hmb 2 + tfs-ledger-view + hmb-growth 3 + komodo 2. 6개는 다른 도메인 소유).

   hero 결정 없이는 돌리지 마라. 정지 없는 대안을 먼저 봐라:
       bash infra/install-docker-autostart.sh --status

   그래도 돌려야 한다면(= hero 가 승인했다면):
       HMB_DOCKER_RESTART_OK=1 bash evidence/497/docker-autostart-apply.sh
GUARD
  exit 2
fi

SETTINGS="$HOME/Library/Group Containers/group.com.docker/settings.json"
EV="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$EV/docker-autostart-proof.log"
BAK="$EV/settings.json.pre-autostart.bak"

say(){ printf '%s\n' "$*" | tee -a "$LOG"; }
iso(){ date -u +%FT%TZ; }

say "== #497 item3: Docker Desktop autoStart 켜기 =="
say "언제: $(iso)"
say ""

# ── 0. 기준선 ────────────────────────────────────────────────────────────────
say "--- BEFORE ---"
BEFORE_VAL=$(python3 -c "import json;print(json.load(open('$SETTINGS'))['autoStart'])" 2>/dev/null)
say "autoStart      : $BEFORE_VAL"
say "settings md5   : $(md5 -q "$SETTINGS")"
say "컨테이너 실행중 : $(docker ps -q 2>/dev/null | wc -l | tr -d ' ')"
docker ps --format '  {{.Names}}\t{{.Status}}' 2>/dev/null | tee -a "$LOG"
BEFORE_URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' ~/.local/state/hmb/*.json 2>/dev/null | head -1)
say "터널 URL(참고)  : ${BEFORE_URL:-(미상)}"
say "cloudflared pid : $(pgrep -f 'cloudflared tunnel' | head -1)  ← 컨테이너가 아니므로 죽지 않아야 한다"
cp -p "$SETTINGS" "$BAK"
say "백업            : $BAK"
say ""

if [ "$BEFORE_VAL" = "True" ]; then say "이미 켜져 있다 — 할 일 없음"; exit 0; fi

# ── 1. 종료 ──────────────────────────────────────────────────────────────────
say "--- QUIT ---"
T0=$(date +%s)
osascript -e 'quit app "Docker"' 2>&1 | tee -a "$LOG"
for i in $(seq 1 60); do
  pgrep -qf 'MacOS/com.docker.backend' || break
  sleep 2
done
if pgrep -qf 'MacOS/com.docker.backend'; then
  say "✗ 60초 안에 종료되지 않았다 — 중단한다(강제 종료하지 않는다: 다른 도메인 컨테이너가 붙어 있다)"
  exit 1
fi
say "종료 확인: $(( $(date +%s) - T0 ))초"

# 종료할 때 Docker 가 파일을 덮어쓰는지 실측한다(이 스크립트의 순서를 정당화하는 사실).
say "종료 후 md5    : $(md5 -q "$SETTINGS")  (BEFORE 와 다르면 '종료 시 덮어쓴다'가 실측된 것)"
say ""

# ── 2. 수정 ──────────────────────────────────────────────────────────────────
say "--- EDIT (종료된 상태에서만) ---"
python3 - "$SETTINGS" <<'PY' | tee -a "$LOG"
import json,sys
p=sys.argv[1]
d=json.load(open(p))
d['autoStart']=True
json.dump(d,open(p,'w'),indent=2)
print('  autoStart -> True (settingsVersion=%s)' % d.get('settingsVersion'))
PY
say "수정 후 md5    : $(md5 -q "$SETTINGS")"
say ""

# ── 3. 기동 ──────────────────────────────────────────────────────────────────
say "--- START ---"
T1=$(date +%s)
open -a Docker
for i in $(seq 1 90); do
  docker info >/dev/null 2>&1 && break
  sleep 2
done
if ! docker info >/dev/null 2>&1; then
  say "✗ 180초 안에 데몬이 안 떴다. 백업 되돌리기: cp '$BAK' '$SETTINGS'"
  exit 1
fi
say "데몬 기동: $(( $(date +%s) - T1 ))초"

# 컨테이너 자동복귀는 정책이 발화하는 데 시간이 걸린다.
for i in $(seq 1 45); do
  [ "$(docker ps -q | wc -l | tr -d ' ')" -ge 8 ] && break
  sleep 2
done
say ""

# ── 4. 검증 ──────────────────────────────────────────────────────────────────
say "--- AFTER ---"
say "autoStart      : $(python3 -c "import json;print(json.load(open('$SETTINGS'))['autoStart'])")  ← 기동 후에도 True 여야 한다"
say "settings md5   : $(md5 -q "$SETTINGS")"
say "컨테이너 실행중 : $(docker ps -q | wc -l | tr -d ' ') / 8"
docker ps --format '  {{.Names}}\t{{.Status}}' | tee -a "$LOG"
say "cloudflared pid : $(pgrep -f 'cloudflared tunnel' | head -1)  ← BEFORE 와 같아야 한다(컨테이너 아님)"
say ""
say "--- 로그인 아이템(기제 교차검증) ---"
osascript -e 'tell application "System Events" to get the name of every login item' 2>&1 | tr ',' '\n' | sed 's/^/  /' | tee -a "$LOG"
say ""
say "판정: autoStart=True 가 **기동 후에도** 남아 있고 컨테이너 8개가 사람 개입 없이 Up 이면 PASS"
say "잔여: 실제 재부팅 복귀는 미검증 — 인위적 재부팅 금지(라이브+타 도메인 상주). #497 체크리스트로 이월."
