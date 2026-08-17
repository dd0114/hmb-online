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

# launchd 는 최소 PATH 로 부른다 → 필요한 디렉토리를 앞에 붙여 고정한다.
# `HMB_BIN_PREFIX` = 그보다 **더 앞**에 놓을 탐색 경로. 두 용도가 있다:
#   ① 특정 cloudflared 빌드를 지정할 때
#   ② **테스트 주입** — 이 줄이 호출자의 PATH 를 덮어써서, 가짜 도구를 앞에 깔아도 시스템
#      바이너리가 이겼다(#505 하네스가 이 자리에서 통째로 무력화됐다. 실패 주입이 불가능한
#      스크립트는 "고쳤다"를 증명할 방법이 없다).
PATH="${HMB_BIN_PREFIX:+$HMB_BIN_PREFIX:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
export PATH

# ── 설정 (전부 env 로 덮어쓸 수 있다) ──────────────────────────────────────────────
BACKEND_PORT="${HMB_BACKEND_PORT:-18080}"          # 데모 8080/8790 은 절대 건드리지 않는다
TUNNEL_LOG="${HMB_TUNNEL_LOG:-/tmp/hmb-cf-tunnel.log}"
TUNNEL_PID="${HMB_TUNNEL_PID:-/tmp/hmb-cf-tunnel.pid}"
STATE_DIR="${HMB_STATE_DIR:-$HOME/.local/state/hmb}"

# ── 런타임 노브 파일 ───────────────────────────────────────────────────────────────
# launchd plist 는 PATH·HOME 만 넘긴다 → **env 로는 런타임 조정이 안 된다**(plist 를 고치고
# 다시 로드해야 한다). 회선이 불안정한 날 상한만 잠깐 올리려고 재설치하는 건 과하다.
# 그래서 틱마다 이 파일을 읽는다. 없으면 기본값 그대로다.
#
#   printf 'HMB_HEAL_MAX_PER_HOUR=6\n' > ~/.local/state/hmb/heal.conf   # 일시 상향
#   rm ~/.local/state/hmb/heal.conf                                     # 원복
HEAL_CONF="${HMB_HEAL_CONF:-$STATE_DIR/heal.conf}"
# shellcheck disable=SC1090
[ -f "$HEAL_CONF" ] && . "$HEAL_CONF"

HEAL_LOG="$STATE_DIR/tunnel-heal.log"
HEALS_FILE="$STATE_DIR/heals.tsv"
LOCK="$STATE_DIR/deploy.lock"
PUBLISH="${HMB_PUBLISH_CMD:-$HOME/.local/bin/hmb-publish-backend-url.sh}"
RESOLVERS="${HMB_RESOLVERS:-system 8.8.8.8 9.9.9.9 1.1.1.1}"
CONFIRM_SLEEP="${HMB_CONFIRM_SLEEP:-10}"           # 1차 실패 후 재확인까지 (일시적 blip 흡수)
DEGRADED_MARK="$STATE_DIR/DEGRADED"                # status.sh 가 첫 줄에 띄우는 마커
DNS_WAIT="${HMB_DNS_WAIT:-120}"                    # 새 호스트가 글로벌 DNS 에 뜰 때까지 대기 상한
PROBE_TIMEOUT="${HMB_PROBE_TIMEOUT:-12}"

# ── 재시도 예산: 세 축 (#505) ──────────────────────────────────────────────────────
#
# 구조는 `MAX_HEALS_PER_HOUR=3` **한 노브**였고, 그 하나가 서로 다른 두 질문을 겸했다:
#   ⓐ "이 장애 하나를 고치는 데 몇 번까지 시도할까"  ⓑ "한 시간에 장애를 몇 번까지 처리할까"
# 겸직의 대가가 실측으로 나왔다 — 최근 4개 장애에서 **첫 시도는 4/4 실패**했다(복구를 만드는
# 것은 언제나 재시도다). 그런데 상한이 3 이라 **여유가 한 번뿐**이었고, 08-13 12:09 건은
# 정확히 3번째에 성공했다(한계에 닿았다). 08-14 09:59 건은 두 번 실패하고 사람이 갔다.
#
#   축1 재시도 예산 — 장애 1건당 연속 시도 (기본 5)
#   축2 장애 상한   — 시간당 '서로 다른 장애' 처리 횟수 (기본 3) ← 구 노브의 진짜 의도
#   축3 폭주 방지선 — 종류 불문 시간당 절대 시도 상한 (기본 15) ← 위 두 축의 회계가 틀렸을 때만 걸린다
#
# 값의 근거(`heals.tsv` 전수, 08-10~08-14):
#   · 한 장애를 고치는 데 실제로 든 시도 = 최대 **3**. 예산 5 = 실측 최악 + 2.
#   · 장애 **내부** 시도 간격 = 172~360초 / 장애 **사이** = 3509초 이상 → 경계 900초로 깨끗이 갈린다.
#   · 시간당 장애 수 실측 최대 = **1**. 3 은 플랩(같은 시간에 계속 죽는다)만 잡는 선이다.
#   · 시간당 시도 수 실측 최대 = **3**. 15 는 정상 운전에서 절대 안 걸린다 = 그게 방지선의 역할이다(#391).
HEAL_TRIES_PER_INCIDENT="${HMB_HEAL_TRIES:-5}"
INCIDENT_GAP="${HMB_HEAL_INCIDENT_GAP:-900}"
MAX_INCIDENTS_PER_HOUR="${HMB_HEAL_MAX_INCIDENTS_PER_HOUR:-3}"
# ⚠️ 구 이름 두 개를 계속 받는다 — 이미 그 이름을 쓰는 곳이 있으면 조용히 무시되는 게 최악이다.
#    ⚠️ **의미가 바뀌었다**: 이 노브는 이제 축3(절대 방지선)이지 축1·2 가 아니다. `heal.conf` 로
#    `HMB_HEAL_MAX_PER_HOUR=6` 을 걸어 두던 완화책은 이제 **축2**(`HMB_HEAL_MAX_INCIDENTS_PER_HOUR`)
#    를 올려야 한다. DEGRADED 메시지가 어느 축이 걸렸는지 이름으로 알려준다.
MAX_HEALS_PER_HOUR="${HMB_HEAL_MAX_PER_HOUR:-${HMB_MAX_HEALS_PER_HOUR:-15}}"

# 소모된 시도 사이의 백오프. 실측 자연 간격이 172~360초라 이 값들은 평소엔 **걸리지 않는다** —
# 아래 DNS 게이트가 시도를 싸게 만든 뒤(무산은 예산을 안 쓴다) 연타가 될 때만 무는 브레이크다.
HEAL_RETRY_BASE="${HMB_HEAL_RETRY_BASE:-60}"       # 1회 실패 후 60s → 120 → 240 → 상한
HEAL_RETRY_MAX="${HMB_HEAL_RETRY_MAX:-300}"

