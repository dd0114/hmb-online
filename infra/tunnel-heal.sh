#!/usr/bin/env bash
# HMB 터널 자가복구 워치독 — 에픽 #183 접근 C. **정적 스크립트, Claude 호출 0**(patrol-static 패턴).
#
#   bash infra/tunnel-heal.sh --selftest   # 도구·해석기·자격증명 사전점검 (아무것도 안 바꿈)
#   bash infra/tunnel-heal.sh --check      # 현재 터널 진단만 (아무것도 안 바꿈)
#   bash infra/tunnel-heal.sh --once       # 점검 + 필요시 치유  ← launchd 가 60초마다 부른다
#
# 설치: bash infra/install-tunnel-heal.sh   (~/.local/bin 로 복사 + launchd 등록)
#
# ── 왜 이 모양인가 (실측 근거) ────────────────────────────────────────────────────
# 1) **PID 생존은 헬스가 아니다.** 2026-07-22 실제 장애 = cloudflared 프로세스는 살아 있는데
#    터널 등록만 만료돼 호스트명이 죽었다(`control stream failure` 루프). 그래서 판정은
#    "프로세스 있나" 가 아니라 **실제 왕복이 되나** 로만 한다.
# 2) **1.1.1.1 은 이 네트워크에서 안 뜬다**(실측: dig @1.1.1.1 → connection timed out).
#    반대로 ISP DNS 는 trycloudflare 를 잘 풀 때도 있고 NXDOMAIN 일 때도 있다(07-22 기록).
#    → 해석기를 **여러 개 순차 시도**하고, 전부 실패해야 DNS 사망으로 본다.
# 3) **헬스 프로브에 토큰이 필요 없다.** 터널로 `GET /internal/health` 를 토큰 없이 때리면
#    java 가 **401** 을 준다(실측). 401 이 왔다는 것 자체가 "터널→백엔드 경로가 살아있다" 는
#    증거다. 반대로 000/502/503/504/530 은 CF 가 오리진에 못 닿은 것. 부작용 0 이라 매분 쳐도 된다.
#    (status.sh 가 쓰는 POST /api/auth/login 은 매분 유저를 만드는 셈이라 워치독엔 부적합.)
# 4) **백엔드가 죽었으면 터널을 재기동하지 않는다.** 그건 다른 고장(F4)이고, 재기동해봐야
#    똑같이 502 라 스래시만 난다. 로그만 남기고 빠진다.
# 5) 프로세스 종료는 **PID 로만**. `pkill -f cloudflared` 는 다른 세션 스택을 죽인다(전역 규칙).

set -uo pipefail   # -e 는 쓰지 않는다 — 헬스 실패는 예외가 아니라 정상 흐름이다

PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
export PATH

# ── 설정 (전부 env 로 덮어쓸 수 있다) ──────────────────────────────────────────────
BACKEND_PORT="${HMB_BACKEND_PORT:-18080}"          # 데모 8080/8790 은 절대 건드리지 않는다
TUNNEL_LOG="${HMB_TUNNEL_LOG:-/tmp/hmb-cf-tunnel.log}"
TUNNEL_PID="${HMB_TUNNEL_PID:-/tmp/hmb-cf-tunnel.pid}"
STATE_DIR="${HMB_STATE_DIR:-$HOME/.local/state/hmb}"
HEAL_LOG="$STATE_DIR/tunnel-heal.log"
HEALS_FILE="$STATE_DIR/heals.tsv"
LOCK="$STATE_DIR/deploy.lock"
PUBLISH="${HMB_PUBLISH_CMD:-$HOME/.local/bin/hmb-publish-backend-url.sh}"
RESOLVERS="${HMB_RESOLVERS:-system 8.8.8.8 9.9.9.9 1.1.1.1}"
CONFIRM_SLEEP="${HMB_CONFIRM_SLEEP:-10}"           # 1차 실패 후 재확인까지 (일시적 blip 흡수)
MAX_HEALS_PER_HOUR="${HMB_MAX_HEALS_PER_HOUR:-3}"  # 초과 시 DEGRADED — 무한 재기동 방지
DNS_WAIT="${HMB_DNS_WAIT:-120}"                    # 새 호스트가 글로벌 DNS 에 뜰 때까지 대기 상한
PROBE_TIMEOUT="${HMB_PROBE_TIMEOUT:-12}"

