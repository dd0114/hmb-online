#!/usr/bin/env bash
# HMB 온라인 — 로컬 빌드 원커맨드 스택 (#471 AC1)
#
# 클론 하나에서 게임을 띄운다: 엔진 러너(서번트①) + 권위 서버(java) + AI 실행기(서번트②) + web.
# 절차의 SoT 는 **이 파일**이고 README 는 여기를 가리킨다 — 문서와 실효가 갈라지지 않게
# (`tools/readme-parity.test.ts` 가 그 대조를 계약으로 건다).
#
# 씨앗은 `server-java/scripts/p4-clock-smoke.sh`(P4-E2 #170) 다 — 3프로세스 자동 기동·PID-only
# cleanup·JDK21 탐색은 거기서 왔고, 여기서 web 층과 서브커맨드·프리플라이트를 얹어 일반화했다.
#
#   bash scripts/local-stack.sh doctor   # 전제 점검만 (아무것도 안 띄운다)
#   bash scripts/local-stack.sh up       # 4프로세스 기동 → 브라우저로 플레이 (Ctrl-C 로 정리)
#   bash scripts/local-stack.sh smoke    # 기동 → 가입·덱·매치 완주 자동 판정 → 정리
#
# ⚠️ 데모(8080/8790)·배포(18080/18790) 무접촉이 절대규칙이다. 이 스택은 3xxxx 대만 쓰고
#    포트는 전부 env 로 덮어써진다(같은 머신에서 두 세션이 동시에 돌 수 있어야 한다).
# ⚠️ 정리는 **우리가 띄운 PID 로만** 한다. `pkill -f` 는 다른 세션의 java/node 를 같이 죽인다.
# ⚠️ ANTHROPIC_API_KEY 는 주입하지 않는다 — 있으면 정액제 구독이 아니라 종량 과금으로 샌다.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── 설정 (전부 env override) ──────────────────────────────────────────────
JAVA_PORT="${HMB_LOCAL_JAVA_PORT:-31080}"
RUNNER_PORT="${HMB_LOCAL_RUNNER_PORT:-31790}"
WEB_PORT="${HMB_LOCAL_WEB_PORT:-31173}"
# e2e 가 띄우는 vite dev 포트. `up` 의 WEB_PORT 와 **분리**한다 — 플레이하며 e2e 를 돌릴 수 있어야 한다.
E2E_WEB_PORT="${HMB_LOCAL_E2E_WEB_PORT:-31199}"
SERVANT_TOKEN_VALUE="${HMB_LOCAL_SERVANT_TOKEN:-local-stack-token}"
# AI 실행기 희망 모드. 기본은 서브커맨드가 정한다(플레이=claude-code / 판정=stub).
# 실제로 무엇이 도는지는 실행기 **프리플라이트**가 정한다 — 로그인이 안 돼 있으면 stub 으로 강등된다.
AI_MODE_WANTED="${HMB_LOCAL_AI:-}"
# 감독시간 압축(ms). 비우면 서버 기본(3분) — `up` 은 비우고 판정용만 압축한다.
#
# ⚠️ **하프 길이는 config 로 못 줄인다.** `hmb.match.clock.half-real-ms` 는 이름과 달리 노브가
#    아니라 **폴백**이다 — #365 이후 재생 창은 러너가 준 `playbackMs` 가 정하고
#    (`MatchClockService.liveWindowEnd`: `playbackMs > 0 ? playbackMs : halfRealMs`), 러너는 항상
#    그 값을 준다. 실제로 이 스크립트가 `-Dhmb.match.clock.half-real-ms=6000` 을 넘겼는데도
#    전반이 **221초** 걸렸다(= 압축이 한 번도 발화하지 않았다). 그래서 판정은 그 노브 대신
#    **경기 스킵 API**(#421, `POST /api/matches/{id}/skip`)로 재생 창을 당긴다 — 서버가 지원하는
#    경로라 새 상태 전이도 없고, 덤으로 그 API 자체가 매 판정마다 실행된다.
HALFTIME_MS="${HMB_LOCAL_HALFTIME_MS:-}"
# 데이터 디렉토리. 비우면 매 실행마다 임시 디렉토리(격리) — 플레이 데이터를 남기려면 지정한다.
STATE_DIR="${HMB_LOCAL_STATE_DIR:-}"

BASE="http://localhost:${JAVA_PORT}"
WEB_URL="http://localhost:${WEB_PORT}"
E2E_WEB_URL="http://localhost:${E2E_WEB_PORT}"
# ⚠️ **두 웹 오리진을 다 허용한다.** vite dev 프록시를 거쳐도 브라우저의 `Origin` 헤더는 그대로
#    전달되므로 서버의 CORS 판정에 걸린다 — 실제로 `e2e` 첫 콜드 실행이 로그인 화면에서
#    **`Forbidden`** 으로 3/3 죽었다(플레이 포트만 허용했었다). 프록시가 CORS 를 없애 주지 않는다.
CORS_ORIGINS="${HMB_LOCAL_CORS_ORIGINS:-$WEB_URL,$E2E_WEB_URL}"