# ── 선행조건 게이트: cloudflared 의 등록 엔드포인트가 풀리나 (#505) ────────────────
# 2026-08-14 09:59 장애의 1차 실패는 우리 코드가 아니라 **cloudflared 의 DNS** 였다:
#   `failed to request quick Tunnel: … lookup api.trycloudflare.com: no such host`
# 그 상태에서 시도해봐야 무조건 실패하는데, 지금 구조는 그 무산에 **예산을 한 칸 쓰고**
# 멀쩡히 살아 있는(=530 이어도 프로세스는 있는) 기존 터널까지 죽인다. 둘 다 손해다.
# → 시도 **전에** 이름이 풀리는지 보고, 안 풀리면 예산도 안 쓰고 기존 터널도 안 건드리고 빠진다.
#   다음 틱(60초)이 다시 본다 = DNS 가 돌아오는 즉시 복구가 시작된다(백오프보다 빠르다).
# ⚠️ **system 해석기로만** 판정한다 — cloudflared 가 쓰는 것이 그것이라서다. 공개 해석기가
#    풀린다고 통과시키면 게이트가 cloudflared 의 현실과 다른 것을 보게 된다.
# ⚠️ 게이트가 **영구 차단이 되면 안 된다**(dig 는 실패하는데 cloudflared 는 되는 경우가 있다 —
#    probe() 가 같은 이유로 "해석기 전멸해도 단정하지 않는다"를 한다). 데드라인을 넘기면 그냥 시도한다.
TUNNEL_REG_HOST="${HMB_TUNNEL_REG_HOST:-api.trycloudflare.com}"
DNS_GATE_MAX="${HMB_HEAL_DNS_GATE_MAX:-600}"
DEFER_MARK="$STATE_DIR/heal-defer"

# ── cloudflared 로그 보관함 (#505 B) ──────────────────────────────────────────────
# 2026-08-14 2차 시도의 실패 사유는 **영구 소실**됐다: 로그가 `/tmp/…log` 단일 파일이고
# 회전은 `.prev` 한 장뿐이라, 사람이 돌린 `start-tunnel.sh` 가 원본을 덮고 그 전에 치유가
# `.prev` 를 1차분으로 덮어 두 시도 중 하나만 남았다. 시도마다 타임스탬프로 남긴다.
# ⚠️ 보관함은 `/tmp` 가 아니라 STATE_DIR 아래다 — /tmp 는 부팅 때 비워진다(#497).
TUNNEL_LOG_DIR="${HMB_TUNNEL_LOG_DIR:-$STATE_DIR/tunnel-logs}"
TUNNEL_LOG_KEEP="${HMB_TUNNEL_LOG_KEEP:-20}"

# ── 전파 예산은 실행 상한을 **알아야 한다** (#508, 2026-08-17 라이브 장애) ──────────
# 그날의 산수: `wrangler pages deploy` 상한 240s × 재시도 3회인데 자기마감은 **420s** 다.
# 1회 최악 비용 ≈ 240(배포)+10(kill 유예)+30(검증 폴)+15(백오프) ≈ 295s 라 **2번째 시도 완주부터
# 이미 마감을 넘는다**(3번째만이 아니다). ⚠️ 그런데 실측(launchd unified log, #514 재검증)은 더
# 나쁘다 — "구조적으로 못 끝난다"던 3번째 시도가 **실제로 돌았다**: 자기마감 킬러(TERM→5s→KILL)가
# TERM trap(`kill $SELF_TIMER; cleanup` — exit 없음)에 **무장해제**되는 레이스가 있어, 메인이 짧은
# 명령(검증 폴링 sleep 등) 중에 TERM 을 받으면 trap 이 5초 안에 타이머를 먼저 죽이고 락을 풀고
# **마감 없이 계속 달린다**. 그날 03:29:03 틱(pid 94414)이 그렇게 28분 34초를 돌았고(RUN_TIMEOUT
# 03:36:41 기록 후 생존), 그 한 틱이 MTTR 34분의 지배 항이다. launchd 는 이전 인스턴스가 살아
# 있는 동안 재스폰하지 않으므로 그 28분간 심박도 멈췄다(락 기아가 아니라 무스폰이 원인 —
# KILL 로 죽은 틱의 락은 try_lock 의 죽은-소유자 회수가 다음 틱에서 훔쳐온다). 레이스 자체는
# 이 PR 스코프 밖(별도 수정 대상)이고, 여기서는 그 전제 위에서도 성립하는 축을 더한다:
# **재시도 예산(#505)은 시도 횟수만 봤지 한 번의 시도가 남은 시간 안에 끝날 수 있는지를 안 봤다**
# — 세 축 어디에도 이 축이 없었다. 처방: 시도를 시작하기 전에 **남은 실행 시간**과 **1회 비용**을
# 비교한다. 못 끝낼 시도는 시작하지 않고(실패가 아니라 **무산**이다) 다음 틱으로 넘긴다.
# 이 게이트는 마감이 무장해제된 틱에서도 잔여시간이 음수로 계산돼 전파 루프를 즉시 접는다 —
# 그날의 28분 중 전파 재시도가 태운 ~21분이 이 한 줄로 사라진다.
RUN_STARTED=$(date +%s)
PUBLISH_VERIFY_COST="${HMB_PUBLISH_VERIFY_COST:-45}"   # 검증 폴링(6×5s) + 여유
DEPLOY_TIMEOUT="${HMB_DEPLOY_TIMEOUT:-240}"            # publish 쪽 상한(그대로 넘긴다)
DEPLOY_TIMEOUT_MIN="${HMB_DEPLOY_TIMEOUT_MIN:-60}"     # 이보다 짧게 줄 바엔 시작하지 않는다

mkdir -p "$STATE_DIR"

MODE="${1:---check}"
now(){ date +%s; }
iso(){ date -u +%Y-%m-%dT%H:%M:%SZ; }
say(){ printf '%s\n' "$*"; }
record(){ printf '%s\t%s\t%s\t%s\n' "$(now)" "$(iso)" "$1" "${2:-}" >> "$HEAL_LOG"; }