mkdir -p "$STATE_DIR"

MODE="${1:---check}"
now(){ date +%s; }
iso(){ date -u +%Y-%m-%dT%H:%M:%SZ; }
say(){ printf '%s\n' "$*"; }
record(){ printf '%s\t%s\t%s\t%s\n' "$(now)" "$(iso)" "$1" "${2:-}" >> "$HEAL_LOG"; }

# ── 해석기 폴백: 하나라도 IP 를 주면 그 IP 를 쓴다 ──────────────────────────────────
resolve_ip(){
  local host="$1" r ip
  for r in $RESOLVERS; do
    if [ "$r" = "system" ]; then
      ip=$(dig +short +time=3 +tries=1 "$host" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1)
    else
      ip=$(dig +short +time=3 +tries=1 "@$r" "$host" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1)
    fi
    [ -n "$ip" ] && { printf '%s %s' "$ip" "$r"; return 0; }
  done
  return 1
}

current_url(){ grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | tail -1; }

# 왕복 프로브. echo "<verdict> <detail>" — verdict = ok | dns | http:<code>
probe(){
  local url="$1" host ip_r ip res code
  host="${url#https://}"; host="${host%%/*}"
  if ! ip_r=$(resolve_ip "$host"); then printf 'dns 해석기(%s) 전부 실패' "$RESOLVERS"; return 1; fi
  ip="${ip_r%% *}"; res="${ip_r##* }"
  code=$(curl -s -o /dev/null -w '%{http_code}' -m "$PROBE_TIMEOUT" \
         --resolve "$host:443:$ip" "https://$host/internal/health" 2>/dev/null)
  case "$code" in
    # java 가 응답했다 = 터널→백엔드 경로 정상. 토큰 없는 401 이 정상 응답이다.
    200|401|403|404) printf 'ok http=%s ip=%s via=%s' "$code" "$ip" "$res"; return 0;;
    *)               printf 'http:%s ip=%s via=%s' "${code:-000}" "$ip" "$res"; return 1;;
  esac
}

# 로컬 백엔드가 살아있나 (터널 무관). 응답 코드가 오면 살아있는 것.
backend_alive(){
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://localhost:$BACKEND_PORT/internal/health" 2>/dev/null)
  case "$code" in 200|401|403|404) return 0;; *) return 1;; esac
}

heals_last_hour(){
  local cutoff; cutoff=$(( $(now) - 3600 ))
  [ -f "$HEALS_FILE" ] || { echo 0; return; }
  awk -F'\t' -v c="$cutoff" '$1 >= c' "$HEALS_FILE" | wc -l | tr -d ' '
}

# ── 락 (사람의 수동 배포와 겹치지 않게) ────────────────────────────────────────────
LOCK_OWNED=0
try_lock(){
  if mkdir "$LOCK" 2>/dev/null; then echo $$ > "$LOCK/pid"; LOCK_OWNED=1; return 0; fi
  local owner; owner=$(cat "$LOCK/pid" 2>/dev/null || echo "")
  if [ -n "$owner" ] && ! ps -p "$owner" >/dev/null 2>&1; then
    rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null && { echo $$ > "$LOCK/pid"; LOCK_OWNED=1; return 0; }
  fi
  return 1
}
cleanup(){ [ "$LOCK_OWNED" = "1" ] && rm -rf "$LOCK"; return 0; }
trap cleanup EXIT