if [ -n "$STATE_DIR" ]; then
  mkdir -p "$STATE_DIR"
  TMP="$STATE_DIR"
else
  TMP="$(mktemp -d /tmp/hmb-local-stack-XXXX)"
fi

# ── 출력 ─────────────────────────────────────────────────────────────────
say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
ok()   { printf '\033[32m   ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m   ! %s\033[0m\n' "$*"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }

# ── 정리 — 우리가 띄운 PID 만 ────────────────────────────────────────────
# ⚠️ 실측으로 배운 것: `( … ) &` 의 `$!` 는 **서브셸** PID 다. 그걸 kill 하면 서브셸만 죽고
#    그 안의 java/node 는 **고아로 남아 포트를 계속 문다**(1차 콜드 실행에서 java 가 살아남았다).
#    그래서 `set -m` 으로 각 백그라운드 잡을 **독립 프로세스 그룹**으로 만들고 그룹째 보낸다.
#    이것은 여전히 PID 기반이다 — 우리가 만든 그룹만 건드리고 `pkill -f` 같은 패턴 kill 은 쓰지
#    않는다(패턴 kill 은 다른 세션의 java/node 를 같이 죽인다).
set -m
RUNNER_PID=""; JAVA_PID=""; EXEC_PID=""; WEB_PID=""
signal_group() { # pid, 시그널
  local pid="$1" sig="$2"
  [ -n "$pid" ] || return 0
  kill "-$sig" -- "-$pid" 2>/dev/null || kill "-$sig" "$pid" 2>/dev/null || true
}
cleanup() {
  local pids=("$WEB_PID" "$EXEC_PID" "$JAVA_PID" "$RUNNER_PID")
  for pid in "${pids[@]}"; do signal_group "$pid" TERM; done
  sleep 1
  for pid in "${pids[@]}"; do signal_group "$pid" KILL; done
  wait 2>/dev/null
  [ -n "${QUIET_EXIT:-}" ] || echo "로그: $TMP"
}
trap cleanup EXIT

# 우리가 띄운 잡이 아직 살아 있나. bash 는 백그라운드 자식을 즉시 거둬 가므로(`set -m` 아래에서도
# 실측 확인) 죽은 PID 에는 `kill -0` 이 실패한다 — 좀비를 살아있다고 읽는 문제는 없다.
proc_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

# 그 포트에서 듣고 있는 것이 **우리 잡**인가. `set -m` 이라 각 백그라운드 잡은 독립 프로세스
# 그룹이고 그 PGID = 우리가 들고 있는 `$!` 다(손자 프로세스까지 그룹을 물려받는다 — npm→tsx→node
# 로 실측). 그래서 리스너의 PGID 를 대조하면 "이 200 이 누구 것인가"가 갈린다.
# ⚠️ 생존 확인(`kill -0`)만으로는 부족하다 — 고아는 **즉시** 200 을 주는데 우리 npm 은 EADDRINUSE
#    로 죽기까지 몇 초 걸린다. 그 창에서 생존만 보면 남의 200 을 우리 것으로 읽는다(실측).
port_owner_ok() { # port, 우리-잡-PID
  local port="$1" pid="$2" lp
  command -v lsof >/dev/null 2>&1 || return 0 # 확인 불가 → 막지 않는다(doctor 도 lsof 전제)
  for lp in $(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null); do
    [ "$(ps -o pgid= -p "$lp" 2>/dev/null | tr -d ' ')" = "$pid" ] && return 0
  done
  return 1
}

# url, 초, 우리가-띄운-PID, [헤더…] — 헤더는 `-H` 인자로 그대로 넘어간다.
# ⚠️ `/internal/**` 은 ServantTokenInterceptor 가 X-Servant-Token 을 요구한다(WebMvcConfig:79).
#    헤더 없이 치면 서버가 정상 기동해도 401 이라 "안 뜬다"로 오판한다(실측 1회 겪음).
# ⚠️ **200 은 "우리 프로세스가 떴다"를 뜻하지 않는다.** 이전 실행의 고아나 다른 세션의 스택이
#    그 포트를 물고 있으면, 우리가 방금 띄운 java/러너/vite 는 포트 충돌로 죽고 헬스체크는
#    **남의 프로세스**에게서 200 을 받는다 → 스택은 낡은 jar 를 문 채 "준비 완료"로 진행하고
#    끝에 exit 0 으로 성공을 보고한다(#471 패널 S2 ②). 그래서 폴링마다 PID 생존을 같이 보고,
#    죽었으면 **2**, 남이 그 포트를 물고 있으면 **3** 을 돌려 호출부가 "안 뜬다"(1)와 다른 말을
#    하게 한다. 순서를 안 타는 판정이다 — 고아가 먼저 200 을 줘도 소유가 우리가 아니면 계속
#    기다리고, 그 사이 우리 프로세스가 EADDRINUSE 로 죽으면 2 로 끝난다.
wait_http() {
  local url="$1" limit="${2:-60}" pid="${3:-}" i=0
  shift 3 2>/dev/null || shift $#
  local hdr=()
  for h in "$@"; do hdr+=(-H "$h"); done
  local port="${url##*:}"; port="${port%%/*}"
  local foreign=0
  while [ $i -lt "$limit" ]; do
    proc_alive "$pid" || return 2
    if curl -sf ${hdr[@]+"${hdr[@]}"} "$url" >/dev/null 2>&1; then
      # 200 을 받았다 ≠ 우리가 떴다. 그 포트의 리스너가 우리 잡이어야 비로소 준비 완료다.
      if port_owner_ok "$port" "$pid"; then
        proc_alive "$pid" || return 2
        return 0
      fi
      foreign=1
    fi
    sleep 1; i=$((i+1))
  done
  [ "$foreign" -eq 1 ] && return 3
  return 1
}

