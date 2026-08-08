#!/usr/bin/env bash
# AC1.3 계약 — 자가복구 워치독의 OS 이식 (#472 W1)
#
# 왜 이 파일이 있나: 터널 자가복구(#183)는 **launchd 전용**으로 짜여 있다. 이사 대상이 리눅스
# (EC2)면 `install-tunnel-heal.sh` 가 `launchctl bootstrap` 에서 죽고, 설치가 실패한 줄도 모르는
# 채로 서버가 뜬다. 그 상태의 실질은 **자가복구가 없는 운영**이다 — 터널은 실측으로 죽는다
# (2026-07-22 `control stream failure`). 사람이 매번 가야 하고, 밤이면 아침까지 죽어 있다.
#
# 그리고 이식은 "launchctl 을 systemctl 로 바꾸기" 가 아니다. #183 이 mac 에서 피 흘려 얻은
# **AbandonProcessGroup=true** 가 systemd 에는 다른 이름으로 있다:
#   - launchd: 잡이 끝나면 같은 프로세스 그룹을 회수한다 → 워치독이 띄운 cloudflared 가 즉사 →
#     매 틱 새 터널을 만드는 **스래시 루프**(실측). AbandonProcessGroup=true 로 막았다.
#   - systemd: `Type=oneshot` 의 메인 프로세스가 끝나면 **cgroup 의 잔여 프로세스를 죽인다**
#     (KillMode 기본값 control-group). 즉 **같은 고장이 이름만 바꿔 재현된다.**
#     → `KillMode=process` 가 그 자리의 등가물이다. 이게 빠진 이식은 "돌아가는 것처럼 보이는" 이식이다.
#
# 그래서 이 계약은 "systemd 를 쓴다" 가 아니라 **"두 OS 에서 같은 성질이 성립한다"** 를 검정한다.
#
# 실행: bash infra/tests/watchdog-portability.test.sh
# 판정: exit code. 실패 1건이라도 있으면 exit 1.
#
# ⚠️ 이 테스트는 **실제 launchd/systemd 를 건드리지 않는다.** HOME 을 임시 디렉토리로 갈아끼우고
#    launchctl·systemctl·loginctl 을 PATH 스텁으로 가려, 설치기가 *무엇을 호출했는지* 를 기록으로 본다.
#    (라이브 머신에서 돌려도 안전해야 한다 — 이 머신엔 실제 워치독이 가동 중이다.)
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ✓ %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  ✗ %s\n' "$1"; }
head_(){ printf '\n[%s] %s\n' "$1" "$2"; }

INSTALL=infra/install-tunnel-heal.sh
PORTABLE=infra/lib/portable.sh
STATUS=infra/status.sh

TD=$(mktemp -d); trap 'rm -rf "$TD"' EXIT
STUB="$TD/bin"; mkdir -p "$STUB"

# 호출 기록 스텁 — 실제 서비스 관리자를 부르지 않고 "무엇을 부르려 했나" 만 남긴다.
for c in launchctl systemctl loginctl; do
  cat > "$STUB/$c" <<EOF
#!/usr/bin/env bash
printf '%s %s\n' "$c" "\$*" >> "$TD/calls.log"
exit 0
EOF
  chmod +x "$STUB/$c"
done

# 설치기를 샌드박스에서 1회 돌린다.  run_install <os> <추가인자...>
#   HOME 을 갈아끼워 실 파일시스템(라이브 워치독)을 건드리지 않는다.
run_install() {
  local os="$1"; shift
  : > "$TD/calls.log"
  HOME="$TD/home" \
  PATH="$STUB:$PATH" \
  HMB_FORCE_OS="$os" \
  HMB_SKIP_WRANGLER_INSTALL=1 \
  HMB_HEAL_SKIP_SELFTEST=1 \
  HMB_WORK_DIR="$TD/work" \
  bash "$INSTALL" "$@" > "$TD/out.log" 2>&1
  echo $?
}

printf '=== AC1.3 워치독 OS 이식 ===\n'

# ── P0: 문법 ──────────────────────────────────────────────────────────
head_ P0 "스크립트 문법"
for f in "$INSTALL" "$PORTABLE" infra/tunnel-heal.sh; do
  bash -n "$f" 2>"$TD/syn" && ok "$(basename "$f"): syntax ok" || bad "$(basename "$f"): $(cat "$TD/syn")"
done