# ── 심박(heartbeat) — "돌긴 돌았나" 를 치유 여부와 **분리**해 남긴다 (#497) ─────────────
# 왜 필요한가: 2026-08-13 재부팅 후 워치독은 매 틱 spawn 자체에 실패했고(WorkingDirectory 소거,
# EX_CONFIG 78) 그래서 **아무 로그도 남기지 않았다.** 그런데 기존 가시화는 전부
# `tunnel-heal.log` 의 마지막 줄을 본다 — 그 로그는 **뭔가 일어났을 때만** 늘어난다.
# 즉 "정상이라 조용한 것" 과 "죽어서 조용한 것" 이 **같은 모양**이었고, status.sh 는 33분 내내
# ✓ 를 찍었다. 그래서 매 틱 **무조건** 갱신되는 파일을 따로 둔다: 이 파일이 낡으면 그것만으로
# "워치독이 안 돈다" 가 증명된다(로그가 조용한 이유를 추측하지 않아도 된다).
# ⚠️ 틱의 **맨 앞**에서 찍는다 — 뒤에서 찍으면 본체가 매달렸을 때 같이 침묵해 구분력이 사라진다.
HEARTBEAT="${HMB_HEARTBEAT:-$STATE_DIR/last-tick}"
beat(){ printf '%s\t%s\t%s\n' "$(now)" "$(iso)" "$MODE" > "$HEARTBEAT" 2>/dev/null || true; }

# ── DEGRADED 가시화 ────────────────────────────────────────────────────────────────
# 백오프에 들어간 걸 **로그를 열어야만** 알 수 있으면 아무도 모른다(실측: 2026-07-31 에 상한을
# 소진하고 자동 복구가 멈춰 있었는데 status.sh 는 계속 ✓ 만 보여줬다).
# 마커 파일 하나로 끝낸다 — status.sh 가 첫 줄에 띄운다. 별도 알림 시스템은 만들지 않는다.
degraded_mark(){ printf '%s\t%s\n' "$(iso)" "$1" > "$DEGRADED_MARK"; }
degraded_clear(){ [ -f "$DEGRADED_MARK" ] && { rm -f "$DEGRADED_MARK"; record DEGRADED_CLEARED ""; }; return 0; }

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

# ⚠️ `grep -a` 필수 — cloudflared 로그에 제어문자가 섞이면 grep 이 **바이너리로 판정**해
#    매치 대신 "Binary file … matches" 를 돌려준다. 그 문자열이 URL 자리에 들어가 전파가
#    깨진 전례가 있다(2026-07-30 12:11Z 반쪽 치유 — HEAL_OK 인데 config.json 은 옛 URL).
#
# ⚠️ **`api.trycloudflare.com` 을 배제해야 한다** — cloudflared 는 자기 **등록 엔드포인트**
#    `https://api.trycloudflare.com` 을 로그에 찍는다. 그건 우리 터널 주소가 아니다. 이 정규식이
#    그것까지 먹어서 2026-08-01 에 **같은 방식으로 두 번**(09:28Z·14:08Z) 치유가 통째로 실패했다:
#    `HEAL_FAIL … url=https://api.trycloudflare.com`. 살아있는 주소를 놔두고 남의 주소를 프로브하니
#    영원히 안 산다. 배정된 호스트는 항상 서브도메인이 3어절 이상이라 `api.` 만 빼면 충분하다.
current_url(){
  grep -aoE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null \
    | grep -v '^https://api\.trycloudflare\.com$' | tail -1
}

# 왕복 프로브. echo "<verdict> <detail>" — verdict = ok | dns | http:<code>
probe(){
  local url="$1" host ip_r ip res code
  host="${url#https://}"; host="${host%%/*}"
  if ! ip_r=$(resolve_ip "$host"); then
    # 해석기가 전부 빈손이어도 **터널이 죽었다고 단정하지 않는다**: 실측에서 dig 4개가 모두
    # 빈손인 순간에도 브라우저는 정상 왕복했다(해석기 일시 장애/레이트리밋). curl 자체 해석으로
    # 한 번 더 확인하고, 그것까지 실패해야 사망으로 본다. (없으면 멀쩡한 터널을 죽이게 된다.)
    code=$(curl -s -o /dev/null -w '%{http_code}' -m "$PROBE_TIMEOUT" "https://$host/internal/health" 2>/dev/null)
    case "$code" in
      200|401|403|404) printf 'ok http=%s via=curl-direct(해석기 전멸)' "$code"; return 0;;
      *) printf 'dns 해석기(%s) 전부 실패 + curl 직결 http=%s' "$RESOLVERS" "${code:-000}"; return 1;;
    esac
  fi
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

# 상한은 **시도** 기준으로 센다. 성공만 세면 "매번 실패하는 치유" 가 상한에 안 걸려 무한
# 재기동으로 번진다(실측: 전파가 3연속 실패하자 매 틱 새 터널을 만들어 URL 이 4번 바뀌었다).
#
# `heals.tsv` 는 append-only 라 시각이 오름차순이다. 그 한 파일에서 세 축을 다 뽑는다:
#   출력 = "<현 장애의 소모 시도수> <마지막 시도 ts> <1시간 내 장애 수> <1시간 내 시도 수>"
# 현 장애 = 지금부터 뒤로 `INCIDENT_GAP` 안에 연쇄한 묶음. 연쇄가 끊기면 거기가 장애 경계다.
# ⚠️ 파일 포맷은 안 바꿨다(구 파일 그대로 읽힌다) — 마이그레이션이 필요 없어야 한다.
heal_stats(){
  [ -f "$HEALS_FILE" ] || { echo "0 0 0 0"; return; }
  awk -F'\t' -v now="$(now)" -v gap="$INCIDENT_GAP" '
    $1 ~ /^[0-9]+$/ { t[++n] = $1 + 0 }
    END {
      cur = 0; last = 0; inc = 0; att = 0
      if (n > 0) {
        last = t[n]
        if (now - t[n] <= gap) {
          cur = 1
          for (i = n - 1; i >= 1; i--) { if (t[i+1] - t[i] <= gap) cur++; else break }
        }
      }
      cutoff = now - 3600
      for (i = 1; i <= n; i++) if (t[i] >= cutoff) { att++; if (i == 1 || t[i] - t[i-1] > gap) inc++ }
      printf "%d %d %d %d", cur, last, inc, att
    }' "$HEALS_FILE"
}

# 자기마감까지 남은 초. 마감이 꺼져 있으면(0) 사실상 무한 — 그때는 이 축이 존재하지 않는다.
run_remaining(){
  [ "${RUN_DEADLINE:-0}" -gt 0 ] 2>/dev/null || { echo 99999; return; }
  echo $(( RUN_STARTED + RUN_DEADLINE - $(now) ))
}