# ── 전제 점검 ────────────────────────────────────────────────────────────
# JDK 21 — gradle 툴체인이 21 고정(server-java/build.gradle.kts). 셸 기본 JAVA_HOME 이 11/17 인
# 환경이 있어 21 을 우선 탐색한다(여기서 안 맞추면 "JVM runtime version" 으로 빌드가 죽는다).
resolve_java() {
  if [ -x "/usr/libexec/java_home" ]; then
    local home21
    home21="$(/usr/libexec/java_home -v 21 2>/dev/null || true)"
    [ -n "$home21" ] && export JAVA_HOME="$home21"
  fi
  export PATH="${JAVA_HOME:+$JAVA_HOME/bin:}$PATH"
  command -v java >/dev/null 2>&1 || return 1
  java -version 2>&1 | head -1 | grep -qE '"(2[1-9]|[3-9][0-9])' || return 2
  return 0
}

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  # .nvmrc 가 요구 버전의 SoT. 메이저만 본다 — 패치 차이로 로컬 빌드를 막지 않는다.
  local want major_want major_have
  want="$(tr -d '[:space:]' < "$ROOT/.nvmrc")"
  major_want="${want%%.*}"
  major_have="$(node -v | sed 's/^v//' | cut -d. -f1)"
  [ "$major_have" = "$major_want" ]
}

# claude 로그인 dry-probe. 여기서의 판정은 **안내용**이다 — 실제 강등은 AI 실행기 프리플라이트가
# 하고(그게 유효 모드의 SoT `packages/server/src/executor/ai-mode.ts`), 그 결과는 `GET /api/config` 로 나간다.
# 사유 어휘(cli-missing·logged-in·logged-out·probe-timeout·probe-failed)를 **그쪽 표와 맞춘다** —
# doctor 가 말한 사유와 실행기가 말한 사유가 다르면 그 자체가 디버깅을 방해한다.
claude_state() {
  local bin="${HMB_LOCAL_CLAUDE_BIN:-claude}"
  command -v "$bin" >/dev/null 2>&1 || { echo "cli-missing"; return; }
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then echo "apikey"; return; fi

  # ⚠️ 무한 대기 금지 — 프로브가 매달리면 doctor 가 매달린다. PID 로만 죽인다(패턴 kill 금지).
  local out="$TMP/claude-auth-probe.json"
  : > "$out"
  ( "$bin" auth status --json >"$out" 2>/dev/null ) & local pid=$!
  local i=0
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true
    echo "probe-timeout"; return
  fi
  wait "$pid" 2>/dev/null || true
  grep -q '"loggedIn"[[:space:]]*:[[:space:]]*true' "$out" && { echo "logged-in"; return; }
  grep -q '"loggedIn"[[:space:]]*:[[:space:]]*false' "$out" && { echo "logged-out"; return; }
  echo "probe-failed"
}

