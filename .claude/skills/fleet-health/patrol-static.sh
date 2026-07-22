#!/bin/bash
# fleet-health/patrol-static.sh — 정적(=Claude 0호출) 순찰. 크론에서 주기 실행.
# 핵심: 아무 일 없으면 조용히 종료(비용 0). "Claude 필요한 상황"일 때만 매니저(hmb:main)를 fleet send로 깨운다.
# Claude 필요 상황 = STUCK(미제출입력) · IDLE(완료대기, 지시/머지/종료 판단 필요).
# 쿨다운으로 같은 (윈도우,판정) 은 일정시간 1회만 에스컬레이션(스팸 방지).
# 사용: bash patrol-static.sh [session]   (기본 hmb) · 크론: */5 * * * *
set -u
SESS="${1:-hmb}"
CONF="${FLEET_CONF:-$HOME/.config/fleet/fleet.conf}"
STATE_DIR="${HOME}/.cache/hmb-patrol"; mkdir -p "$STATE_DIR"
LOG="${STATE_DIR}/patrol.log"
FLEET="${FLEET_BIN:-$HOME/bin/fleet}"
# tmux 소켓 — launchd 컨텍스트엔 $TMUX 가 없어 capture-pane 이 빈값이 된다(→ 워커 전부 skip 버그).
# 명시적으로 소켓을 찾고, fleet(send-keys)도 같은 소켓 쓰도록 TMUX_TMPDIR export.
TMUX_SOCK="${TMUX%%,*}"
[ -z "$TMUX_SOCK" ] && TMUX_SOCK=$(ls -t "/private/tmp/tmux-$(id -u)/default" "/tmp/tmux-$(id -u)/default" 2>/dev/null | head -1)
if [ -n "$TMUX_SOCK" ]; then export TMUX_TMPDIR="$(dirname "$(dirname "$TMUX_SOCK")")"; fi
tmux_cap(){ if [ -n "$TMUX_SOCK" ]; then tmux -S "$TMUX_SOCK" capture-pane -t "$1" -p 2>/dev/null; else tmux capture-pane -t "$1" -p 2>/dev/null; fi; }
now=$(date +%s)
COOL_STUCK=${COOL_STUCK:-1200}   # STUCK 재알림 최소간격 20분
COOL_IDLE=${COOL_IDLE:-3600}     # IDLE 재알림 최소간격 60분
GRACE_SPAWN=${GRACE_SPAWN:-1800} # 스폰 유예 30분 — 갓 뜬 세션은 워크트리 HEAD가 old 베이스커밋이라
                                 #   커밋나이로 IDLE 오판됨. 처음 본 뒤 이 시간 지나야 IDLE 판정.
log(){ echo "$(date '+%m-%d %H:%M:%S') $*" >> "$LOG"; }

escalations=""   # 누적 요약
add_esc(){ escalations="${escalations}${escalations:+ | }$1"; }

# 쿨다운 확인·기록: 같은 sig 를 COOL 초 안에 이미 알렸으면 skip
should_notify(){ # $1=sigkey $2=cooldown
  local f="${STATE_DIR}/last_$1"; local last=0
  [ -f "$f" ] && last=$(cat "$f" 2>/dev/null || echo 0)
  if [ $(( now - last )) -ge "$2" ]; then echo "$now" > "$f"; return 0; fi
  return 1
}

while read -r s w dir _; do
  [ "$w" = "main" ] && continue
  dir="${dir/#\~/$HOME}"
  pane=$(tmux_cap "=$SESS:$w")
  [ -z "$pane" ] && continue   # DEAD/부재 = 조용히 skip(종료된 세션)
  seenf="${STATE_DIR}/seen_$w"; [ -f "$seenf" ] || echo "$now" > "$seenf"  # 스폰 유예 기준시각(첫 사격)
  busy=$(echo "$pane" | grep -c "esc to interrupt")
  pend=$(echo "$pane" | grep -E "^❯ .+" | grep -vE "^❯ *$" | tail -1 | sed 's/^❯ //' | cut -c1-40)
  ct=$(git -C "$dir" log -1 --format=%ct 2>/dev/null)
  if [ -n "$ct" ]; then age=$(( (now-ct)/60 )); else age=99999; fi

  if [ "$busy" -gt 0 ]; then
    :                                  # WORKING = 생성중, 무시
  elif [ -n "$pend" ]; then            # STUCK
    if should_notify "stuck_$w" "$COOL_STUCK"; then add_esc "STUCK:$w(미제출='$pend')"; fi
  elif [ "$age" -lt 30 ]; then
    :                                  # RECENT = 방금 커밋, 대기
  else                                 # IDLE 후보 (30분+ 정지, 미제출 없음)
    # 스폰 유예: 처음 본 뒤 GRACE_SPAWN 안 지났으면 IDLE 판정 보류(갓 스폰 오탐 방지).
    firstseen=$(cat "$seenf" 2>/dev/null || echo "$now")
    if [ $(( now - firstseen )) -ge "$GRACE_SPAWN" ]; then
      if should_notify "idle_$w" "$COOL_IDLE"; then add_esc "IDLE:$w(${age}m 정지, 지시/머지/종료 판단)"; fi
    fi
  fi
done < <(grep -E "^$SESS " "$CONF")

# NOTE: while 를 서브셸 아닌 프로세스치환으로 돌려 escalations 를 부모에서 읽는다.
if [ -n "$escalations" ]; then
  MSG="[auto-patrol] Claude 개입 필요: ${escalations}. fleet-health 스킬대로 실검 후 STUCK=C-u→fleet send 되살리기 / IDLE=이슈·PR 확인해 머지 or 종료. 처리 후 상태변화는 #60 한 줄."
  log "ESCALATE: $escalations"
  "$FLEET" send "$SESS:main" "$MSG" >> "$LOG" 2>&1
else
  log "quiet (개입 불필요)"
fi