# 이미 k 번 소모했을 때 다음 시도까지 기다릴 초. 60 → 120 → 240 → 상한(300).
backoff_for(){
  local k="${1:-0}" w="$HEAL_RETRY_BASE" i=1
  [ "$k" -le 0 ] && { echo 0; return; }
  while [ "$i" -lt "$k" ]; do
    w=$((w * 2)); i=$((i + 1))
    [ "$w" -ge "$HEAL_RETRY_MAX" ] && { w="$HEAL_RETRY_MAX"; break; }
  done
  echo "$w"
}

# cloudflared 가 쓰는 해석기(system)로만 본다 — 위 게이트 주석 참조.
reg_host_resolves(){
  dig +short +time=3 +tries=1 "$TUNNEL_REG_HOST" 2>/dev/null \
    | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'
}

# cloudflared 로그에서 사람이 읽을 실패 줄 하나. 없으면 마지막 줄이라도 준다.
cf_error_line(){
  local l
  l=$(grep -aiE 'failed|error|ERR |no such host|refused|timeout|unauthorized' "$TUNNEL_LOG" 2>/dev/null | tail -1)
  [ -z "$l" ] && l=$(tail -1 "$TUNNEL_LOG" 2>/dev/null)
  printf '%s' "$l" | tr '\t\n' '  ' | cut -c1-300
}

# 시도별 증거 보존. `.prev` 도 계속 쓴다(구 경로를 보는 사람이 있다).
archive_tunnel_log(){
  local tag="${1:-attempt}" f
  [ -s "$TUNNEL_LOG" ] || return 0
  mkdir -p "$TUNNEL_LOG_DIR" 2>/dev/null || return 0
  cp -f "$TUNNEL_LOG" "$TUNNEL_LOG_DIR/$(iso | tr -d ':-')-$tag.log" 2>/dev/null || true
  cp -f "$TUNNEL_LOG" "$TUNNEL_LOG.prev" 2>/dev/null || true
  # shellcheck disable=SC2012
  ls -1t "$TUNNEL_LOG_DIR"/*.log 2>/dev/null | tail -n +$((TUNNEL_LOG_KEEP + 1)) | while read -r f; do rm -f "$f"; done
  return 0
}

# Pages 가 현재 서빙 중인 백엔드 주소(실패하면 빈 문자열).
pages_backend(){
  curl -fsS -m 10 -H 'Cache-Control: no-cache' \
    "https://${PAGES_PROJECT:-hmb-online}.pages.dev/config.json?t=$(now)" 2>/dev/null \
    | sed -n 's/.*"apiBase" *: *"\([^"]*\)".*/\1/p' | head -1
}

# ── 전파(publish) + **독립 검증** + 재시도 ─────────────────────────────────────────
#
# ⚠️ 왜 publish 의 종료코드를 믿지 않는가 (2026-07-31 실장애, 로그인 불가 530 ×2회):
#    그날 `HEAL_OK` 가 찍혔는데 `config.json` 은 **죽은 URL 그대로**였다. 원인은 두 겹이었다 —
#    ① `wrangler pages deploy` 가 느린 회선에서 상한(150s)에 걸려 **SIGKILL(rc 137)** 로 죽었는데
#       publish 는 124 만 안내하고 137 은 조용히 넘겨 "왜 안 됐는지"가 로그에 안 남았다.
#    ② 그 결과가 어떻든, 치유 경로는 **"Pages 가 실제로 그 주소를 서빙하는가"를 스스로 확인하지
#       않았다**. 게다가 아래 쿨다운이 `HEAL_OK` 시각을 기준으로 잡혀 있어서, 거짓 HEAL_OK 는
#       **교정용 재전파까지 180초 동안 막아 버린다**(장애가 스스로 연장된다).
#
# 그래서 여기서는 **publish 를 돌린 뒤 워치독이 직접 다시 조회**하고, 일치할 때만 성공으로 본다.
# 실패하면 백오프로 재시도하고, 끝내 못 하면 성공으로 기록하지 않는다(= 쿨다운도 시작되지 않아
# 다음 틱이 곧바로 다시 시도한다).
publish_verified(){
  local url="$1" src="$2" tries="${3:-${HMB_PUBLISH_TRIES:-3}}"
  local i=1 backoff="${HMB_PUBLISH_BACKOFF:-15}" served=""
  # ⚠️ `PAGES_PROJECT` 은 **명시 전달**한다 — env 상속에 기대지 않는다(#489 단계3.5 패널 렌즈②).
  #    heal.conf 는 source 되므로 `export` 를 빠뜨리면 이 셸에는 값이 있는데 자식에는 없다 →
  #    publish 가 기본값(=라이브 hmb-online)으로 조용히 떨어진다. 그 한 글자가 "라이브 무접촉"의
  #    유일한 근거였다. 여기서 이름을 명시해 `export` 누락을 무해화한다.
  # ⚠️ 값이 **없을 때의 동작은 바꾸지 않는다** — 여기서 랩탑 기본값을 하드코딩하면 컷오버(단계4)가
  #    코드 변경이 된다. 없으면 종전대로 publish 쪽 기본값 결정에 맡긴다.
  local -a pass_env=(HMB_LOCK_HELD=1 "HMB_PUBLISH_SOURCE=$src")
  [ -n "${PAGES_PROJECT:-}" ] && pass_env+=("PAGES_PROJECT=$PAGES_PROJECT")
  local rem cap
  while [ "$i" -le "$tries" ]; do
    # ── 못 끝낼 시도는 시작하지 않는다 (#508) ────────────────────────────────────
    # 남은 실행 시간에 맞춰 배포 상한을 **줄여서** 넘긴다. 줄여도 최소치 미만이면 이번 틱은
    # 여기서 접는다 — 시작해봐야 `RUN_TIMEOUT` 으로 사유 없이 죽고 락만 쥐고 있게 된다.
    rem=$(run_remaining)
    cap=$(( rem - PUBLISH_VERIFY_COST ))
    [ "$cap" -gt "$DEPLOY_TIMEOUT" ] && cap="$DEPLOY_TIMEOUT"
    if [ "$cap" -lt "$DEPLOY_TIMEOUT_MIN" ]; then
      record PUBLISH_DEFER "실행 잔여 ${rem}s 로는 1회를 못 끝낸다(최소 $((DEPLOY_TIMEOUT_MIN + PUBLISH_VERIFY_COST))s) — try=$i/$tries, 다음 틱으로"
      say "· 남은 실행시간 ${rem}s — 이번 틱엔 전파를 시작하지 않는다(다음 틱이 이어서 한다)"
      return 1
    fi
    [ "$cap" -lt "$DEPLOY_TIMEOUT" ] && \
      record PUBLISH_CAP "배포 상한을 ${DEPLOY_TIMEOUT}s → ${cap}s 로 줄임(실행 잔여 ${rem}s) try=$i/$tries"
    env "${pass_env[@]}" "HMB_DEPLOY_TIMEOUT=$cap" "$PUBLISH" "$url" >> "$HEAL_LOG.publish" 2>&1 || true
    # 독립 검증 — publish 의 자기 신고가 아니라 **엣지가 주는 값**으로 판정한다.
    # 방금 올린 직후엔 엣지마다 반영이 몇 초 어긋나므로 잠깐 폴링한다.
    local j
    for j in 1 2 3 4 5 6; do
      served=$(pages_backend)
      if [ "$served" = "$url" ]; then
        [ "$i" -gt 1 ] && record PUBLISH_RETRY_OK "url=$url try=$i/$tries"
        return 0
      fi
      sleep 5
    done
    record PUBLISH_UNVERIFIED "try=$i/$tries url=$url served=${served:-<응답없음>}"
    say "· 전파 미확인 ($i/$tries) — web 이 아직 '${served:-<응답없음>}' 을 본다"
    i=$((i + 1))
    [ "$i" -le "$tries" ] && { sleep "$backoff"; backoff=$((backoff * 2)); }
  done
  return 1
}