# 선점 검출 — 이전 실행의 잔재나 다른 세션의 스택이 물고 있으면 여기서 말한다.
# (안 하면 java 가 "포트 사용 중"으로 조용히 죽고 원인이 로그 깊숙이 묻힌다.)
# ⚠️ E2E_WEB_PORT 를 빠뜨리지 마라 — 그 포트에 낡은 vite 가 물려 있으면 playwright 가 그걸
#    주워 쓰고(run_web_e2e 의 CI=1 주석), 그 vite 의 /api 프록시는 **이번 백엔드가 아니다**.
#    다른 세 포트는 방어하면서 이 포트만 빠져 있어 사람에게 신호조차 안 갔다(#471 패널 S2).
# 선점된 포트를 공백 구분으로 stdout 에. 없으면 아무것도 안 찍는다(호출부는 빈 문자열로 판정).
ports_busy() {
  local busy=()
  for p in "$JAVA_PORT" "$RUNNER_PORT" "$WEB_PORT" "$E2E_WEB_PORT"; do
    lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 && busy+=("$p")
  done
  [ ${#busy[@]} -eq 0 ] || echo "${busy[*]}"
}

# 판정 모드(smoke·e2e)에서 선점은 **치명**이다 — 거기서 나온 수치는 게이트로 읽히는데, 남의
# 프로세스에게 물어본 수치일 수 있다(#471 패널 S2 ②). `up` 은 사람이 화면을 보고 판단하므로
# 경고만 유지한다. 전제가 특수한 환경을 위해 탈출구는 남긴다.
require_free_ports() {
  local busy
  busy="$(ports_busy)"
  [ -n "$busy" ] || return 0
  [ -z "${HMB_LOCAL_ALLOW_BUSY_PORTS:-}" ] || { warn "포트 선점 무시(HMB_LOCAL_ALLOW_BUSY_PORTS): $busy"; return 0; }
  fail "포트 선점: $busy — 판정 모드는 남의 프로세스를 재면 안 된다. HMB_LOCAL_*_PORT 로 바꾸거나 그 프로세스를 끄고 다시 (무시하려면 HMB_LOCAL_ALLOW_BUSY_PORTS=1)"
}

doctor() {
  say "전제 점검"
  local bad=0
  if node_ok; then ok "node $(node -v) (요구 $(tr -d '[:space:]' < "$ROOT/.nvmrc"))"
  else warn "node 버전이 .nvmrc($(tr -d '[:space:]' < "$ROOT/.nvmrc")) 와 다르다 — nvm use 를 권장"; bad=1; fi
  command -v npm >/dev/null 2>&1 && ok "npm $(npm -v)" || { warn "npm 이 없다"; bad=1; }
  resolve_java; case $? in
    0) ok "JDK $(java -version 2>&1 | head -1 | sed 's/.*"\(.*\)".*/\1/') (JAVA_HOME=${JAVA_HOME:-셸 기본})" ;;
    1) warn "java 를 못 찾았다 — JDK 21 필요"; bad=1 ;;
    2) warn "java 가 21 미만이다 — JDK 21 필요"; bad=1 ;;
  esac
  case "$(claude_state)" in
    logged-in)     ok "claude 로그인됨 (logged-in) → 라이브 AI" ;;
    apikey)        warn "ANTHROPIC_API_KEY 가 설정돼 있다 — 정액제가 아니라 종량 과금으로 샌다. unset 권장" ;;
    logged-out)    warn "claude 로그인 안 됨 (logged-out) → 스텁 엔진으로 강등. 경기는 정상 진행되고 AI 전술 생성만 결정론 대체된다" ;;
    cli-missing)   warn "claude CLI 없음 (cli-missing) → 스텁 엔진으로 강등. 경기는 정상 진행된다" ;;
    probe-timeout) warn "claude 로그인 확인이 10초 안에 안 끝났다 (probe-timeout) → 스텁 엔진으로 강등" ;;
    *)             warn "claude 로그인 상태를 못 읽었다 (probe-failed) → 스텁 엔진으로 강등" ;;
  esac
  info "포트: java ${JAVA_PORT} · runner ${RUNNER_PORT} · web ${WEB_PORT}  (HMB_LOCAL_*_PORT 로 변경)"
  # 선점 검출 — 이전 실행의 잔재나 다른 세션의 스택이 물고 있으면 여기서 말한다.
  # (안 하면 java 가 "포트 사용 중"으로 조용히 죽고 원인이 로그 깊숙이 묻힌다.)
  local busy
  busy="$(ports_busy)"
  if [ -n "$busy" ]; then
    warn "이미 물려 있는 포트: $busy — HMB_LOCAL_*_PORT 로 바꾸거나 그 프로세스를 끄고 다시"
    bad=1
  fi
  [ $bad -eq 0 ] && ok "로컬 빌드 전제 충족" || warn "위 항목을 채우고 다시 실행하라"
  return $bad
}

# ── 기동 ─────────────────────────────────────────────────────────────────
start_runner() {
  say "엔진 러너 :$RUNNER_PORT"
  ( cd "$ROOT" && RUNNER_PORT=$RUNNER_PORT npm run runner --workspace=@hmb/server >"$TMP/runner.log" 2>&1 ) &
  RUNNER_PID=$!
  wait_http "http://localhost:$RUNNER_PORT/health" 90 "$RUNNER_PID"
  case $? in
    0) ;;
    2) fail "러너 프로세스가 죽었다 — :$RUNNER_PORT 선점이나 즉시 크래시다 ($TMP/runner.log)" ;;
    3) fail "러너 프로세스가 죽었다 — :$RUNNER_PORT 를 남의 프로세스가 물고 있다(그 200 은 우리 것이 아니다)" ;;
    *) fail "러너가 안 뜬다 ($TMP/runner.log)" ;;
  esac
  ok "러너 준비"
}