# ── P1: os_kind 를 테스트에서 강제할 수 있다 ──────────────────────────
# 두 분기를 **한 머신에서** 검정하려면 OS 판정을 덮어쓸 수 있어야 한다.
# (이게 없으면 리눅스 분기는 리눅스 머신에서만 검증되고 = 이사 전에는 아무도 안 돌린다.)
head_ P1 "os_kind 오버라이드(HMB_FORCE_OS)"
a=$( HMB_FORCE_OS=linux  bash -c '. infra/lib/portable.sh; os_kind' 2>/dev/null )
b=$( HMB_FORCE_OS=darwin bash -c '. infra/lib/portable.sh; os_kind' 2>/dev/null )
[ "$a" = linux  ] && ok "HMB_FORCE_OS=linux → linux"   || bad "linux 강제 실패 (얻은 값 '$a')"
[ "$b" = darwin ] && ok "HMB_FORCE_OS=darwin → darwin" || bad "darwin 강제 실패 (얻은 값 '$b')"
c=$( bash -c '. infra/lib/portable.sh; os_kind' 2>/dev/null )
[ "$c" = "$(uname -s | tr 'A-Z' 'a-z' | sed 's/darwin/darwin/;s/linux/linux/')" ] \
  && ok "미지정 시 실제 uname 준수" || ok "미지정 시 실제 OS 판정('$c')"

# ── P2: 리눅스 설치가 성공하고 systemd 유닛을 만든다 ──────────────────
head_ P2 "리눅스 — systemd user unit 설치"
rc=$(run_install linux)
if [ "$rc" = "0" ]; then ok "설치기 exit 0"; else bad "설치기 exit $rc: $(tail -3 "$TD/out.log" | tr '\n' ' ')"; fi

UNIT_DIR="$TD/home/.config/systemd/user"
SVC="$UNIT_DIR/hmb-tunnel-heal.service"
TMR="$UNIT_DIR/hmb-tunnel-heal.timer"
[ -f "$SVC" ] && ok "service 유닛 생성" || bad "service 유닛 없음 ($SVC)"
[ -f "$TMR" ] && ok "timer 유닛 생성"   || bad "timer 유닛 없음 ($TMR)"

# ── P3: 스래시 루프 등가물 — KillMode=process ─────────────────────────
# 이 계약의 핵심. 없으면 워치독이 띄운 cloudflared 를 systemd 가 회수해 #183 이 재현된다.
head_ P3 "리눅스 — 자식 프로세스 회수 방지(AbandonProcessGroup 등가)"
if [ -f "$SVC" ]; then
  grep -qE '^KillMode=process' "$SVC" \
    && ok "KillMode=process" \
    || bad "KillMode=process 없음 — oneshot 종료 시 cgroup 이 cloudflared 를 죽인다(#183 스래시 재현)"
  grep -qE '^Type=oneshot' "$SVC" && ok "Type=oneshot" || bad "Type=oneshot 아님"
  grep -q -- '--once' "$SVC" && ok "ExecStart 가 --once 호출" || bad "ExecStart 에 --once 없음"
  grep -qE '^Environment=.*PATH=' "$SVC" \
    && ok "PATH 명시(최소환경에서 node/cloudflared 탐색)" \
    || bad "Environment PATH 없음 — plist EnvironmentVariables 의 등가물이 빠졌다"
else
  bad "service 유닛이 없어 P3 검정 불가"; bad "(동)"; bad "(동)"; bad "(동)"
fi

# ── P4: 타이머 주기가 plist StartInterval 과 같다 ─────────────────────
head_ P4 "리눅스 — 60초 주기"
[ -f "$TMR" ] && { grep -qE '^OnUnitActiveSec=60' "$TMR" && ok "OnUnitActiveSec=60" \
  || bad "OnUnitActiveSec=60 없음 — mac 은 StartInterval 60 인데 주기가 어긋난다"; } \
  || bad "timer 유닛이 없어 P4 검정 불가"

# ── P5: 리눅스 경로가 launchctl 을 부르지 않는다 ──────────────────────
head_ P5 "리눅스 — launchctl 미호출 / systemctl 호출"
grep -q '^launchctl ' "$TD/calls.log" 2>/dev/null \
  && bad "리눅스인데 launchctl 을 불렀다: $(grep '^launchctl' "$TD/calls.log" | head -1)" \
  || ok "launchctl 호출 0"
grep -q 'systemctl .*daemon-reload' "$TD/calls.log" 2>/dev/null \
  && ok "systemctl daemon-reload" || bad "daemon-reload 미호출 — 유닛을 써 놓고 반영을 안 한다"
grep -qE 'systemctl .*enable.*hmb-tunnel-heal\.timer' "$TD/calls.log" 2>/dev/null \
  && ok "timer enable" || bad "timer enable 미호출 — 파일만 놓고 켜지 않았다"

# ── P6: 재부팅 생존 — linger ──────────────────────────────────────────
# systemd user 유닛은 **로그인 세션이 없으면 안 돈다**. 서버(EC2)는 로그인 상태가 아니다.
# loginctl enable-linger 없이는 재부팅 후 워치독이 조용히 사라진다 = 이사 후 첫 재부팅에 터진다.
head_ P6 "리눅스 — linger(로그인 없이 상시 가동)"
if grep -q 'loginctl .*enable-linger' "$TD/calls.log" 2>/dev/null; then
  ok "loginctl enable-linger 호출"
elif grep -qi 'linger' "$TD/out.log" 2>/dev/null; then
  ok "linger 안내 출력(수동 조치 경로)"
