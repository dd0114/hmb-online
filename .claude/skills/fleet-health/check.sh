#!/bin/bash
# fleet-health/check.sh — hmb 워커 세션 실활동 점검.
# 겉모습("4 agents"·스피너) 대신 실증거로 판정: 커밋시각 · 화면상태 · 미제출입력.
# 사용: bash .claude/skills/fleet-health/check.sh [session]  (기본 hmb)
set -u
SESS="${1:-hmb}"
CONF="${FLEET_CONF:-$HOME/.config/fleet/fleet.conf}"
now=$(date +%s)
printf "%-10s %-9s %-7s %-16s %s\n" "WINDOW" "VERDICT" "COMMIT" "LASTCOMMIT" "SIGNAL"
grep -E "^$SESS " "$CONF" | while read -r s w dir _; do
  [ "$w" = "main" ] && continue
  dir="${dir/#\~/$HOME}"
  # 화면 신호
  pane=$(tmux capture-pane -t "=$SESS:$w" -p 2>/dev/null)
  [ -z "$pane" ] && { printf "%-10s %-9s\n" "$w" "DEAD"; continue; }
  busy=$(echo "$pane" | grep -c "esc to interrupt")
  # 입력창(❯) 뒤 미제출 텍스트
  pend=$(echo "$pane" | grep -E "^❯ .+" | grep -vE "^❯ *$" | tail -1 | sed 's/^❯ //' | cut -c1-24)
  # 마지막 커밋 시각(워크트리 브랜치)
  ct=$(git -C "$dir" log -1 --format=%ct 2>/dev/null)
  if [ -n "$ct" ]; then age=$(( (now-ct)/60 )); lc=$(git -C "$dir" log -1 --format='%cd' --date=format:'%m-%d %H:%M' 2>/dev/null); else age=99999; lc="-"; fi
  # 판정
  if [ "$busy" -gt 0 ]; then v="WORKING"
  elif [ -n "$pend" ]; then v="STUCK"        # 미제출 입력 = 멈춤(되살리기)
  elif [ "$age" -lt 30 ]; then v="RECENT"     # 최근 커밋, 대기
  else v="IDLE"; fi                            # 오래 정지, 지시 필요
  sig="${pend:+pend='$pend'}"; [ "$busy" -gt 0 ] && sig="generating"
  printf "%-10s %-9s %-7s %-16s %s\n" "$w" "$v" "${age}m" "$lc" "$sig"
done
echo "판정: WORKING=생성중(정상) · STUCK=미제출입력(C-u→fleet send로 되살림) · IDLE=완료대기(지시필요) · RECENT=방금커밋"
