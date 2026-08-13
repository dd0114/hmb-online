#!/usr/bin/env bash
# HMB #489 단계3.5 — AC5 재현 배치 드라이버 R6~R9
#
# 목적: 스켑틱 패널 N=3(2R) 반려 3건 중 ①②를 처리한다(③은 이전 웨이브에서 완료).
#   ① 재현성 — 회차 2·3·5 가 같은 배치 14분 안에 몰려 있어 "공통 환경" 가설을 반박 못함
#      → R6/R7/R8 을 **서로 ≥2시간** 간격의 독립 배치로 돌린다.
#   ② 엣지케이스(위상) — 60초 주기의 관측 최대 지연이 108s 뿐, 최악 위상(다음 틱까지
#      ~59초 남은 지점, 즉 틱 직후) 이 측정된 적이 없다 → R9 가 그 위상을 겨눠 kill 한다.
#
# 개입은 `kill -9 <cloudflared PID>` 뿐이다. 수동 publish/deploy/heals.tsv 조작 0.
# 라이브(hmb-online) Pages 프로젝트는 `deployment list` 조회만 한다 — deploy/delete 금지.
#
# 벽시계가 6시간+ 필요해 사람도 세션도 루프에 없다 — systemd-run 분리 유닛으로 띄운다.
#
# 사용법:
#   AC5_DRY_RUN=1 bash ac5-batch-driver.sh   # 비파괴 스냅샷 1회만 찍고 종료(프리플라이트용)
#   bash ac5-batch-driver.sh                 # 실제 배치(R6~R9, 6시간+)

set -uo pipefail

OUT="/opt/hmb/evidence/AC5-batch-R6toR9.log"
mkdir -p "$(dirname "$OUT")"

SELF="$0"
SELF_MD5=$(md5sum "$SELF" 2>/dev/null | awk '{print $1}')

STATE_DIR="/root/.local/state/hmb"
HEAL_LOG="$STATE_DIR/tunnel-heal.log"
TUNNEL_LOG="/tmp/hmb-cf-tunnel.log"
DIST_CACHE="/root/.cache/hmb/dist-current"
LIVE_PROJECT="hmb-online"
LAB_PROJECT="hmb-online-lab"
DEPLOY_ENV="/root/.config/hmb/deploy.env"
GAP_SEC=$((2*3600))
# 직전 배치 마지막 치유 시각(#489 이슈 코멘트·README 근거) — 이 시각 + 2h 이전이면 R6 를 대기시킨다.
LAST_HEAL_REF_EPOCH=$(date -d "2026-08-13 01:05:54 +0900" +%s 2>/dev/null || echo 0)

ts_utc(){ date -u +"%Y-%m-%dT%H:%M:%SZ"; }
ts_kst(){ TZ=Asia/Seoul date +"%Y-%m-%d %H:%M:%S KST"; }
epoch(){ date +%s; }
log(){ printf '%s\n' "$*" >> "$OUT"; }
sep(){ log ""; log "=================================================================="; }

# ── config.json 필드 파싱 (jq 없음 — 형태가 단순해 grep 으로 충분) ──
# ⚠️ 실측(드라이런): publish-backend-url.sh 가 쓰는 config.json 은 pretty-print 되어
#    콜론 뒤 공백·개행이 있다("apiBase": "https://…",) — 공백 없는 압축형만 가정하면 매칭이 샌다.
field(){
  printf '%s' "$1" | tr -d '\n' \
    | grep -oE "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 \
    | sed -E "s/\"$2\"[[:space:]]*:[[:space:]]*\"([^\"]*)\"/\1/"
}

# ── 다음 워치독 틱까지 초 (systemctl list-timers 의 NEXT 열을 파싱) ──
next_tick_epoch(){
  local line next_str
  line=$(systemctl list-timers hmb-tunnel-heal.timer --no-pager 2>/dev/null | sed -n '2p')
  next_str=$(printf '%s' "$line" | awk '{print $1,$2,$3,$4}')
  [ -n "$next_str" ] && date -d "$next_str" +%s 2>/dev/null
}
last_trigger_raw(){ systemctl show hmb-tunnel-heal.timer -p LastTriggerUSec --value 2>/dev/null; }

