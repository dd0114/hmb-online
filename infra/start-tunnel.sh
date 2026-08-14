#!/usr/bin/env bash
# 백엔드(18080)에 Cloudflare quick tunnel 을 띄우고, 그 URL 로 web 을 재배포한다.
# 테스터 링크를 (재)기동하는 한 방 커맨드.
#
#   bash infra/start-tunnel.sh
#
# 왜 quick tunnel: 무료·로그인 불필요·동시요청 부하 잘 버팀(ngrok 무료는 앱 로드 폭주에서 터짐 —
# 실측 CF 8/8 vs ngrok 0/8). 단점=재시작 시 URL 바뀜 → 이 스크립트가 재배포까지 해결.
#
# 전제: 백엔드 stack(java 18080)이 이미 떠 있어야 한다(cd infra && docker compose up -d java runner).
#
# 🛑 URL 이 바뀌는 것은 **감수하기로 확정된 성질**이다 — 고치려 들지 마라.
#    hero 가 2026-07-31 에 상시 고정 URL(named tunnel) 승격을 **전면 중단**하고
#    "현행 quick tunnel + 워치독 + 런타임 config 전파를 유지, **다시 제안하지 않는다**" 로
#    확정했다(docs/plan-v4/deploy-playbook.md §6). URL 회전은 워치독이 config.json 을
#    갱신해 흡수한다 — 승격 견적을 다시 쓰는 대신 그 전파 경로를 고쳐라.

set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

LOG=/tmp/hmb-cf-tunnel.log
PIDF=/tmp/hmb-cf-tunnel.pid

# 기존 터널 있으면 정리(PID로만 — 패턴 kill 금지)
if [ -f "$PIDF" ] && ps -p "$(cat "$PIDF")" >/dev/null 2>&1; then
  echo "[tunnel] 기존 터널 종료 (pid $(cat "$PIDF"))"; kill "$(cat "$PIDF")" 2>/dev/null || true; sleep 1
fi

# ⚠️ 로그를 덮어쓰기 **전에** 보존한다 (#505 B). 2026-08-14 장애에서 이 세 줄이 없어서,
#    사람이 이 스크립트를 돌린 순간 워치독 2차 치유의 실패 사유가 **영구 소실**됐다.
#    (워치독과 같은 보관함을 쓴다 — /tmp 가 아니라 STATE_DIR: /tmp 는 부팅 때 비워진다, #497.)
ARCH="${HMB_STATE_DIR:-$HOME/.local/state/hmb}/tunnel-logs"
[ -s "$LOG" ] && { mkdir -p "$ARCH"; cp -f "$LOG" "$ARCH/$(date -u +%Y%m%dT%H%M%SZ)-manual.log" 2>/dev/null || true; }

echo "[tunnel] cloudflared quick tunnel 기동 → localhost:18080"
# `--protocol` 기본 http2 — 근거·실장애 기록은 tunnel-heal.sh 의 같은 자리 주석 참조
# (QUIC 는 핫스팟/제한 NAT 에서 죽는다. 되돌리기 = HMB_TUNNEL_PROTOCOL=quic).
nohup cloudflared tunnel --url http://localhost:18080 --no-autoupdate \
  --protocol "${HMB_TUNNEL_PROTOCOL:-http2}" > "$LOG" 2>&1 &
echo $! > "$PIDF"

URL=""
for _ in $(seq 1 30); do
# ⚠️ `grep -a` 와 `api.` 배제는 **둘 다 필수**다 — 워치독(`tunnel-heal.sh`)만 고쳐 두고 여기를 빼먹어서
#    2026-08-03 에 실제로 깨졌다: 이 캡처가 URL 대신 **`Binary file … matches`** 를 돌려줬고
#    그 문자열이 그대로 web `config.json` 에 배포됐다(= 내 손으로 서비스를 끊었다).
#    ① `-a` 없으면 cloudflared 로그에 제어문자가 섞이는 순간 grep 이 바이너리로 판정한다.
#    ② `api.trycloudflare.com` 은 cloudflared 의 **등록 엔드포인트**이지 우리 터널이 아니다(#391).
  URL=$(grep -aoE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" \
        | grep -v '^https://api\.trycloudflare\.com$' | head -1 || true)
  [ -n "$URL" ] && break
  sleep 2
done
[ -z "$URL" ] && { echo "[tunnel] URL 획득 실패 — $LOG 확인"; exit 1; }
echo "[tunnel] URL = $URL (pid $(cat "$PIDF"))"

bash infra/deploy-web.sh "$URL"
echo "[tunnel] 테스터 접속: https://${PAGES_PROJECT:-hmb-online}.pages.dev"