# ── 전파 대상 게이트 (#489 단계3.5 — 랩탑이 라이브를 건드리지 않는다는 것을 **검사 가능**하게) ──
#
# 왜 필요한가: 랩탑 워치독이 라이브 Pages 프로젝트로 배포하지 않는 근거가 `heal.conf` 의
#   `export PAGES_PROJECT=hmb-online-lab` **한 줄뿐**인데, 그 한 줄을 강제하는 것이 아무 데도
#   없었다 — 설치기가 만들지도 않고(README 가 사람에게 부탁), `--selftest` 가 보지도 않고,
#   `publish-backend-url.sh` 의 기본값은 **라이브**다. 그래서 세 경로가 전부 *조용한 라이브 배포*
#   로 끝난다: ① 설치 직후 콜드 스타트 ② 파일 삭제 ③ `export` 누락. 셋 다 다른 AC 가 못 잡는다.
#
# ⚠️ 이 게이트는 **단계3.5 동안**의 것이다. 컷오버(단계4) = 라이브로 내보내는 것이 정답이 되는
#    시점이므로, 게이트가 컷오버를 영구히 막으면 안 된다 → `HMB_ALLOW_LIVE=1` 명시 옵트아웃.
LIVE_PROJECT="${HMB_LIVE_PROJECT:-hmb-online}"
selftest_publish_target(){
  if [ "${HMB_ALLOW_LIVE:-0}" = "1" ]; then
    say "! 전파 대상 게이트 우회 (HMB_ALLOW_LIVE=1) — 대상 = ${PAGES_PROJECT:-$LIVE_PROJECT} (라이브 허용 모드)"
    return 0
  fi
  if [ ! -f "$HEAL_CONF" ]; then
    say "✗ heal.conf 없음: $HEAL_CONF — 전파가 기본값 '$LIVE_PROJECT'(라이브)로 나간다"
    say "    처방:  printf 'export PAGES_PROJECT=hmb-online-lab\\n' > $HEAL_CONF"
    say "    라이브가 맞다면(컷오버):  HMB_ALLOW_LIVE=1 $0 --selftest"
    return 1
  fi
  say "✓ heal.conf 있음 ($HEAL_CONF)"
  local rc=0
  if grep -qE '^[[:space:]]*export[[:space:]]+PAGES_PROJECT=' "$HEAL_CONF"; then
    say "✓ heal.conf 에 'export PAGES_PROJECT' 선언"
  else
    # 워치독 자신은 이제 명시 전달(publish_verified)이라 export 없이도 새지 않는다. 그래도 ✗ 로
    # 잡는다 — heal.conf 를 source 하는 **다른 소비자**(사람의 수동 deploy-web.sh 등)는 여전히
    # env 상속에 의존하고, 그쪽이 새면 결과가 라이브 배포다.
    say "✗ heal.conf 의 PAGES_PROJECT 에 export 가 없다 — heal.conf 를 source 하는 다른 경로가 샌다"
    rc=1
  fi
  case "${PAGES_PROJECT:-}" in
    "")             say "✗ PAGES_PROJECT 가 비어 있다 — 전파가 기본값 '$LIVE_PROJECT'(라이브)로 나간다"; rc=1;;
    "$LIVE_PROJECT") say "✗ PAGES_PROJECT='$PAGES_PROJECT' = 라이브 프로젝트다. 랩탑은 별도 프로젝트여야 한다(단계3.5 고정 제약: 맥 무중단)"; rc=1;;
    *)              say "✓ 전파 대상 = '$PAGES_PROJECT' (라이브 '$LIVE_PROJECT' 아님)";;
  esac
  [ "$rc" -ne 0 ] && say "    (컷오버라면:  HMB_ALLOW_LIVE=1 $0 --selftest)"
  return "$rc"
}

# 터널은 멀쩡한데 web 만 옛 주소를 보고 있는 경우 = **터널을 건드릴 이유가 없다**.
# config 만 다시 올린다(수동 재기동·전파 실패 후 복구가 여기로 흡수된다).
publish_only(){
  local url="$1"
  [ -x "$PUBLISH" ] || { record PUBLISH_FAIL "스크립트 없음: $PUBLISH"; return 1; }
  if ! try_lock; then say "· 다른 배포/치유 진행 중 — 전파 보류"; return 0; fi
  say "▶ 터널은 정상인데 web 이 다른 주소를 본다 → config 만 재전파"
  if publish_verified "$url" heal-publish-only; then
    record PUBLISH_ONLY "url=$url"; say "✓ 전파 완료·검증됨 — web → $url"; return 0
  fi
  record PUBLISH_FAIL "url=$url (로그: $HEAL_LOG.publish)"; say "✗ 전파 실패 — $HEAL_LOG.publish"; return 1
}

