#!/usr/bin/env bash
# 랩탑(WSL2 Ubuntu)에 **DB 정기 백업**을 건다 (#489). 본체 = infra/laptop/db-backup.sh
#
#   bash infra/laptop/install-db-backup.sh             # 설치 + 타이머 활성
#   bash infra/laptop/install-db-backup.sh --status
#   bash infra/laptop/install-db-backup.sh --run       # 지금 1회 (서비스 경로로)
#   bash infra/laptop/install-db-backup.sh --uninstall
#
# 스케줄러는 hmb-tunnel-heal 과 **같은 관용구**(시스템 systemd 유닛)를 쓴다 — 이 WSL 의 기본
# 사용자가 root 라 `systemctl --user` 는 세션 D-Bus 없이 뜨지 않는다(install-heal-systemd.sh 주석).
#
# ⚠️ **sqlite 이미지를 미리 굽는다.** 런북 P2-12 는 매번 `apk add --no-cache sqlite` 를 했는데,
#    그건 백업이 **네트워크에 의존**한다는 뜻이다. 백업은 네트워크가 죽은 날에도 돌아야 하므로
#    한 번 구워서 `hmb/sqlite3:local` 로 고정한다.
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

LABEL=hmb-db-backup
BIN="${HMB_BIN_DIR:-/opt/hmb/bin}"
DEST="${HMB_BACKUP_DIR:-/var/backups/hmb}"
KEEP="${HMB_BACKUP_KEEP:-7}"
IMG="${HMB_SQLITE_IMG:-hmb/sqlite3:local}"
BASE="${HMB_SQLITE_BASE:-alpine:3.20}"
# 04:00 KST = 19:00 UTC. 라이브 트래픽이 가장 얇은 시간대.
ONCAL="${HMB_BACKUP_ONCALENDAR:-*-*-* 19:00:00 UTC}"

if [ "$(id -u)" -eq 0 ]; then UNIT_DIR=/etc/systemd/system; SCTL=systemctl
else echo "[install] ✗ root 로 실행할 것 (시스템 유닛 + /var/backups 쓰기)"; exit 1; fi

case "${1:-}" in
  --status)
    $SCTL status "$LABEL.timer" --no-pager 2>&1 | head -12
    $SCTL list-timers "$LABEL.timer" --no-pager 2>&1 | head -3
    [ -x "$BIN/db-backup.sh" ] && "$BIN/db-backup.sh" --status
    exit 0 ;;
  --run)
    $SCTL start "$LABEL.service" && echo "[install] 실행함 — 결과:" && sleep 2
    $SCTL status "$LABEL.service" --no-pager 2>&1 | tail -6
    exit 0 ;;
  --uninstall)
    $SCTL disable --now "$LABEL.timer" 2>/dev/null
    rm -f "$UNIT_DIR/$LABEL.timer" "$UNIT_DIR/$LABEL.service"
    $SCTL daemon-reload
    echo "[install] 제거함. ⚠️ 백업 파일은 남겨 뒀다: $DEST"
    exit 0 ;;
esac

# ── ① sqlite 이미지 (네트워크 비의존화) ─────────────────────────────────────
if docker image inspect "$IMG" >/dev/null 2>&1; then
  echo "[install] ✓ $IMG 이미 있음"
else
  echo "[install] $IMG 굽는 중 ($BASE + sqlite)…"
  printf 'FROM %s\nRUN apk add --no-cache sqlite\nENTRYPOINT []\n' "$BASE" \
    | docker build -q -t "$IMG" - >/dev/null || { echo "[install] ✗ 이미지 빌드 실패"; exit 1; }
    # ⚠️ 컨텍스트는 `-` (stdin) 다. `-f - .` 로 쓰면 리포 루트 전체를 데몬에 올린다.
  echo "[install] ✓ $IMG"
fi
docker run --rm "$IMG" sqlite3 --version >/dev/null 2>&1 \
  || { echo "[install] ✗ $IMG 안에서 sqlite3 가 안 돈다"; exit 1; }

# ── ② 본체 설치 ─────────────────────────────────────────────────────────────
install -d "$BIN" "$DEST" /var/log/hmb
install -m 0755 infra/laptop/db-backup.sh "$BIN/db-backup.sh"
echo "[install] ✓ $BIN/db-backup.sh"

# ── ③ 유닛 ──────────────────────────────────────────────────────────────────
cat > "$UNIT_DIR/$LABEL.service" <<UNIT
[Unit]
Description=HMB 라이브 DB 백업 (sqlite .backup + 무결성 검증 + 세대 정리)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
Environment=HMB_BACKUP_DIR=$DEST
Environment=HMB_BACKUP_KEEP=$KEEP
Environment=HMB_SQLITE_IMG=$IMG
ExecStart=$BIN/db-backup.sh
# 737MB .backup + integrity_check — 넉넉히
TimeoutStartSec=1800
UNIT

cat > "$UNIT_DIR/$LABEL.timer" <<UNIT
[Unit]
Description=HMB DB 백업 타이머 (매일 $ONCAL)

[Timer]
OnCalendar=$ONCAL
# ⚠️ 랩탑은 꺼져 있을 수 있다. 놓친 실행은 다음 기동 때 따라잡는다.
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
UNIT

$SCTL daemon-reload
$SCTL enable --now "$LABEL.timer" >/dev/null 2>&1
echo "[install] ✓ $LABEL.timer 활성"
$SCTL list-timers "$LABEL.timer" --no-pager 2>&1 | head -3
echo "[install] 다음: bash infra/laptop/install-db-backup.sh --run   # 첫 사이클 즉시 검증"