# ── 치유 ───────────────────────────────────────────────────────────────────────────
heal(){
  local reason="$1" old_url new_url pid probe_out

  if ! backend_alive; then
    record BACKEND_DOWN "터널 재기동 안 함(스래시 방지) — localhost:$BACKEND_PORT 무응답"
    say "✗ 로컬 백엔드(:$BACKEND_PORT)가 죽어 있다 → 터널 재기동은 무의미. 도커부터 살려야 한다:"
    say "    cd <repo>/infra && docker compose up -d java runner"
    return 4
  fi

  local n; n=$(heals_last_hour)
  if [ "$n" -ge "$MAX_HEALS_PER_HOUR" ]; then
    record DEGRADED "1시간 내 치유 $n 회 ≥ 상한 $MAX_HEALS_PER_HOUR — 백오프"
    say "✗ DEGRADED — 1시간에 $n 번 치유했다(상한 $MAX_HEALS_PER_HOUR). 반복 사망은 사람이 봐야 한다."
    return 5
  fi

  if ! try_lock; then
    say "· 다른 배포/치유가 진행 중(락) — 이번 틱은 건너뛴다"; return 0
  fi

  old_url=$(current_url)
  record HEAL_START "reason=$reason old=${old_url:-<없음>}"
  say "▶ 치유 시작 (사유: $reason, 기존 URL: ${old_url:-없음})"

  # 1) 기존 터널 종료 — **PID 로만**, 그리고 그 PID 가 정말 cloudflared 인지 확인하고서.
  if [ -f "$TUNNEL_PID" ]; then
    pid=$(cat "$TUNNEL_PID" 2>/dev/null)
    if [ -n "$pid" ] && ps -p "$pid" -o comm= 2>/dev/null | grep -q cloudflared; then
      kill "$pid" 2>/dev/null; sleep 2
      ps -p "$pid" >/dev/null 2>&1 && { kill -9 "$pid" 2>/dev/null; sleep 1; }
      say "· 기존 터널 종료 (pid $pid)"
    else
      say "· PID 파일이 가리키는 프로세스가 cloudflared 가 아님 — 종료하지 않는다(다른 세션 보호)"
    fi
  fi

  # 2) 새 터널
  [ -f "$TUNNEL_LOG" ] && mv -f "$TUNNEL_LOG" "$TUNNEL_LOG.prev" 2>/dev/null
  nohup cloudflared tunnel --url "http://localhost:$BACKEND_PORT" --no-autoupdate > "$TUNNEL_LOG" 2>&1 &
  echo $! > "$TUNNEL_PID"
  say "· 새 터널 기동 (pid $(cat "$TUNNEL_PID"))"

  for _ in $(seq 1 30); do new_url=$(current_url); [ -n "$new_url" ] && break; sleep 2; done
  if [ -z "${new_url:-}" ]; then
    record HEAL_FAIL "새 URL 획득 실패 — $TUNNEL_LOG"
    say "✗ 새 URL 을 못 얻었다 — $TUNNEL_LOG 확인"; return 1
  fi
  say "· 새 URL = $new_url"

  # 3) 글로벌 DNS 등록 + 왕복이 될 때까지 대기 (배포보다 먼저 확인 — 죽은 주소를 퍼뜨리지 않는다)
  local waited=0
  while [ "$waited" -lt "$DNS_WAIT" ]; do
    if probe_out=$(probe "$new_url"); then
      say "· 왕복 확인 ($probe_out, ${waited}s)"; break
    fi
    sleep 5; waited=$((waited + 5))
  done
  if [ "$waited" -ge "$DNS_WAIT" ]; then
    record HEAL_FAIL "새 터널이 ${DNS_WAIT}s 안에 살아나지 않음 url=$new_url"
    say "✗ 새 터널이 ${DNS_WAIT}s 안에 응답하지 않는다"; return 1
  fi

  # 4) web 에 전파 (재빌드 없음 — config.json 만)
  if [ ! -x "$PUBLISH" ]; then
    record HEAL_FAIL "publish 스크립트 없음: $PUBLISH"
    say "✗ 전파 스크립트가 없다: $PUBLISH (install-tunnel-heal.sh 재실행 필요)"; return 1
  fi
  if HMB_LOCK_HELD=1 HMB_PUBLISH_SOURCE=heal "$PUBLISH" "$new_url" >> "$HEAL_LOG.publish" 2>&1; then
    printf '%s\t%s\t%s\n' "$(now)" "$(iso)" "$new_url" >> "$HEALS_FILE"
    record HEAL_OK "old=${old_url:-<없음>} new=$new_url"
    say "✓ 치유 완료 — web 이 $new_url 을 가리킨다"
    return 0
  fi
  record HEAL_FAIL "전파 실패 url=$new_url (로그: $HEAL_LOG.publish)"
  say "✗ 전파 실패 — $HEAL_LOG.publish 확인 (터널 자체는 살아있다: $new_url)"
  return 1
}