else
  bad "linger 처리 없음 — 재부팅/로그아웃 후 워치독이 안 뜬다"
fi

# ── P7: mac 경로는 그대로 살아 있다 (회귀 방지) ───────────────────────
head_ P7 "mac — plist 경로 무회귀"
rc=$(run_install darwin)
[ "$rc" = "0" ] && ok "설치기 exit 0" || bad "설치기 exit $rc: $(tail -3 "$TD/out.log" | tr '\n' ' ')"
PLIST="$TD/home/Library/LaunchAgents/online.hmb.tunnel-heal.plist"
if [ -f "$PLIST" ]; then
  ok "plist 생성"
  grep -q 'AbandonProcessGroup' "$PLIST" \
    && ok "AbandonProcessGroup 유지(#183 회귀 방지)" || bad "AbandonProcessGroup 소실 — #183 스래시 재현"
  grep -qE '<key>StartInterval</key><integer>60</integer>' "$PLIST" \
    && ok "StartInterval 60" || bad "StartInterval 60 아님"
else
  bad "plist 없음 ($PLIST)"; bad "(동)"; bad "(동)"
fi
grep -q '^systemctl ' "$TD/calls.log" 2>/dev/null \
  && bad "mac 인데 systemctl 을 불렀다" || ok "systemctl 호출 0"
grep -q 'launchctl .*bootstrap' "$TD/calls.log" 2>/dev/null \
  && ok "launchctl bootstrap" || bad "launchctl bootstrap 미호출"

# ── P8: --status / --uninstall 도 분기한다 ────────────────────────────
# 설치만 이식하고 조회·해제가 launchctl 에 남으면, 리눅스에서 "미설치" 로 오답하고
# 해제는 조용히 아무것도 안 한다(=유령 워치독).
head_ P8 "--status / --uninstall OS 분기"
for sub in --status --uninstall; do
  rc=$(run_install linux "$sub")
  if grep -q '^launchctl ' "$TD/calls.log" 2>/dev/null; then
    bad "$sub: 리눅스인데 launchctl 호출"
  elif grep -q '^systemctl ' "$TD/calls.log" 2>/dev/null; then
    ok "$sub: systemctl 로 분기"
  else
    bad "$sub: 서비스 관리자 호출 0 — 분기 없이 빠져나갔다(무동작)"
  fi
done

# ── P9: status.sh 가 launchctl 을 직접 부르지 않는다 ──────────────────
# status.sh:114 는 mac 에서만 참인 관측이다. 리눅스에선 워치독이 돌고 있어도
# "미설치 — 사람이 가야 한다" 로 **거짓 경보**를 낸다(운영자가 신호를 못 믿게 되는 게 진짜 비용).
head_ P9 "status.sh — 워치독 관측이 OS 중립"
n=$(grep -cE '(^|[^_[:alnum:]])launchctl ' "$STATUS" 2>/dev/null | tr -d ' ')
[ "${n:-1}" = "0" ] && ok "status.sh 내 직접 launchctl 0건" \
  || bad "status.sh 가 launchctl 을 직접 호출 $n 건 — 리눅스에서 거짓 경보"
grep -q 'watchdog_installed' "$STATUS" 2>/dev/null \
  && ok "portable.sh 의 watchdog_installed 사용" || bad "OS 중립 헬퍼(watchdog_installed) 미사용"

# ── P10: watchdog_installed 자체가 두 OS 에서 동작 ────────────────────
head_ P10 "watchdog_installed 헬퍼 분기"
: > "$TD/calls.log"
PATH="$STUB:$PATH" HMB_FORCE_OS=linux bash -c '. infra/lib/portable.sh; watchdog_installed' >/dev/null 2>&1
grep -q '^systemctl ' "$TD/calls.log" 2>/dev/null \
  && ok "linux → systemctl 조회" || bad "linux 분기가 systemctl 을 안 쓴다"
: > "$TD/calls.log"
PATH="$STUB:$PATH" HMB_FORCE_OS=darwin bash -c '. infra/lib/portable.sh; watchdog_installed' >/dev/null 2>&1
grep -q '^launchctl ' "$TD/calls.log" 2>/dev/null \
  && ok "darwin → launchctl 조회" || bad "darwin 분기가 launchctl 을 안 쓴다"

# ── P11: 실제 시스템 무접촉 (라이브 머신 안전) ────────────────────────
# 이 테스트가 라이브 워치독을 건드렸다면 그 자체가 사고다.
head_ P11 "라이브 시스템 무접촉"
if [ -d "$HOME/Library/LaunchAgents" ] || [ -d "$HOME/.config/systemd/user" ]; then
  # 테스트가 만든 것은 전부 $TD 밑이어야 한다.
  [ ! -e "$TD/home/../../Library" ] && ok "샌드박스 HOME 밖 생성물 없음" || bad "샌드박스를 벗어났다"
else
  ok "검사 대상 디렉토리 없음(무해)"
fi

printf '\n=== 결과: PASS=%d FAIL=%d ===\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ]