start_java() {
  say "권위 서버 빌드 + 기동 :$JAVA_PORT"
  ( cd "$ROOT/server-java" && ./gradlew bootJar -q ) || fail "bootJar 실패"
  local jar
  jar="$(ls "$ROOT"/server-java/build/libs/*.jar | grep -v plain | head -1)"
  # 시계 압축은 값이 있을 때만 넘긴다(비면 서버 기본 = 운영과 같은 길이).
  local clock=()
  [ -n "$HALFTIME_MS" ] && clock+=("-Dhmb.match.clock.halftime-ms=$HALFTIME_MS")
  # e2e 가 실는 추가 -D (공백 구분). 여기 말고 호출부가 뜻을 설명한다.
  local extra=()
  # shellcheck disable=SC2206
  [ -n "${JAVA_EXTRA_OPTS:-}" ] && extra=($JAVA_EXTRA_OPTS)
  # cwd=server-java 가 필수다 — application.yml 의 데이터 경로가 `../data/...` 상대라
  # 리포 루트에서 띄우면 리포 밖을 본다.
  ( cd "$ROOT/server-java" && java \
      -Dserver.port="$JAVA_PORT" \
      -Dhmb.db.path="$TMP/hmb.db" \
      -Dhmb.servant.engine-runner-url="http://localhost:$RUNNER_PORT" \
      -Dhmb.servant.internal-token="$SERVANT_TOKEN_VALUE" \
      -Dhmb.cors.allowed-origins="$CORS_ORIGINS" \
      ${clock[@]+"${clock[@]}"} \
      ${extra[@]+"${extra[@]}"} \
      -jar "$jar" >"$TMP/java.log" 2>&1 ) &
  JAVA_PID=$!
  wait_http "$BASE/internal/health" 120 "$JAVA_PID" "X-Servant-Token: $SERVANT_TOKEN_VALUE"
  case $? in
    0) ;;
    2) fail "java 프로세스가 죽었다 — :$JAVA_PORT 선점이나 즉시 크래시다 ($TMP/java.log)" ;;
    3) fail "java 프로세스가 죽었다 — :$JAVA_PORT 를 남의 프로세스가 물고 있다(낡은 jar 를 잴 뻔했다)" ;;
    *) fail "java 가 안 뜬다 ($TMP/java.log)" ;;
  esac
  ok "권위 서버 준비 (DB $TMP/hmb.db)"
}

start_executor() {
  local want="$1"
  say "AI 실행기 (희망 모드: $want)"
  # ⚠️ ANTHROPIC_API_KEY 는 넘기지 않는다. 실행기도 기동 시 unset 을 강제하지만(executor-main.ts)
  #    원칙은 주입 자체를 안 하는 것이다.
  ( cd "$ROOT" && AI_EXECUTOR="$want" JAVA_URL="$BASE" SERVANT_TOKEN="$SERVANT_TOKEN_VALUE" \
      npm run executor --workspace=@hmb/server >"$TMP/executor.log" 2>&1 ) &
  EXEC_PID=$!
  sleep 2
  # 실행기는 헬스 포트가 없다(잡 폴링 데몬) — 그래서 "떴나"의 유일한 신호가 PID 생존이다.
  # 안 보면 기동 직후 죽어도 show_ai_mode 가 30초를 기다린 끝에 "확인 중"으로 애매하게 죽는다.
  proc_alive "$EXEC_PID" || fail "AI 실행기가 기동 직후 죽었다 ($TMP/executor.log)"
  ok "실행기 기동 (로그 $TMP/executor.log)"
}

# 실효 AI 모드 확인 (#471 AC3). 실행기가 기동 프리플라이트 결과를 `/internal/ai-mode` 로 자기신고하고
# 서버가 `/api/config` 의 `ai` 로 내려 주면, 웹은 그 값 하나로 안내를 켠다. 여기서 보는 것은
# **그 배선이 실제로 도는가**다 — 신고가 영영 안 오면 화면은 조용히 "확인 중"에 머문다(무증상 결함).
show_ai_mode() {
  local strict="${1:-0}" i=0 mode="" reason=""
  while [ "$i" -lt 30 ]; do
    mode="$(curl -s "$BASE/api/config" | sed -n 's/.*"ai":{"mode":"\([^"]*\)".*/\1/p')"
    [ -n "$mode" ] && [ "$mode" != "unknown" ] && break
    sleep 0.5; i=$((i + 1))
  done
  reason="$(curl -s "$BASE/api/config" | sed -n 's/.*"ai":{"mode":"[^"]*","reason":"\([^"]*\)".*/\1/p')"
  case "$mode" in
    live) ok "실효 AI 모드: live ($reason) — 선수 프롬프트가 경기에 반영된다" ;;
    stub) warn "실효 AI 모드: stub ($reason) — 스태틱 엔진. 경기는 정상 진행되고 AI 전술 생성만 결정론 대체" ;;
    *)    if [ "$strict" = "1" ]; then fail "실행기가 AI 모드를 신고하지 않았다(mode=${mode:-없음}) — $TMP/executor.log"
          else warn "실효 AI 모드 확인 중(mode=${mode:-없음})"; fi ;;
  esac
}