# 방금 띄운 터널은 CF 엣지에 퍼지는 데 시간이 걸린다 — 갓 만든 터널을 죽이지 않기 위한 유예.
tunnel_age(){
  local pid; pid=$(cat "$TUNNEL_PID" 2>/dev/null)
  [ -n "$pid" ] || { echo 99999; return; }
  local et; et=$(ps -p "$pid" -o etime= 2>/dev/null | tr -d ' ')
  [ -z "$et" ] && { echo 99999; return; }
  # etime: [[dd-]hh:]mm:ss
  echo "$et" | awk -F'[:-]' '{ if (NF==2) print $1*60+$2; else if (NF==3) print $1*3600+$2*60+$3; else print 99999 }'
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

  # ── 선행조건: 등록 엔드포인트가 풀리나 (#505) ────────────────────────────────────
  # 안 풀리면 **예산을 쓰지 않고** 빠진다. 기존 터널도 죽이지 않는다 — 대체품을 못 만드는데
  # 죽이면 순수 손실이다(2026-08-14 1차 시도가 정확히 그렇게 했다).
  if [ "${HMB_HEAL_DNS_GATE:-1}" = "1" ] && ! reg_host_resolves; then
    local since elapsed
    since=$(cut -f1 "$DEFER_MARK" 2>/dev/null)
    case "${since:-}" in ''|*[!0-9]*) since=$(now); printf '%s\t%s\n' "$since" "$(iso)" > "$DEFER_MARK";; esac
    elapsed=$(( $(now) - since ))
    if [ "$elapsed" -lt "$DNS_GATE_MAX" ]; then
      record HEAL_DEFER "dns:$TUNNEL_REG_HOST 미해석 — 예산 무소모, 다음 틱 재시도 (${elapsed}s/${DNS_GATE_MAX}s)"
      say "· $TUNNEL_REG_HOST 가 안 풀린다 — 지금 시도해도 100% 실패한다. 예산 안 쓰고 대기(${elapsed}s/${DNS_GATE_MAX}s)"
      return 3
    fi
    # 데드라인 초과 = 게이트가 틀렸을 수 있다(dig 는 죽었는데 cloudflared 는 될 수 있다) → 그냥 시도한다.
    say "! $TUNNEL_REG_HOST 미해석이 ${elapsed}s 째다 — 게이트 신뢰 한도 초과, 그래도 시도한다"
    record HEAL_GATE_OVERRIDE "dns:$TUNNEL_REG_HOST ${elapsed}s ≥ ${DNS_GATE_MAX}s — 게이트 무시하고 시도"
  fi
  rm -f "$DEFER_MARK" 2>/dev/null || true

  # ── 예산 세 축 (#505) ────────────────────────────────────────────────────────────
  local cur last inc att need since_last
  read -r cur last inc att <<EOF
