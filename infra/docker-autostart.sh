#!/usr/bin/env bash
# #497 항목 3 — 로그인 시 Docker Desktop 을 띄운다.
#
# 이 파일이 원본이다. 설치본은 install-docker-autostart.sh 가 ~/.local/bin/ 에 만든다
# (tunnel-heal.sh 와 같은 규약 — 원본을 고치고 재설치한다).
#
# 왜 Docker 자체 설정(autoStart)이 아니라 이건가
#   Docker Desktop 4.21.1 의 autoStart 는 Contents/Library/LoginItems/DockerHelper.app 을
#   로그인 아이템으로 등록하는 스위치다. 값을 파일에 박으려면 앱이 **종료된 상태**여야 하고
#   (돌아가는 중에 고치면 종료할 때 덮어쓴다), 그 종료는 이 맥의 컨테이너 8개를 전부 내린다.
#   그중 6개는 다른 도메인 것이고 tfs-ledger-view 는 살아 있는 소비자가 붙어 있다.
#   목표는 "Docker 설정을 바꾸는 것"이 아니라 **"로그인 시 Docker 가 떠 있는 것"** 이므로,
#   남의 도메인을 내리지 않고 같은 결과를 얻는 이 경로를 쓴다.
#
#   ⚠️ 둘은 배타적이지 않다. hero 가 나중에 GUI 체크박스를 켜도 충돌하지 않는다 —
#      이미 떠 있는 Docker 에 open 을 걸면 아무 일도 일어나지 않는다(실측: backend pid·
#      컨테이너 수 불변). 겹쳐도 무해하다.
#
# ⚠️ #497 의 교훈을 여기에도 적용한다
#   이 스크립트를 부르는 plist 에는 **사라질 수 있는 기동 전제를 두지 않는다**.
#   WorkingDirectory 없음 · 로그는 /tmp 밖(~/Library/Logs/hmb, 재부팅 시 비워지지 않는다).
#   08:47Z 장애의 정체가 "기동 전제가 사라져 launchd 가 프로그램을 띄우지도 못하고 exit 78,
#   그래서 로그도 0줄" 이었다. 같은 구조를 새로 만들지 않는다.
set -uo pipefail

LOG_DIR="${HMB_DOCKER_AUTOSTART_LOG_DIR:-$HOME/Library/Logs/hmb}"
LOG="$LOG_DIR/docker-autostart.log"
ATTEMPTS="${HMB_DOCKER_AUTOSTART_ATTEMPTS:-10}"
SLEEP_S="${HMB_DOCKER_AUTOSTART_SLEEP:-15}"

mkdir -p "$LOG_DIR" 2>/dev/null || true
log(){ printf '%s\t%s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG" 2>/dev/null || true; }

# 로그 회전 — 로그인마다 몇 줄씩 쌓이므로 커지진 않지만, 무한히 자라게 두지 않는다.
if [ -f "$LOG" ] && [ "$(stat -f %z "$LOG" 2>/dev/null || echo 0)" -gt 262144 ]; then
  mv -f "$LOG" "$LOG.1" 2>/dev/null || true
fi

daemon_up(){ /usr/local/bin/docker info >/dev/null 2>&1 || docker info >/dev/null 2>&1; }

log "start (attempts=$ATTEMPTS interval=${SLEEP_S}s)"

if daemon_up; then
  log "이미 데몬이 응답한다 — 할 일 없음"
  exit 0
fi

i=0
while [ "$i" -lt "$ATTEMPTS" ]; do
  i=$((i+1))
  # -g: 앱을 앞으로 가져오지 않는다. 로그인 직후 사용자 포커스를 뺏지 않기 위해서다.
  if open -g -a Docker 2>>"$LOG"; then
    log "open -g -a Docker 시도 $i/$ATTEMPTS rc=0"
  else
    log "open -g -a Docker 시도 $i/$ATTEMPTS rc!=0 (앱이 아직 준비 안 됐을 수 있다 — 재시도)"
  fi
  # 데몬이 응답할 때까지 기다린다. 컨테이너는 restart:unless-stopped 라 데몬만 뜨면
  # 정책이 알아서 발화한다 — 여기서 컨테이너를 직접 띄우지 않는다(소유권 밖이다).
  j=0
  while [ "$j" -lt "$SLEEP_S" ]; do
    sleep 1; j=$((j+1))
    if daemon_up; then
      log "데몬 응답 확인 (시도 $i, ${j}초 후) — 컨테이너는 restart 정책이 복귀시킨다"
      exit 0
    fi
  done
  log "아직 데몬 무응답 (시도 $i 종료)"
done

log "✗ $ATTEMPTS 회 시도 후에도 데몬이 안 떴다"
exit 1