# ── 모드 ───────────────────────────────────────────────────────────────────────────
case "$MODE" in
  --selftest)
    rc=0
    for c in cloudflared dig curl npx; do
      if command -v "$c" >/dev/null 2>&1; then say "✓ $c = $(command -v "$c")"; else say "✗ $c 없음"; rc=1; fi
    done
    ok_r=""
    for r in $RESOLVERS; do
      if [ "$r" = system ]; then dig +short +time=3 +tries=1 example.com >/dev/null 2>&1 && ok_r="$ok_r system"
      else dig +short +time=3 +tries=1 "@$r" example.com 2>/dev/null | grep -qE '^[0-9]' && ok_r="$ok_r $r"; fi
    done
    if [ -n "$ok_r" ]; then say "✓ 쓸 수 있는 해석기:$ok_r"; else say "✗ 해석기 전멸 — 헬스판정 불가"; rc=1; fi
    [ -f "$HOME/.config/hmb/deploy.env" ] && say "✓ CF 자격증명 파일 있음" || { say "✗ ~/.config/hmb/deploy.env 없음"; rc=1; }
    [ -f "${HMB_DIST_CACHE:-$HOME/.cache/hmb/dist-current}/index.html" ] \
      && say "✓ dist 캐시 있음 (${HMB_DIST_CACHE:-$HOME/.cache/hmb/dist-current})" \
      || { say "✗ dist 캐시 없음 — deploy-web.sh 를 한 번 돌려야 전파가 가능하다"; rc=1; }
    [ -x "$PUBLISH" ] && say "✓ 전파 스크립트 $PUBLISH" || { say "✗ 전파 스크립트 없음: $PUBLISH"; rc=1; }
    backend_alive && say "✓ 로컬 백엔드 :$BACKEND_PORT 응답" || say "! 로컬 백엔드 :$BACKEND_PORT 무응답(치유는 보류된다)"
    exit $rc;;

  --check|--once)
    url=$(current_url)
    if [ -z "$url" ]; then
      say "✗ 터널 URL 을 모른다 ($TUNNEL_LOG 에 기록 없음)"
      [ "$MODE" = "--once" ] && { heal "url-unknown"; exit $?; }
      exit 1
    fi
    if out=$(probe "$url"); then
      say "✓ 터널 정상 — $url ($out)"
      exit 0
    fi
    say "! 1차 실패 — $url ($out)"
    [ "$MODE" = "--check" ] && { say "  (--check 모드: 아무것도 하지 않음)"; exit 1; }
    sleep "$CONFIRM_SLEEP"
    if out2=$(probe "$url"); then
      say "✓ 재확인에서 회복 — $url ($out2). 일시적 blip 으로 판단, 치유 안 함"
      record BLIP "url=$url first=$out"
      exit 0
    fi
    say "✗ 2회 연속 실패 — $url ($out2)"
    record UNHEALTHY "url=$url detail=$out2"
    heal "unhealthy:$out2"
    exit $?;;

  *)
    say "usage: $(basename "$0") [--selftest|--check|--once]"; exit 64;;
esac