current_tunnel_url(){
  grep -aoE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null \
    | grep -v '^https://api\.trycloudflare\.com$' | tail -1
}

live_config(){ curl -s -m 8 "https://${LIVE_PROJECT}.pages.dev/config.json?t=$(epoch)" 2>/dev/null; }
lab_config(){ curl -s -m 8 "https://${LAB_PROJECT}.pages.dev/config.json?t=$(epoch)" 2>/dev/null; }

# ── 비파괴 스냅샷 — kill 직전에 부르는 것이 정석, dry-run 검증에도 그대로 재사용 ──
snapshot(){
  local label="$1"
  log "  [$label 스냅샷 @ KST $(ts_kst) / UTC $(ts_utc)]"
  log "    date -u                  = $(date -u)"
  log "    date (KST)               = $(ts_kst)"

  local nrt ltu nte now_e left
  nrt=$(systemctl show hmb-tunnel-heal.timer -p NextElapseUSecRealtime --value 2>/dev/null)
  ltu=$(last_trigger_raw)
  log "    systemctl show -p NextElapseUSecRealtime = '${nrt:-<비어있음>}'"
  log "    systemctl show -p LastTriggerUSec         = ${ltu:-<없음>}"
  [ -z "${nrt:-}" ] && log "      (모노토닉 OnUnitActiveSec 타이머라 Realtime 필드가 원래 비어 있다 — list-timers 로 위상을 다시 잰다)"
  nte=$(next_tick_epoch); now_e=$(epoch)
  if [ -n "${nte:-}" ]; then
    left=$((nte - now_e))
    log "    다음 워치독 틱까지 남은 초 (list-timers 파생) = ${left}s"
  else
    log "    다음 워치독 틱까지 남은 초 = <list-timers 파싱 실패>"
  fi

  if [ -f "$DIST_CACHE/index.html" ]; then
    local idx_md5 idx_mtime idx_mtime_e age_min
    idx_md5=$(md5sum "$DIST_CACHE/index.html" | awk '{print $1}')
    idx_mtime=$(date -r "$DIST_CACHE/index.html" +"%Y-%m-%d %H:%M:%S %Z")
    idx_mtime_e=$(date -r "$DIST_CACHE/index.html" +%s)
    age_min=$(( (now_e - idx_mtime_e) / 60 ))
    log "    dist-current index.html md5   = $idx_md5"
    log "    dist-current index.html mtime = $idx_mtime"
    log "    dist-current 캐시 나이        = ${age_min} 분"
  else
    log "    dist-current index.html 없음 (⚠️ 전파가 불가능한 상태)"
  fi

  local b1 b2
  b1=$(curl -s -o /dev/null -w '%{http_code} %{time_total}s' -m 5 "http://localhost:18080/internal/health" 2>/dev/null)
  b2=$(curl -s -o /dev/null -w '%{http_code} %{time_total}s' -m 5 "http://localhost:18790/health" 2>/dev/null)
  log "    backend :18080/internal/health = ${b1:-<무응답>}"
  log "    runner  :18790/health          = ${b2:-<무응답>}"

  local pid url
  pid=$(pgrep -f 'cloudflared tunnel --url' | head -1)
  url=$(current_tunnel_url)
  log "    죽일 cloudflared PID = ${pid:-<없음>}"
  log "    현재 터널 URL       = ${url:-<없음>}"

  local live
  live=$(live_config)
  log "    live($LIVE_PROJECT) config.json (kill 전) = ${live:-<무응답>}"

  # dry-run 이 값 채워짐을 기계적으로 확인할 수 있게 필드 목록을 그대로 리턴
  printf '%s\n' "$pid" "$url" "$live"
}