$(heal_stats)
EOF
  # 축3 — 폭주 방지선. 정상 운전에서 걸리면 그건 위 두 축의 회계가 틀린 것이다(#391 부류).
  if [ "$att" -ge "$MAX_HEALS_PER_HOUR" ]; then
    record DEGRADED "폭주방지선: 1시간 내 시도 $att 회 ≥ $MAX_HEALS_PER_HOUR"
    degraded_mark "폭주방지선 — 1시간 내 시도 $att 회 ≥ $MAX_HEALS_PER_HOUR (축1/축2 회계 점검 필요)"
    say "✗ DEGRADED — 폭주 방지선($MAX_HEALS_PER_HOUR/h)에 걸렸다. 사람이 봐야 한다."
    return 5
  fi
  # 축1 — 이 장애 하나에 쓸 재시도 예산.
  if [ "$cur" -ge "$HEAL_TRIES_PER_INCIDENT" ]; then
    record DEGRADED "재시도 예산 소진: 이 장애에 $cur 회 ≥ $HEAL_TRIES_PER_INCIDENT"
    degraded_mark "재시도 예산 소진 — 이 장애에 $cur 회 시도했다(예산 $HEAL_TRIES_PER_INCIDENT). 완화: printf 'HMB_HEAL_TRIES=8\\n' > $HEAL_CONF"
    say "✗ DEGRADED — 이 장애에 $cur 번 시도했다(예산 $HEAL_TRIES_PER_INCIDENT). 원인이 우리 밖에 있다."
    return 5
  fi
  # 축2 — 시간당 장애 수. **새 장애를 여는 경우에만** 본다(진행 중인 장애를 여기서 끊으면 축1 이 무의미해진다).
  if [ "$cur" -eq 0 ] && [ "$inc" -ge "$MAX_INCIDENTS_PER_HOUR" ]; then
    record DEGRADED "장애 상한: 1시간 내 장애 $inc 건 ≥ $MAX_INCIDENTS_PER_HOUR"
    degraded_mark "1시간에 장애가 $inc 건 ≥ 상한 $MAX_INCIDENTS_PER_HOUR (완화: printf 'HMB_HEAL_MAX_INCIDENTS_PER_HOUR=6\\n' > $HEAL_CONF)"
    say "✗ DEGRADED — 1시간에 서로 다른 장애가 $inc 건이다(상한 $MAX_INCIDENTS_PER_HOUR). 반복 사망은 사람이 봐야 한다."
    return 5
  fi
  # 백오프 — 소모한 시도끼리만 간격을 둔다(무산된 시도는 위에서 이미 예산 밖이다).
  if [ "$cur" -gt 0 ]; then
    need=$(backoff_for "$cur"); since_last=$(( $(now) - last ))
    if [ "$since_last" -lt "$need" ]; then
      say "· 직전 시도로부터 ${since_last}s — 백오프 ${need}s 대기 중(이 장애 ${cur}/${HEAL_TRIES_PER_INCIDENT})"
      return 3
    fi
  fi

  if ! try_lock; then
    say "· 다른 배포/치유가 진행 중(락) — 이번 틱은 건너뛴다"; return 0
  fi

  old_url=$(current_url)
  record HEAL_START "reason=$reason old=${old_url:-<없음>} try=$((cur + 1))/${HEAL_TRIES_PER_INCIDENT} 장애=${inc}/${MAX_INCIDENTS_PER_HOUR}per-h"
  printf '%s\t%s\tattempt\n' "$(now)" "$(iso)" >> "$HEALS_FILE"   # 상한은 시도 기준(위 주석)
  say "▶ 치유 시작 (사유: $reason, 기존 URL: ${old_url:-없음}, 시도 $((cur + 1))/$HEAL_TRIES_PER_INCIDENT)"

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

  # 2) 새 터널 — 덮어쓰기 **전에** 직전 로그를 보관함으로 (#505 B)
  archive_tunnel_log "pre-heal"
  # ⚠️ `--protocol` 기본 http2 — quick tunnel 의 기본 QUIC(UDP)은 **모바일 핫스팟/제한적 NAT
  #    에서 조용히 죽는다**. 2026-07-31 09:40~09:53Z 실장애: QUIC 로 뜬 터널이 "timeout: no
  #    recent network activity"·"datagram manager ... failure" 를 반복하다 호스트가 DNS 에서
  #    사라져(dig 무응답) 라이브가 HTTP 000. 워치독이 치유해도 **같은 QUIC 로 다시 떠서** 새 URL
  #    마저 530 이었고, http2 로 바꾸자 **첫 시도에 200**. 그래서 치유 경로의 기본을 http2 로 둔다.
  #    (QUIC 가 더 빠르지만, 무인 복구 경로에서는 "빠름"보다 "붙는다"가 우선이다.)
  #    되돌리기·실험 = HMB_TUNNEL_PROTOCOL=quic (또는 auto) 로 환경변수 지정.
  nohup cloudflared tunnel --url "http://localhost:$BACKEND_PORT" --no-autoupdate \
    --protocol "${HMB_TUNNEL_PROTOCOL:-http2}" > "$TUNNEL_LOG" 2>&1 &
  echo $! > "$TUNNEL_PID"
  say "· 새 터널 기동 (pid $(cat "$TUNNEL_PID"))"

  for _ in $(seq 1 30); do new_url=$(current_url); [ -n "$new_url" ] && break; sleep 2; done
  if [ -z "${new_url:-}" ]; then
    # ⚠️ 실패 **사유를 여기서 heal 로그로 복사한다** (#505 B). 안 그러면 다음 시도나 사람의
    #    start-tunnel.sh 가 cloudflared 로그를 덮어 원인이 영구 소실된다(2026-08-14 2차 시도가 그랬다).
    archive_tunnel_log "failed-no-url"
    record HEAL_FAIL "새 URL 획득 실패 — cf: $(cf_error_line) [보존: $TUNNEL_LOG_DIR]"
    say "✗ 새 URL 을 못 얻었다 — $(cf_error_line)"; return 1
  fi
  say "· 새 URL = $new_url"

  # 3) 글로벌 DNS 등록 + 왕복이 될 때까지 대기 (배포보다 먼저 확인 — 죽은 주소를 퍼뜨리지 않는다)
  #
  # ⚠️ **벽시계 마감으로 건다 — `sleep` 합계가 아니라.** 구 코드는 `waited` 에 sleep 5 만 더해서
  #    "120s 상한"이라고 했는데, 한 바퀴의 실제 비용은 `probe` 자체(dig 4개 + curl)가 지배한다.
  #    해석기가 전멸한 장애에서는 그 한 바퀴가 100초를 넘고, 24바퀴를 다 돌면 상한의 수십 배가 된다.
  #    2026-08-01 실측: HEAL_START **14:08:06Z** → HEAL_FAIL **15:05:55Z** = **3469초**(공칭 120초).
  #    그동안 워치독은 락을 쥔 채였고 — 후속 틱이 아무것도 못 했다. **백엔드는 내내 살아 있었는데
  #    터널만 58분 죽어 있었다.** 상한이 상한 노릇을 해야 다음 틱이 다시 시도할 수 있다.
  local started deadline alive=0
  started=$(date +%s); deadline=$((started + DNS_WAIT))
  while :; do
    if probe_out=$(probe "$new_url"); then
      alive=1; say "· 왕복 확인 ($probe_out, $(( $(date +%s) - started ))s)"; break
    fi
    [ "$(date +%s)" -ge "$deadline" ] && break
    sleep 5
  done
  if [ "$alive" != "1" ]; then
    archive_tunnel_log "failed-no-roundtrip"
    record HEAL_FAIL "새 터널이 ${DNS_WAIT}s 안에 살아나지 않음 url=$new_url 실경과=$(( $(date +%s) - started ))s cf: $(cf_error_line)"
    say "✗ 새 터널이 ${DNS_WAIT}s 안에 응답하지 않는다"; return 1
  fi

  # 4) web 에 전파 (재빌드 없음 — config.json 만)
  if [ ! -x "$PUBLISH" ]; then
    record HEAL_FAIL "publish 스크립트 없음: $PUBLISH"
    say "✗ 전파 스크립트가 없다: $PUBLISH (install-tunnel-heal.sh 재실행 필요)"; return 1
  fi
  # ⚠️ `HEAL_OK` 는 **web 이 실제로 새 주소를 서빙하는 것까지 확인한 뒤에만** 찍는다.
  #    이 한 줄이 계약이다: HEAL_OK = "테스터가 접속된다". publish 종료코드로 대신하지 않는다.
  if publish_verified "$new_url" heal; then
    record HEAL_OK "old=${old_url:-<없음>} new=$new_url"
    degraded_clear
    say "✓ 치유 완료·검증됨 — web 이 $new_url 을 가리킨다"
    return 0
  fi
  # 터널은 살아있는데 전파만 못 한 상태 = 부분 실패. **성공으로 기록하지 않는다** —
  # 그래야 쿨다운이 시작되지 않고 다음 틱의 publish-only 경로가 즉시 이어서 재시도한다.
  record HEAL_UNPROPAGATED "url=$new_url — 터널은 살아있다. 다음 틱이 재전파한다 (로그: $HEAL_LOG.publish)"
  say "✗ 전파 미완 — 터널은 정상($new_url)인데 web 이 아직 못 따라왔다. 다음 틱에서 재시도."
  return 1
}