# ── 실서버 web E2E (#471 AC4) ────────────────────────────────────────────
# hero 요구: *"앞으로도 E2E 테스트로 사용할거임."* 그 말이 성립하려면 **목킹 0** 이어야 한다 —
# 목이 서버 대신 답하면 그 테스트는 로컬 빌드가 실제로 게임이 되는지를 더 이상 말해 주지 않는다.
#
# ⚠️ 이 세 스펙은 원래 서버가 없으면 **스스로 test.skip** 한다(graceful). 그래서 "green" 이 곧
#    "돌았다"가 아니고, 조용히 0건 실행된 채 통과하는 것이 이 스위트의 실패 양상이다
#    (리포 전례: 잘못된 config 로 0건 실행을 green 으로 오독). 그래서 **skip 0 을 계약으로 건다.**
#
# ⚠️ 프록시 대상을 반드시 넘긴다 — vite dev 의 기본 `/api` 대상은 **데모 8080** 이다.
#    안 넘기면 이 스택이 아니라 데모를 때린다(절대금지 규칙 위반이자 판정 무의미).
run_web_e2e() {
  # 기본 3스펙. 디버깅 때만 좁힌다(HMB_LOCAL_E2E_SPECS="a.spec.ts b.spec.ts") — 상시 게이트는 기본값이다.
  local specs=(match-flow.spec.ts league-season.spec.ts w3-viewer-smoke.spec.ts)
  # shellcheck disable=SC2206
  [ -n "${HMB_LOCAL_E2E_SPECS:-}" ] && specs=(${HMB_LOCAL_E2E_SPECS})
  say "web E2E — 실서버 ${#specs[@]}스펙 (목킹 0, 프록시 → $BASE)"
  local json="$TMP/e2e.json" rc=0
  # ⚠️ CI=1 은 장식이 아니다 — playwright.config.ts 의 `reuseExistingServer: !process.env.CI` 가
  #    CI 없이는 **true** 라, E2E_WEB_PORT 에 낡은 vite 가 떠 있으면 조용히 그걸 재사용한다.
  #    그런데 vite 의 /api 프록시 대상은 **기동 시점에 고정**이라(vite.config.ts) 이번 실행의
  #    VITE_API_TARGET 을 반영하지 않는다 → apiLive() 는 이번 백엔드로 green 인데 **브라우저만
  #    낡은 백엔드**를 때린다. 그러면 "실서버 · 목킹 0" 이라는 이 게이트의 주장 자체가 갈라진다.
  #    CI=1 이면 재사용 대신 새로 띄우고, 포트가 물려 있으면 --strictPort 로 **시끄럽게 죽는다**.
  #    (apps/web/CLAUDE.md 가 이미 경고해 둔 지뢰를 그대로 밟았다 — #471 패널 S2)
  ( cd "$ROOT/apps/web" \
      && CI=1 \
         WEB_E2E_PORT="$E2E_WEB_PORT" \
         VITE_API_TARGET="$BASE" \
         HMB_E2E_API_ORIGIN="$BASE" \
         PLAYWRIGHT_JSON_OUTPUT_NAME="$json" \
         npx playwright test "${specs[@]}" --reporter=list,json ) >"$TMP/e2e.log" 2>&1 || rc=$?
  sed -n '$p;/✓\|✘\|passed\|failed\|skipped/p' "$TMP/e2e.log" | tail -12 | sed 's/^/   /'

  [ -f "$json" ] || fail "playwright 결과 JSON 이 없다 — $TMP/e2e.log"
  # 판정은 exit code 가 아니라 **집계**로 한다: skip 은 playwright 에서 실패가 아니라서
  # exit 0 과 공존한다(그게 이 게이트가 존재하는 이유다).
  local counts
  counts="$(node -e '
    const r = require(process.argv[1]);
    let pass = 0, fail = 0, skip = 0;
    const walk = (s) => {
      for (const spec of s.specs ?? []) for (const t of spec.tests ?? []) {
        const st = t.status === "expected" ? "pass" : t.status === "skipped" ? "skip" : "fail";
        if (st === "pass") pass++; else if (st === "skip") skip++; else fail++;
      }
      for (const c of s.suites ?? []) walk(c);
    };
    for (const s of r.suites ?? []) walk(s);
    console.log(`${pass} ${fail} ${skip}`);
  ' "$json")" || fail "결과 JSON 파싱 실패 — $json"
  local pass="${counts%% *}" rest="${counts#* }"
  local nfail="${rest%% *}" nskip="${rest##* }"

  info "실행 집계: pass=$pass fail=$nfail skip=$nskip (로그 $TMP/e2e.log · JSON $json)"
  [ "$nfail" = "0" ] || fail "web E2E 실패 $nfail 건 — $TMP/e2e.log"
  [ "$nskip" = "0" ] || fail "web E2E 가 $nskip 건 스킵됐다 — 실서버에 안 붙었다는 뜻이다(그 green 은 거짓이다)"
  [ "$pass" -ge "${#specs[@]}" ] || fail "실행된 테스트가 스펙 수보다 적다(pass=$pass) — 0건 실행 green 방지"
  # ⚠️ `${pass}` 로 감싼다 — `$pass건` 은 bash 가 변수명을 `pass건` 으로 읽어 `set -u` 아래에서
  #    **성공 경로에서만** unbound variable 로 죽는다(실패 경로는 그 앞에서 exit 해서 안 보인다).
  ok "web E2E ${pass}건 통과 · 스킵 0 (실서버 $BASE)"
}