# ── R9 전용: 다음 틱까지 정확히 ~59초 남는 지점까지 대기 ──
# 방법: LastTriggerUSec 이 바뀌는 순간(=틱이 막 발화한 순간)을 폴링으로 잡고, 그 +1초 뒤가
# "다음 틱까지 59초 남은 지점"이다. 예측이 아니라 실제 발화 이벤트를 관측하므로
# AccuracySec(5s) 지터에 영향받지 않는다.
wait_worst_phase(){
  local base_trigger cur_trigger waited=0
  base_trigger=$(last_trigger_raw)
  log "  [R9 위상대기] 기준 LastTriggerUSec = ${base_trigger:-<없음>} — 다음 발화를 폴링으로 기다린다 (2s 간격)"
  while :; do
    sleep 2; waited=$((waited+2))
    cur_trigger=$(last_trigger_raw)
    if [ -n "$cur_trigger" ] && [ "$cur_trigger" != "$base_trigger" ]; then
      log "  [R9 위상대기] 발화 감지 @ $(ts_kst) (대기 ${waited}s) — LastTriggerUSec = $cur_trigger"
      sleep 1
      log "  [R9 위상대기] +1s 경과 @ $(ts_kst) — 이 지점에서 kill (목표 위상 ≈59s)"
      return 0
    fi
    [ "$waited" -ge 180 ] && { log "  [R9 위상대기] ⚠️ 180s 안에 발화 미감지 — 폴백으로 즉시 진행"; return 1; }
  done
}

