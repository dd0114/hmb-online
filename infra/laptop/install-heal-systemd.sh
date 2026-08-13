#!/usr/bin/env bash
# 랩탑(WSL2 Ubuntu)용 자가복구 설치기 — 맥의 infra/install-tunnel-heal.sh 의 **스케줄러만** 바꾼 것.
#
#   bash infra/laptop/install-heal-systemd.sh            # 설치
#   bash infra/laptop/install-heal-systemd.sh --status   # 상태
#   bash infra/laptop/install-heal-systemd.sh --uninstall
#
# ⚠️ 워치독 본체(infra/tunnel-heal.sh)는 **재작성하지 않는다 — 그대로 이식한다**. 그 안의 판정
#    규칙 5개(PID≠헬스 · 해석기 다중 · 토큰 없는 401 프로브 · 백엔드 사망 시 터널 재기동 금지 ·
#    PID 로만 kill)는 전부 실장애에서 나온 것이라, 새로 쓰면 그 학습을 통째로 버린다.
#    실제로 그 스크립트엔 macOS 관용구가 **하나도 없다**(launchctl/osascript/BSD sed 전무) —
#    갈아끼울 것은 launchd → systemd timer 뿐이다.
#
# ── launchd → systemd 대응표 (실장애에서 나온 조항이 어디로 갔나) ──────────────
#   StartInterval 60         → .timer 의 OnUnitActiveSec=60s
#   RunAtLoad true           → .timer 의 OnBootSec=90s (부팅 직후 첫 틱)
#   AbandonProcessGroup true → .service 의 **KillMode=process**  ⚠️ 아래 주석 필독
#   WorkingDirectory         → .service 의 WorkingDirectory
#   EnvironmentVariables     → .service 의 Environment=
#   StandardOut/ErrorPath    → journald (+ 워치독 자체 로그 $STATE_DIR/tunnel-heal.log)

set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

LABEL=hmb-tunnel-heal
BIN="${HMB_BIN_DIR:-$HOME/.local/bin}"
STATE_DIR="${HMB_STATE_DIR:-$HOME/.local/state/hmb}"
INTERVAL="${HMB_HEAL_INTERVAL:-60}"

# ⚠️ 이 랩탑의 WSL 은 기본 사용자가 **root** 다(/etc/wsl.conf 에 [user] 섹션 없음). root 로는
#    `systemctl --user` 가 세션 D-Bus 없이 뜨지 않고, 애초에 시스템 유닛이 옳다 — 부팅과 동시에
#    돌고 linger 가 필요 없다. 비-root 로 바뀌어도 그대로 돌게 두 경우를 다 받는다.
if [ "$(id -u)" -eq 0 ]; then
  UNIT_DIR=/etc/systemd/system; SCTL="systemctl";        WANTED=timers.target
else
  UNIT_DIR="$HOME/.config/systemd/user"; SCTL="systemctl --user"; WANTED=timers.target
fi

command -v systemctl >/dev/null 2>&1 || {
  echo "[install] ✗ systemctl 이 없다 — /etc/wsl.conf 에 [boot] systemd=true 를 넣고 WSL 을 재기동할 것"
  echo "          ⚠️ 이 랩탑에서 'wsl --shutdown' 은 금지다(LxssManager 가 STOP_PENDING 으로 물린다)."
  echo "             'wsl --terminate Ubuntu' 또는 재부팅을 쓴다."
  exit 1; }

case "${1:-}" in
  --uninstall)
    $SCTL disable --now "$LABEL.timer" 2>/dev/null || true
    rm -f "$UNIT_DIR/$LABEL.timer" "$UNIT_DIR/$LABEL.service"
    $SCTL daemon-reload 2>/dev/null || true
    echo "[install] 해제 완료"; exit 0;;
  --status)
    $SCTL list-timers "$LABEL.timer" --all 2>/dev/null || echo "[install] 미설치"
    echo "--- 최근 서비스 실행 ---"
    $SCTL status "$LABEL.service" --no-pager -n 10 2>/dev/null || true
    echo "--- 최근 이벤트 ---"; tail -5 "$STATE_DIR/tunnel-heal.log" 2>/dev/null || echo "(없음)"
    echo "--- DEGRADED ---"; ls -l "$STATE_DIR/DEGRADED" 2>/dev/null || echo "(없음 — 정상)"
    exit 0;;
esac

mkdir -p "$BIN" "$STATE_DIR" "$UNIT_DIR"