start_web() {
  say "web :$WEB_PORT"
  ( cd "$ROOT/apps/web" && VITE_API_TARGET="$BASE" \
      npm run dev -- --port "$WEB_PORT" --strictPort >"$TMP/web.log" 2>&1 ) &
  WEB_PID=$!
  wait_http "$WEB_URL" 120 "$WEB_PID"
  case $? in
    0) ;;
    # vite 는 `--strictPort` 라 포트가 물려 있으면 뜨지 않고 죽는다 — 그때 200 을 주는 것은
    # **낡은 vite** 이고, 그 프록시는 이번 백엔드를 안 본다(e2e 쪽에서 이미 한 번 겪은 부류).
    2) fail "web(vite) 이 죽었다 — :$WEB_PORT 선점이다(--strictPort) ($TMP/web.log)" ;;
    3) fail "web(vite) 이 죽었다 — :$WEB_PORT 를 낡은 vite 가 물고 있다(그 프록시는 이번 백엔드가 아니다)" ;;
    *) fail "web 이 안 뜬다 ($TMP/web.log)" ;;
  esac
  ok "web 준비"
}

# ── 판정용 시나리오 (가입 → 덱 → 매치 완주) ──────────────────────────────
# p4-clock-smoke 의 시나리오를 그대로 승계한다 — 여기가 "로컬 빌드가 실제로 게임이 되는가"의 증명이다.
play_once() {
  say "가입 → 덱 → 매치"
  local nick token deck match
  nick="local$(date +%s)"
  token="$(curl -s -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
    -d "{\"nickname\":\"$nick\",\"password\":\"pw1234\"}" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')"
  [ -n "$token" ] || fail "가입 실패 ($TMP/java.log)"
  ok "가입 $nick"

  deck="$(curl -s -H "Authorization: Bearer $token" "$BASE/api/players" | python3 -c '
import sys, json
owned = [p for p in json.load(sys.stdin) if p.get("owned")]
gk = [p for p in owned if p.get("position") == "GK"]
if not gk:
    sys.exit("스타터 팩에 GK 가 없다")
gk_id = gk[0]["id"]
rest = [p["id"] for p in owned if p["id"] != gk_id]
slots = [{"playerId": gk_id, "role": "starter", "slotIndex": 0}]
slots += [{"playerId": pid, "role": "starter", "slotIndex": i + 1} for i, pid in enumerate(rest[:10])]
slots += [{"playerId": pid, "role": "bench", "slotIndex": i} for i, pid in enumerate(rest[10:12])]
print(json.dumps({"formation": "4-3-3", "slots": slots}))
')"
  curl -s -o "$TMP/deck.json" -w '%{http_code}\n' -X PUT "$BASE/api/deck" \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d "$deck" | grep -q 200 \
    || fail "덱 저장 실패: $(cat "$TMP/deck.json")"
  ok "덱 저장 (선발 11 + 벤치 2)"

  match="$(curl -s -X POST "$BASE/api/matches" -H "Authorization: Bearer $token" \
    -H 'Content-Type: application/json' -d '{}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')"
  [ -n "$match" ] || fail "매치 생성 실패"
  curl -s -X POST "$BASE/api/matches/$match/kickoff" -H "Authorization: Bearer $token" \
    -H 'Content-Type: application/json' -d '{}' >/dev/null
  ok "킥오프 $match"

  say "관찰 (재생 창은 스킵 API 로 당긴다)"
  local seen="" st start elapsed skipped=""
  start=$(date +%s)
  # 240 × 0.5s = 120초 상한. 스킵을 쓰면 실측 완주는 그 한참 안쪽이고(전·후반 시뮬 + GEN 잡),
  # 상한은 "영영 안 끝나는" 부류를 잡는 안전망이다(무한대기 금지).
  for _ in $(seq 1 240); do
    st="$(curl -s -H "Authorization: Bearer $token" "$BASE/api/matches/$match" \
      | python3 -c 'import sys,json;print(json.load(sys.stdin).get("state",""))' 2>/dev/null)"
    case " $seen " in
      *" $st "*) : ;;
      *) if [ -n "$st" ]; then
           elapsed=$(( $(date +%s) - start ))
           seen="$seen $st"
           printf '   t+%03ds  %s\n' "$elapsed" "$st"
         fi ;;
    esac
    [ "$st" = "FINISHED" ] && break
    [ "$st" = "FAILED" ] && fail "매치가 FAILED — AI 잡이 죽었다 ($TMP/executor.log)"
    # 재생 창(전·후반)에 들어가면 한 번씩 당긴다. phase 를 바디에 실어야 하고(서버가 CAS 로
    # 재전송을 막는다) 단계당 1회면 충분하다.
    case "$st" in
      FIRST_HALF|SECOND_HALF)
        case " $skipped " in
          *" $st "*) : ;;
          *)
            local code
            code="$(curl -s -o "$TMP/skip-$st.json" -w '%{http_code}' \
              -X POST "$BASE/api/matches/$match/skip" -H "Authorization: Bearer $token" \
              -H 'Content-Type: application/json' -d "{\"phase\":\"$st\"}")"
            if [ "$code" = "200" ]; then
              skipped="$skipped $st"
              printf '   ⏩ %s 재생 창 당김\n' "$st"
            else
              # 409 = 그 사이 다음 단계로 넘어갔다(경합). 그건 정상 — 다음 루프가 새 상태를 본다.
              [ "$code" = "409" ] || fail "스킵 실패 HTTP $code: $(cat "$TMP/skip-$st.json")"
            fi ;;
        esac ;;
    esac
    sleep 0.5
  done
  [ "$st" = "FINISHED" ] || fail "매치가 안 끝났다(관찰:$seen)"
  echo "$seen" > "$TMP/states.txt"
  ok "관찰된 상태:$seen"
}