# ── 회차 본체 ──
do_round(){
  local rname="$1" worst="$2"
  sep
  log "=== $rname 시작 $(ts_kst) / $(ts_utc) ==="
  log "  worst_phase = $worst"

  local pre_out pre_pid pre_url pre_live

  if [ "$worst" = "1" ]; then
    # 사전 확인(참고용) — 이 스냅샷의 위상 값은 kill 시점이 아니다. 위상 대기 뒤에
    # 별도로 "kill-직전" 스냅샷을 다시 찍는다(라벨 오독 방지).
    snapshot "$rname 사전확인(위상대기 전, kill 아님)" > /dev/null
    wait_worst_phase
    pre_out=$(snapshot "$rname kill-직전(위상조정후)")
  else
    pre_out=$(snapshot "$rname kill-직전")
  fi
  pre_pid=$(printf '%s\n' "$pre_out" | sed -n '1p')
  pre_url=$(printf '%s\n' "$pre_out" | sed -n '2p')
  pre_live=$(printf '%s\n' "$pre_out" | sed -n '3p')

  if [ -z "$pre_pid" ] || [ -z "$pre_url" ]; then
    log "  ✗ $rname 스킵 — cloudflared PID 또는 현재 URL 을 못 얻었다(치유 대상 없음)"
    log "=== $rname 중단 $(ts_kst) (전제 미충족) ==="
    return 1
  fi

  local t0_kst t0_utc
  t0_kst=$(ts_kst); t0_utc=$(ts_utc)
  log "  ▶ kill -9 $pre_pid  @ $t0_kst / $t0_utc  (T0, old_url=$pre_url) — PID 로만, pkill 금지"
  kill -9 "$pre_pid" 2>/dev/null
  local t0_epoch; t0_epoch=$(epoch)

  # ── 새 URL 검출 (로컬 SoT /tmp/hmb-cf-tunnel.log, 1초 폴링) ──
  local new_url="" i elapsed
  for i in $(seq 1 240); do
    sleep 1
    new_url=$(current_tunnel_url)
    if [ -n "$new_url" ] && [ "$new_url" != "$pre_url" ]; then
      elapsed=$(( $(epoch) - t0_epoch ))
      log "  t=+${elapsed}s (폴링 1s, ±1s)  새 URL = $new_url  (pid=$(pgrep -f 'cloudflared tunnel --url' | head -1))"
      break
    fi
    new_url=""
  done
  if [ -z "$new_url" ]; then
    log "  ✗ 240s 안에 새 URL 미검출 — $rname 실패로 기록하고 계속 진행"
    log "=== $rname 종료(새URL 미검출) $(ts_kst) ==="
    return 1
  fi

  # ── lab 전파 검출 (2초 폴링) ──
  local lab_now="" lab_apiBase="" elapsed2 detect_kst detect_utc
  for i in $(seq 1 240); do
    sleep 2
    lab_now=$(lab_config)
    lab_apiBase=$(field "$lab_now" apiBase)
    if [ -n "$lab_apiBase" ] && [ "$lab_apiBase" = "$new_url" ]; then
      elapsed2=$(( $(epoch) - t0_epoch ))
      detect_kst=$(ts_kst); detect_utc=$(ts_utc)
      log "  t=+${elapsed2}s (폴링 2s, ±2s + curl 왕복)  ✓ lab 전파 도달 검출 @ $detect_kst / $detect_utc"
      break
    fi
    lab_apiBase=""
  done
  if [ -z "$lab_apiBase" ]; then
    log "  ✗ 240s 안에 lab 전파 미검출"
    log "    (참고) 마지막 관측 lab config.json = ${lab_now:-<무응답>}"
  else
    # ⚠️ AC5-repeat.log:107 오프바이원 재발 방지 — 전파 검출 "이후" 다시 읽고, 읽은 시각을 명시한다.
    local lab_reread; lab_reread=$(lab_config)
    log "    lab config.json (전파검출 직후 재조회 @ $(ts_kst) / $(ts_utc)) = ${lab_reread:-<무응답>}"
  fi

  # ── +20초 뒤 재조회 (CF POP 별 반영 시점 차 대비) ──
  sleep 20
  local lab_plus20; lab_plus20=$(lab_config)
  log "    lab config.json (+20s 재조회 @ $(ts_kst) / $(ts_utc)) = ${lab_plus20:-<무응답>}"

  # ── lab 배포 ID (전파 확인 직후 조회) ──
  # ⚠️ 실측: `wrangler pages deployment list <name>` 은 이 설치본(4.86.0)에서 positional 을
  #    안 받는다("Unknown argument") — `--project-name` 플래그가 필요하다.
  local dep_id=""
  if [ -f "$DEPLOY_ENV" ]; then
    dep_id=$(. "$DEPLOY_ENV"; export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; \
      wrangler pages deployment list --project-name "$LAB_PROJECT" --json 2>/dev/null \
      | grep -oE '"Id"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed -E 's/.*"([0-9a-fA-F-]+)"/\1/')
  fi
  log "    이 회차가 만든 lab 배포 ID (조회 @ $(ts_kst)) = ${dep_id:-<조회실패>}"

  # ── HEAL_OK 이벤트 전문 ──
  local heal_ok
  heal_ok=$(grep "HEAL_OK" "$HEAL_LOG" 2>/dev/null | awk -F'\t' -v t0="$t0_epoch" '$1>=t0' | tail -3)
  log "    HEAL_OK 이벤트(이 회차 구간):"
  if [ -n "$heal_ok" ]; then printf '%s\n' "$heal_ok" | sed 's/^/      /' >> "$OUT"; else log "      (없음)"; fi

  # ── live 무접촉 재확인 ──
  local post_live post_live_api pre_live_api
  post_live=$(live_config)
  pre_live_api=$(field "$pre_live" apiBase)
  post_live_api=$(field "$post_live" apiBase)
  log "    live($LIVE_PROJECT) config.json (kill 전) = $pre_live"
  log "    live($LIVE_PROJECT) config.json (kill 후) = $post_live"
  if [ "$pre_live_api" = "$post_live_api" ] && [ -n "$pre_live_api" ]; then
    log "    live apiBase 무변경 = YES ($pre_live_api)"
  else
    log "    live apiBase 무변경 = ⚠️ NO 또는 조회 실패 — 즉시 확인 필요 (전 후 값 위 참조)"
  fi

  # ── DEGRADED / UNVERIFIED / source ──
  local deg_cnt unverified_cnt source_val
  deg_cnt=$([ -f "$STATE_DIR/DEGRADED" ] && echo 1 || echo 0)
  unverified_cnt=$(grep "PUBLISH_UNVERIFIED" "$HEAL_LOG" 2>/dev/null | awk -F'\t' -v t0="$t0_epoch" '$1>=t0' | wc -l)
  source_val=$(field "${lab_reread:-$lab_plus20}" source)
  log "    DEGRADED 마커 존재 = $deg_cnt (0 이어야)"
  log "    PUBLISH_UNVERIFIED 건수(이 회차 구간) = $unverified_cnt"
  log "    source 필드 = ${source_val:-<없음>} (heal 이어야)"

  log "=== $rname 종료 $(ts_kst) / $(ts_utc) ==="
  return 0
}

# ══════════════════════════════════════════════════════════════
# dry-run: 비파괴 스냅샷 함수만 1회 실행하고 종료 (프리플라이트용)
# ══════════════════════════════════════════════════════════════
if [ "${AC5_DRY_RUN:-0}" = "1" ]; then
  log ""
  log "########## DRY-RUN (비파괴, kill 없음) $(ts_kst) ##########"
  log "드라이버 경로 = $SELF"
  log "드라이버 md5  = $SELF_MD5"
  snapshot "DRY-RUN" > /dev/null
  log "########## DRY-RUN 종료 $(ts_kst) ##########"
  exit 0
fi

# ══════════════════════════════════════════════════════════════
# 본 배치
# ══════════════════════════════════════════════════════════════
T0_candidate=$LAST_HEAL_REF_EPOCH
[ "$T0_candidate" -gt 0 ] && T0_candidate=$((T0_candidate + GAP_SEC))
now_e=$(epoch)
[ "$T0_candidate" -lt "$now_e" ] && T0_candidate=$now_e

R6_AT=$T0_candidate
R7_AT=$((R6_AT + GAP_SEC))
R8_AT=$((R7_AT + GAP_SEC))
R9_AT=$((R8_AT + GAP_SEC))

sep
log "=== AC5 재현 배치 드라이버 시작 $(ts_kst) / $(ts_utc) ==="
log "  드라이버 경로 = $SELF"
log "  드라이버 md5  = $SELF_MD5"
log "  host = $(hostname)"
log "  직전 배치 마지막 치유 기준시각 = 2026-08-13 01:05:54 KST (+2h 게이트)"
log "  계획:"
log "    R6 @ $(TZ=Asia/Seoul date -d @$R6_AT +'%Y-%m-%d %H:%M:%S KST')"
log "    R7 @ $(TZ=Asia/Seoul date -d @$R7_AT +'%Y-%m-%d %H:%M:%S KST')"
log "    R8 @ $(TZ=Asia/Seoul date -d @$R8_AT +'%Y-%m-%d %H:%M:%S KST')"
log "    R9 @ $(TZ=Asia/Seoul date -d @$R9_AT +'%Y-%m-%d %H:%M:%S KST') (최악 위상, ~59s)"
log "  heal.conf(출하) = $(cat $STATE_DIR/heal.conf 2>/dev/null || echo MISSING)"

wait_until(){
  local target=$1 remaining
  remaining=$((target - $(epoch)))
  if [ "$remaining" -gt 0 ]; then
    log "  대기 중 — $(ts_kst) 부터 $((remaining/60))분 ${remaining}s 뒤 시작"
    sleep "$remaining"
  fi
}

wait_until "$R6_AT"; do_round "R6" 0
wait_until "$R7_AT"; do_round "R7" 0
wait_until "$R8_AT"; do_round "R8" 0
wait_until "$R9_AT"; do_round "R9" 1

sep
log "=== AC5_BATCH_R6toR9_COMPLETE $(ts_kst) / $(ts_utc) ==="