# ── 자기 마감(백스톱) ──────────────────────────────────────────────────────────────
#
# 위의 벽시계 마감이 **알려진** 늘어지는 지점을 잡는다면, 이건 **아직 모르는** 지점을 잡는다.
# 이 스크립트는 60초마다 불리면서 `deploy.lock` 을 쥔다. 락 회수 로직은 소유자 PID 가 **죽었을 때만**
# 훔쳐온다(`try_lock`) — 그래서 **살아서 매달린** 실행은 후속 틱을 전부 굶긴다. 2026-08-01 장애가
# 정확히 그 모양이었다(한 번의 `--once` 가 58분 매달려 있었고, 그동안 워치독은 존재하지 않는 것과 같았다).
# 어디서 매달리든 상한 안에 죽고, 다음 틱이 깨끗한 상태로 다시 시작하게 한다.
# (macOS 엔 `timeout(1)` 이 없다 — 백그라운드 감시자로 직접 건다.)
RUN_DEADLINE="${HMB_RUN_DEADLINE:-420}"
# `--budget` 는 파일 몇 줄 읽고 끝난다 — 감시자를 달면 status.sh 를 부를 때마다 7분짜리 sleep 이
# 하나씩 남는다. 매달릴 일이 없는 모드에 백스톱을 달지 않는다.
[ "$MODE" = "--budget" ] && RUN_DEADLINE=0
if [ "$RUN_DEADLINE" -gt 0 ] 2>/dev/null; then
  # ⚠️ 감시자의 stdout/stderr 는 **반드시 /dev/null 로 갈아끼운다.** 안 하면 부모의 fd 를 물려받는데,
  #    이 스크립트가 파이프로 불릴 때(`… | tail`) 파이프는 **쓰는 쪽이 전부 닫혀야** EOF 가 난다 →
  #    본체가 끝나도 감시자가 살아 있는 동안 호출자가 그대로 매달린다. (이 픽스를 넣자마자 자기
  #    selftest 가 4분+ 매달려서 바로 걸렸다 — 워치독을 고치다 워치독을 매달 뻔했다.)
  ( sleep "$RUN_DEADLINE"
    if kill -0 $$ 2>/dev/null; then
      printf '%s\t%s\t%s\t%s\n' "$(now)" "$(iso)" RUN_TIMEOUT "실행이 ${RUN_DEADLINE}s 를 넘겨 스스로 종료 — 락 해제, 다음 틱이 재시도" >> "$HEAL_LOG"
      kill -TERM $$ 2>/dev/null; sleep 5; kill -KILL $$ 2>/dev/null
    fi ) >/dev/null 2>&1 &
  SELF_TIMER=$!
  # ⚠️ TERM 을 EXIT 와 같은 trap 에 묶으면 안 된다 (#518, 2026-08-17 장애의 지배 항).
  #    구 형태 `trap 'kill $SELF_TIMER; cleanup' EXIT INT TERM` 은 **exit 가 없어서**, 타이머의
  #    TERM 이 짧은 명령(URL 대기 sleep 2 루프·검증 폴링) 중에 도착하면 trap 이 5초 유예 안에
  #    실행돼 **자기 처형자(타이머)를 먼저 죽이고(KILL 미발사) 락을 풀고 계속 달렸다** — 마감도
  #    락도 없이. 실측: 03:29:03 틱이 RUN_TIMEOUT 을 찍고도 28분 34초 주행(= MTTR 34분의 대부분).
  #    긴 foreground(publish 대기) 중 TERM 은 trap 이 유예되므로 종전대로 KILL 백스톱이 잡는다 —
  #    그 경로는 바꾸지 않는다. 여기서 바꾸는 것은 "TERM 을 받으면 **죽는다**" 하나다:
  #    TERM/INT → exit 143 → EXIT trap 이 타이머 정리 + cleanup(락 해제)까지 한다.
  trap 'kill "$SELF_TIMER" 2>/dev/null; cleanup' EXIT
  trap 'exit 143' TERM INT
fi

# ── 모드 ───────────────────────────────────────────────────────────────────────────
# ⚠️ `--budget` 는 심박을 찍지 **않는다**. status.sh 가 이 모드를 부르는데, 여기서 심박을
#    갱신하면 **워치독이 죽어 있어도 status.sh 가 자기 호출로 심박을 살려** "가동 중" 이 된다
#    (= #497 을 잡으려고 만든 신호를 관측 행위가 오염시킨다). 읽기 전용 모드는 읽기만 한다.
[ "$MODE" = "--budget" ] || beat
case "$MODE" in
  --selftest)
    rc=0
    # /tmp 는 부팅 때 비워진다 (#497). 워치독의 기동 전제에서는 뺐지만, 런타임 경로가 아직
    # /tmp 에 있으면 재부팅·청소에서 같은 부류가 재발할 수 있다 → 경고만 한다(동작 무변경).
    for v in TUNNEL_LOG:"$TUNNEL_LOG" TUNNEL_PID:"$TUNNEL_PID" WORKDIR:"${HMB_WORK_DIR:-/var/tmp/hmb-wrangler-work}"; do
      case "${v#*:}" in
        /tmp/*) say "! ${v%%:*} 가 /tmp 아래다 (${v#*:}) — 부팅 시 소거된다 (#497 부류)";;
      esac
    done
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
    selftest_publish_target || rc=1
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
      # 터널이 살아있어도 web 이 옛 주소를 보고 있으면 테스터는 여전히 죽어 있다.
      # (수동 터널 재기동 후 재배포를 잊었거나, 직전 전파가 실패한 경우 — 실측으로 나온 상태다.)
      served=$(pages_backend)
      # 방금 전파한 직후엔 엣지마다 반영 시점이 달라 옛 값이 잠깐 보인다(실측: HEAL_OK 30초 뒤
      # 불필요한 재전파가 한 번 더 돌았다). 쿨다운 동안은 불일치를 무시한다.
      last_pub=$(awk -F'\t' '$3=="HEAL_OK"||$3=="PUBLISH_ONLY"{t=$1} END{print t+0}' "$HEAL_LOG" 2>/dev/null)
      if [ -n "$served" ] && [ "$served" != "$url" ] \
         && [ $(( $(now) - ${last_pub:-0} )) -ge "${HMB_PUBLISH_COOLDOWN:-180}" ]; then
        say "! web 은 $served 을 본다 (현재 터널 $url)"
        [ "$MODE" = "--check" ] && { say "  (--check 모드: 아무것도 하지 않음)"; exit 1; }
        publish_only "$url"; exit $?
      fi
      degraded_clear
      exit 0
    fi
    say "! 1차 실패 — $url ($out)"
    [ "$MODE" = "--check" ] && { say "  (--check 모드: 아무것도 하지 않음)"; exit 1; }
    age=$(tunnel_age)
    if [ "$age" -lt "${HMB_TUNNEL_GRACE:-90}" ]; then
      say "· 터널이 뜬 지 ${age}s 밖에 안 됐다 — 엣지 전파 유예(치유 보류)"; exit 0
    fi
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

  # 예산 상태를 한 줄로 — status.sh 와 사람이 "지금 자동복구가 몇 발 남았나" 를 묻는 창구.
  # 아무것도 바꾸지 않는다(심박만 갱신된다).
  --budget)
    read -r b_cur b_last b_inc b_att <<EOF
$(heal_stats)
EOF
    b_ago=0; [ "${b_last:-0}" -gt 0 ] && b_ago=$(( $(now) - b_last ))
    say "재시도 예산: 이 장애 ${b_cur}/${HEAL_TRIES_PER_INCIDENT}  ·  1시간 내 장애 ${b_inc}/${MAX_INCIDENTS_PER_HOUR}  ·  시도 ${b_att}/${MAX_HEALS_PER_HOUR}(방지선)  ·  마지막 시도 ${b_ago}s 전"
    [ -f "$DEFER_MARK" ] && say "유예 중: $TUNNEL_REG_HOST 미해석 (since $(cut -f2 "$DEFER_MARK" 2>/dev/null))"
    [ -f "$DEGRADED_MARK" ] && say "DEGRADED: $(tr '\t' ' ' < "$DEGRADED_MARK")"
    exit 0;;

  *)
    say "usage: $(basename "$0") [--selftest|--check|--once|--budget]"
    say "  종료코드: 0 정상 · 1 치유 실패 · 3 유예(예산 무소모) · 4 백엔드 사망 · 5 DEGRADED · 64 사용법"
    exit 64;;
esac