# ── heal.conf 보장 — 랩탑이 라이브 web 을 건드리지 않는 **유일한** 근거 (#489 단계3.5) ────────
#
# 구 설치는 이 파일을 만들지 않고 README 가 사람에게 부탁만 했다. 그래서 **설치 직후 콜드 스타트**
# 에는 파일이 없고, 그 상태로 워치독이 한 틱만 돌면 전파가 기본값 = **라이브 Pages 프로젝트**로
# 나간다(= 이사가 계획 밖에서 일어난다). 설치기가 만든다.
#
# ⚠️ 이미 있으면 **덮어쓰지 않는다** — 사람이 상한(HMB_HEAL_MAX_PER_HOUR) 등을 조정해 뒀을 수 있다.
#    대신 아래 selftest 가 내용을 검사해서 잘못돼 있으면 설치를 실패시킨다.
# ⚠️ 컷오버(단계4)는 `HMB_ALLOW_LIVE=1` 로 설치한다 — 그때는 이 파일을 만들지 않는다.
HEAL_CONF="${HMB_HEAL_CONF:-$STATE_DIR/heal.conf}"
LAB_PROJECT="${HMB_LAB_PAGES_PROJECT:-hmb-online-lab}"
if [ "${HMB_ALLOW_LIVE:-0}" = "1" ]; then
  echo "[install] ! HMB_ALLOW_LIVE=1 — heal.conf 를 만들지 않는다 (컷오버 모드: 전파가 라이브로 나간다)"
elif [ -f "$HEAL_CONF" ]; then
  echo "[install] heal.conf 이미 있음 — 덮어쓰지 않는다: $HEAL_CONF"
  grep -nE 'PAGES_PROJECT' "$HEAL_CONF" | sed 's/^/[install]   /' \
    || echo "[install]   ⚠️ PAGES_PROJECT 선언이 없다 — 아래 사전점검이 ✗ 로 잡는다"
else
  {
    echo "# HMB 워치독 런타임 노브 — install-heal-systemd.sh 가 생성 (#489 단계3.5)"
    echo "# 워치독이 매 틱 source 한다. 아래 한 줄이 '랩탑은 라이브 web 을 건드리지 않는다' 의 근거다."
    echo "# ⚠️ export 필수 — heal.conf 를 source 하는 다른 경로(수동 deploy-web.sh 등)까지 전달되어야 한다."
    echo "# 컷오버(단계4) = 이 줄을 지우고  HMB_ALLOW_LIVE=1 로 재설치·재점검."
    echo "export PAGES_PROJECT=$LAB_PROJECT"
  } > "$HEAL_CONF"
  echo "[install] heal.conf 생성 → $HEAL_CONF (export PAGES_PROJECT=$LAB_PROJECT)"
fi

# ⚠️ 사용자 유닛일 때만 linger 가 필요하다 — 없으면 로그인해야 돌기 시작해서 AC1(재부팅 무개입
#    기동)이 조용히 퇴화한다. 시스템 유닛(root)은 부팅과 동시에 돌므로 해당 없음.
if [ "$(id -u)" -ne 0 ] && ! loginctl show-user "$USER" -p Linger --value 2>/dev/null | grep -q yes; then
  echo "[install] linger 활성화 (로그인 없이 유닛이 돌게)"
  sudo loginctl enable-linger "$USER" || echo "[install] ⚠️ linger 실패 — 로그인 후에만 워치독이 돈다"
fi

SHA=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
install_one(){ # <src> <dest>
  { printf '#!/usr/bin/env bash\n# ⚠️ 자동 설치본 — 원본은 리포의 %s (커밋 %s). 고치려면 원본을 고치고\n#    bash infra/laptop/install-heal-systemd.sh 를 다시 실행한다.\n' "$1" "$SHA"
    tail -n +2 "$1"; } > "$2"
  chmod +x "$2"
  echo "[install] $1 → $2"
}
install_one infra/tunnel-heal.sh          "$BIN/hmb-tunnel-heal.sh"
install_one infra/publish-backend-url.sh  "$BIN/hmb-publish-backend-url.sh"

NODE_BIN=$(dirname "$(command -v node 2>/dev/null || echo /usr/bin/node)")
# ⚠️ /tmp 에 두지 마라 — 리눅스는 /tmp 를 청소한다. 초판이 /tmp/hmb-wrangler-work 였고, 청소된
#    뒤로 서비스가 매 틱 `status=200/CHDIR` 로 **즉사**했다(2026-08-12 실측: 21:06~21:10 전 틱 실패,
#    힐 기록은 전날 22:59 에서 멈춤). 타이머는 계속 `active` 로 보여서 겉으로는 정상이었다 —
#    워치독이 죽은 줄도 모르는 상태가 가장 나쁘다.
WORKDIR="${HMB_WORK_DIR:-$STATE_DIR/wrangler-work}"
mkdir -p "$WORKDIR"

# wrangler 선설치 — `npx -y wrangler` 는 실행마다 레지스트리를 확인해 **수 분**이 걸릴 수 있다
# (맥 실측 ~4분: 자가복구 MTTR 을 통째로 잡아먹었다).
if ! command -v wrangler >/dev/null 2>&1 && [ "${HMB_SKIP_WRANGLER_INSTALL:-0}" != "1" ]; then
  echo "[install] wrangler 전역 설치 (자가복구 전파 속도용)"
  npm i -g wrangler >/dev/null 2>&1 || echo "[install] ⚠️ 전역 설치 실패 — npx 폴백(느림)"