# ── 서브커맨드 ───────────────────────────────────────────────────────────
CMD="${1:-up}"
case "$CMD" in
  doctor)
    # ⚠️ `exit $?` 를 doctor 바로 뒤가 아닌 곳에 두지 마라 — 구 코드는 `doctor; QUIET_EXIT=1; exit $?`
    #    라서 `$?` 가 **대입문**(항상 0)의 상태를 읽었고, 전제 미충족을 발견해 경고를 찍고도
    #    **항상 exit 0** 으로 끝났다. 사람은 텍스트를 보지만 `doctor && up` 이나 CI 래퍼처럼
    #    **기계가 읽는 신호는 거짓**이 된다(#471 패널 S2R).
    doctor
    ret=$?
    QUIET_EXIT=1
    exit $ret
    ;;

  smoke)
    # 판정 모드 — 결정론·오프라인이 기본(stub). 시계도 압축해 몇 초만에 완주를 본다.
    doctor || true
    require_free_ports
    AI_MODE_WANTED="${AI_MODE_WANTED:-stub}"
    HALFTIME_MS="${HALFTIME_MS:-3000}"
    resolve_java || fail "JDK 21 이 필요하다 (doctor 참고)"
    start_runner
    start_java
    start_executor "$AI_MODE_WANTED"
    show_ai_mode 1
    play_once
    printf '\n\033[32mPASS — 클론 하나에서 빌드·기동·가입·덱·매치 완주까지 돌았다\033[0m\n'
    ;;

  e2e)
    # 상시 회귀용 — hero 요구 "앞으로도 E2E 테스트로 사용할거임"(#471 AC4).
    # AI 는 stub 고정(결정론·오프라인). 라이브 AI 판정은 `up` 으로 사람이 본다.
    doctor || true
    require_free_ports
    AI_MODE_WANTED="${AI_MODE_WANTED:-stub}"
    # ⚠️ **시계는 끈다**(`enabled=false` = 문서화된 롤백 스위치, application.yml:157).
    #    이 세 스펙은 하프타임 패널을 **90초** 안에 기다리는데 재생 창은 실측 **221초**다(AC1) —
    #    시계를 켠 채로는 스펙이 구조적으로 통과할 수 없다. 그리고 이 셋의 주제는 재생 페이싱이
    #    아니라 **플로우**(로그인→덱→매치→결과→전적)다. 시계 자체는 `match-live-clock.spec.ts`
    #    가 소유하고 그건 여기 셋에 없다.
    JAVA_EXTRA_OPTS="${JAVA_EXTRA_OPTS:--Dhmb.match.clock.enabled=false}"
    resolve_java || fail "JDK 21 이 필요하다 (doctor 참고)"
    start_runner
    start_java
    start_executor "$AI_MODE_WANTED"
    show_ai_mode 1
    run_web_e2e
    printf '\n\033[32mPASS — 실서버 web E2E (목킹 0 · 스킵 0)\033[0m\n'
    ;;

  up)
    # 플레이 모드 — 라이브 AI 를 기본으로 시도한다(로그인 안 돼 있으면 실행기가 스텁으로 강등).
    doctor || true
    AI_MODE_WANTED="${AI_MODE_WANTED:-claude-code}"
    resolve_java || fail "JDK 21 이 필요하다 (doctor 참고)"
    start_runner
    start_java
    start_executor "$AI_MODE_WANTED"
    show_ai_mode 0
    start_web
    say "준비 완료"
    printf '   \033[1m브라우저로 %s 를 열어라\033[0m\n' "$WEB_URL"
    info "API $BASE · 로그 $TMP · 종료 Ctrl-C"
    # 자식 중 하나라도 죽으면 같이 내려간다(반쯤 죽은 스택으로 헤매지 않게).
    wait -n 2>/dev/null || wait
    ;;

  *)
    cat >&2 <<EOF
사용법: bash scripts/local-stack.sh [doctor|up|smoke|e2e]

  doctor   전제(node·JDK21·npm·claude)만 점검한다. 아무것도 띄우지 않는다.
  up       4프로세스를 띄우고 브라우저로 플레이한다(Ctrl-C 로 정리).
  smoke    띄우고 가입·덱·매치 완주까지 자동 판정한 뒤 정리한다.
  e2e      띄우고 **실서버** web E2E 3스펙을 돌린다(목킹 0 · 스킵 0 이 계약).

env: HMB_LOCAL_JAVA_PORT(${JAVA_PORT}) HMB_LOCAL_RUNNER_PORT(${RUNNER_PORT}) HMB_LOCAL_WEB_PORT(${WEB_PORT})
     HMB_LOCAL_AI(stub|claude-code) HMB_LOCAL_HALFTIME_MS HMB_LOCAL_STATE_DIR
EOF
    QUIET_EXIT=1
    exit 2
    ;;
esac
