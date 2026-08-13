#!/usr/bin/env bash
# 랩탑(WSL2 Ubuntu)용 부팅 기동 — 부팅하면 사람 손 없이 백엔드가 뜬다 (#489 AC1).
#
#   bash infra/laptop/install-stack-systemd.sh            # 설치
#   bash infra/laptop/install-stack-systemd.sh --status
#   bash infra/laptop/install-stack-systemd.sh --uninstall
#
# ── 역할 경계 (왜 터널을 여기서 안 띄우나) ────────────────────────────────────
# 이 유닛은 **백엔드까지만** 책임진다. 터널은 워치독(hmb-tunnel-heal.timer)이 띄운다 —
# 그쪽의 OnBootSec 틱이 "터널이 없다"를 정상적인 치유 대상으로 이미 처리하기 때문이다.
# 부팅 경로와 치유 경로가 **같은 코드**를 타야 AC1 과 AC3 이 서로를 검증한다. 여기서 따로
# 띄우면 부팅 직후 워치독과 둘이 각자 터널을 만들어 URL 이 두 개가 된다(맥 초기의 실패형).
#
# ⚠️ 부팅 사슬은 3단이고, 이 스크립트는 **가운데 한 단**이다:
#   ① Windows 작업 스케줄러 AtStartup → `wsl -d Ubuntu`  (infra/laptop/install-windows-boot-task.ps1)
#   ② WSL systemd → docker.service + 이 유닛 + heal.timer
#   ③ 워치독 첫 틱 → 터널 기동 + web 재결선
# ①이 없으면 아무도 WSL 을 깨우지 않아 ②③이 영영 안 돈다(WSL 은 요청이 있어야 뜬다).

set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

LABEL=hmb-stack
REPO="$(pwd)"

# root 면 시스템 유닛(부팅 즉시·linger 불필요), 아니면 사용자 유닛 — install-heal-systemd.sh 와 같은 규칙.
if [ "$(id -u)" -eq 0 ]; then
  UNIT_DIR=/etc/systemd/system; SCTL="systemctl";                 WANTED=multi-user.target
else
  UNIT_DIR="$HOME/.config/systemd/user"; SCTL="systemctl --user"; WANTED=default.target
fi

command -v systemctl >/dev/null 2>&1 || {
  echo "[stack] ✗ systemctl 없음 — /etc/wsl.conf 에 [boot] systemd=true 후 WSL 재기동"
  echo "        ⚠️ 'wsl --shutdown' 금지(LxssManager STOP_PENDING). 'wsl --terminate Ubuntu' 또는 재부팅."
  exit 1; }

case "${1:-}" in
  --uninstall)
    $SCTL disable --now "$LABEL.service" 2>/dev/null || true
    rm -f "$UNIT_DIR/$LABEL.service"; $SCTL daemon-reload 2>/dev/null || true
    echo "[stack] 해제 완료"; exit 0;;
  --status)
    $SCTL status "$LABEL.service" --no-pager -n 15 2>/dev/null || echo "[stack] 미설치"
    echo "--- 컨테이너 ---"; docker ps --format '{{.Names}}\t{{.Status}}' 2>&1
    exit 0;;
esac

mkdir -p "$UNIT_DIR"

cat > "$UNIT_DIR/$LABEL.service" <<EOF
[Unit]
Description=HMB p3 backend stack (java + runner)
After=network-online.target docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$REPO/infra
# compose 의 restart: unless-stopped 가 dockerd 재기동 시 컨테이너를 되살리지만, 그건
# **컨테이너가 이미 존재할 때**의 이야기다. 첫 기동·prune 이후엔 아무도 만들어 주지 않는다.
# up -d 는 멱등이라 두 경우를 한 줄로 덮는다.
ExecStart=/usr/bin/docker compose up -d java runner
# ⚠️ 데모 8080/8790 은 절대 건드리지 않는다 — 이 compose 는 18080/18790 만 쓴다.
ExecStop=/usr/bin/docker compose stop java runner
TimeoutStartSec=600

[Install]
WantedBy=$WANTED
EOF

$SCTL daemon-reload
$SCTL enable --now "$LABEL.service"
echo "[stack] systemd 유닛 등록 완료 → $UNIT_DIR/$LABEL.service"

echo ""
echo "── 헬스 대기 (최대 240초) ──"
for i in $(seq 1 48); do
  j=$(docker inspect -f '{{.State.Health.Status}}' hmb-java 2>/dev/null || echo none)
  r=$(docker inspect -f '{{.State.Health.Status}}' hmb-runner 2>/dev/null || echo none)
  echo "t=$((i*5))s java=$j runner=$r"
  [ "$j" = healthy ] && [ "$r" = healthy ] && break
  sleep 5
done
echo ""
echo "상태 보기: bash infra/laptop/install-stack-systemd.sh --status"