fi

cat > "$UNIT_DIR/$LABEL.service" <<EOF
[Unit]
Description=HMB tunnel self-heal (one tick)
After=network-online.target docker.service

[Service]
Type=oneshot
# ⚠️ 작업 디렉토리가 없으면 systemd 는 스크립트를 **실행조차 하지 않는다**(200/CHDIR). 자가복구가
#    자기 디렉토리 하나 때문에 죽지 않도록 매 틱 만들어 둔다('-' = 실패해도 계속).
ExecStartPre=-/bin/mkdir -p $WORKDIR
ExecStart=$BIN/hmb-tunnel-heal.sh --once
# ⚠️ `WorkingDirectory` 앞의 **'-' 가 없으면 위 ExecStartPre 는 무용지물**이다 — systemd 는
#    WorkingDirectory 를 ExecStartPre 를 포함한 **모든 Exec 줄에** 적용하므로, 디렉토리가 없으면
#    "되살리는 mkdir" 자체가 CHDIR 에서 죽는다. 실측(#489 AC5 회차4, 2026-08-13 01:00:13Z):
#      Failed at step CHDIR spawning …/hmb-tunnel-heal.sh: No such file or directory
#      hmb-tunnel-heal.service: Main process exited, code=exited, status=200/CHDIR
#    그동안 터널은 죽은 채였고 **워치독은 단 한 틱도 돌지 못했다**(사람이 mkdir 할 때까지).
#    '-' 면 chdir 실패를 무시하고 진입하므로 ExecStartPre 가 디렉토리를 되살리고, 다음 Exec 줄의
#    chdir 은 성공한다. (전파는 publish 가 자기 workdir 로 다시 cd 하므로 cwd 에 의존하지 않는다.)
WorkingDirectory=-$WORKDIR
Environment=PATH=$NODE_BIN:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin
Environment=HOME=$HOME
# ⚠️ KillMode=process 는 launchd 의 AbandonProcessGroup 과 같은 자리다. 기본값
#    (control-group)이면 이 oneshot 이 끝나는 순간 systemd 가 **같은 cgroup 을 청소**하면서
#    치유가 방금 띄운 cloudflared 를 회수한다 → 매 틱 새 터널을 만드는 스래시 루프.
#    맥에서 실제로 그렇게 됐다(그래서 그쪽엔 AbandonProcessGroup 이 박혀 있다).
KillMode=process
EOF

cat > "$UNIT_DIR/$LABEL.timer" <<EOF
[Unit]
Description=HMB tunnel self-heal every ${INTERVAL}s

[Timer]
# 부팅 직후 한 번(=RunAtLoad) 후 ${INTERVAL}초 간격. Persistent 는 쓰지 않는다 —
# 밀린 틱을 몰아 실행하면 힐 상한(MAX_HEALS_PER_HOUR)을 헛되이 태운다.
OnBootSec=90s
OnUnitActiveSec=${INTERVAL}s
AccuracySec=5s
Unit=$LABEL.service

[Install]
WantedBy=$WANTED
EOF

$SCTL daemon-reload

echo ""
echo "── 사전점검 (⚠️ 타이머 기동 **전**) ──"
# ⚠️ 여기서 **설치를 실패시킨다** — 경고만 찍고 통과시키면 아무도 안 본다(맥 설치기가 그 모양이고,
#    그래서 heal.conf 부재가 AC1~AC4 를 전부 통과했다). selftest 에는 전파 대상 게이트가 들어 있어
#    "이 랩탑이 라이브로 배포하게 돼 있는가" 를 여기서 잡는다.
# ⚠️ 그리고 **enable --now 앞에** 둔다 — 뒤에 두면 잘못 겨눠진 워치독이 90초 뒤 첫 틱에 라이브로
#    배포해 놓고 사람에게 "고치세요" 를 출력하는 꼴이 된다(= 이 게이트가 막으려던 바로 그 사고).
if ! HMB_STATE_DIR="$STATE_DIR" "$BIN/hmb-tunnel-heal.sh" --selftest; then
  echo ""
  echo "[install] ✗ 사전점검 실패 — **타이머를 기동하지 않았다**(유닛 파일만 기록됨)."
  echo "[install]   위 ✗ 항목을 해결하고 다시 실행할 것.  현재 상태: $SCTL list-timers $LABEL.timer --all"
  exit 1
fi

$SCTL enable --now "$LABEL.timer"
echo "[install] systemd timer 등록 완료 (매 ${INTERVAL}초, scope=$UNIT_DIR)"
echo ""
echo "상태 보기 : bash infra/laptop/install-heal-systemd.sh --status"
echo "이벤트 로그: tail -f $STATE_DIR/tunnel-heal.log"
echo "해제      : bash infra/laptop/install-heal-systemd.sh --uninstall"
