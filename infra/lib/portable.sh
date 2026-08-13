#!/usr/bin/env bash
# infra 스크립트 OS 이식 계층 (#472 W1 / AC1.1)
#
# 왜 있나: 이 리포의 infra 스크립트는 mac 에서만 돌아 본 적이 있어서, 이사 대상 머신(리눅스)에
# 그대로 올리면 **조용히 어긋난다**. 실측된 두 부류:
#   1. `sed -i ''`  — BSD 전용. GNU sed 는 `-i` 가 접미사를 **붙여쓰기**로만 받으므로 ''(빈 인자)를
#      스크립트로 읽어 첫 표현식을 삼킨다 → 치환이 안 된 채 성공처럼 보이거나 파싱 에러.
#   2. `/Users/...` 경로 전제 — 리눅스 체크아웃(/home·/opt·/srv)에서 관측이 **빈값**이 되고,
#      status.sh 는 "executor 어디서 도는지 모름"으로 조용히 퇴화한다.
#
# 사용: 스크립트가 리포 루트로 cd 한 뒤
#         . "$(git rev-parse --show-toplevel)/infra/lib/portable.sh"
#       또는 루트에 있는 상태에서  . infra/lib/portable.sh
#
# 이 파일은 **source 전용**이다(실행 진입점 없음). set -e 를 켜지 않는다 — 호출자의 옵션을 존중.

# ── os_kind: darwin | linux | other ───────────────────────────────────
# ⚠️ `HMB_FORCE_OS` 오버라이드가 있는 이유: 이식 계약을 **한 머신에서 두 분기 다** 검정하기
#    위해서다. 없으면 리눅스 분기는 리눅스에서만 검증되고 = 이사 당일까지 아무도 안 돌린다.
#    (AC1.1 의 `HMB_SED_INPLACE` 와 같은 관용구.) 운영 경로는 이 변수를 세팅하지 않는다.
os_kind() {
  case "${HMB_FORCE_OS:-}" in
    darwin|linux|other) echo "${HMB_FORCE_OS}"; return ;;
  esac
  case "$(uname -s 2>/dev/null)" in
    Darwin) echo darwin ;;
    Linux)  echo linux ;;
    *)      echo other ;;
  esac
}
is_macos() { [ "$(os_kind)" = darwin ]; }
is_linux() { [ "$(os_kind)" = linux ]; }

# ── sed 제자리 치환 모드 판정 ─────────────────────────────────────────
# ⚠️ `sed --version` 문자열이 아니라 **실제 동작**으로 판정한다. busybox sed 는 GNU 처럼 `-i` 를
#    인자 없이 받지만 --version 은 GNU 형식이 아니라, 문자열 판정은 busybox 를 BSD 로 오분류한다.
_hmb_sed_probe() {
  local d t out
  d=$(mktemp -d) || { echo bsd; return; }
  t="$d/probe"
  printf 'x\n' > "$t"
  if sed -i 's/x/y/' "$t" >/dev/null 2>&1; then
    out=$(cat "$t" 2>/dev/null)
    [ "$out" = "y" ] && echo gnu || echo bsd
  else
    echo bsd
  fi
  rm -rf "$d"
}
HMB_SED_INPLACE="${HMB_SED_INPLACE:-$(_hmb_sed_probe)}"
export HMB_SED_INPLACE

# sed_i EXPR FILE...  — 제자리 치환. 백업 파일을 남기지 않는다.
#   BSD:  sed -i '' EXPR FILE     GNU/busybox:  sed -i EXPR FILE
sed_i() {
  if [ "$HMB_SED_INPLACE" = gnu ]; then
    sed -i "$@"
  else
    sed -i '' "$@"
  fi
}

# ── 체크아웃 경로 추출 ────────────────────────────────────────────────
# stdin(ps 출력 등)에서 `<어딘가>/hmb-online` 을 뽑는다. 홈 규약(/Users vs /home vs /opt)에
# 묶이지 않는다 — 이사 후에도 같은 관측이 나와야 하므로 접두사를 전제하지 않는다.
#   입력: `node /home/ubuntu/hmb/hmb-online/packages/server/dist/executor-main.js`
#   출력: `/home/ubuntu/hmb/hmb-online`
checkout_from_cmdline() {
  grep -oE '(/[^ ]*)?/hmb-online' 2>/dev/null | head -1
}

# ── 자가복구 워치독(#183) 의 OS 중립 관측 ─────────────────────────────
# 서비스 관리자는 OS 마다 다르지만, 부르는 쪽(status.sh·install 스크립트)이 알아야 할 것은
# **"워치독이 가동 중인가"** 하나뿐이다. 그 한 질문만 여기서 흡수한다.
#   mac  : launchd  gui/<uid>/online.hmb.tunnel-heal
#   linux: systemd user timer  hmb-tunnel-heal.timer
# ⚠️ status.sh 가 launchctl 을 직접 부르면 리눅스에서 **거짓 경보**("미설치 — 사람이 가야 한다")를
#    낸다. 워치독이 멀쩡히 도는데도. 운영자가 신호를 못 믿게 되는 것이 진짜 비용이다.
HMB_HEAL_LABEL="${HMB_HEAL_LABEL:-online.hmb.tunnel-heal}"   # launchd 라벨
HMB_HEAL_UNIT="${HMB_HEAL_UNIT:-hmb-tunnel-heal}"            # systemd 유닛 basename

watchdog_installed() {
  if is_linux; then
    systemctl --user is-enabled "${HMB_HEAL_UNIT}.timer" >/dev/null 2>&1
  else
    launchctl print "gui/$(id -u)/${HMB_HEAL_LABEL}" >/dev/null 2>&1
  fi
}

# 워치독의 **마지막 종료코드** — 서비스 관리자마다 출처가 다르다(#497 에서 78/EX_CONFIG 을 읽어야 했다).
# 관측을 여기 두는 이유는 `watchdog_installed` 와 같다: 소비자(status.sh)가 launchctl 을 직접 부르면
# 리눅스에서 항상 빈 값이 되어 이사 후 그 게이트가 조용히 죽는다.
watchdog_last_exit() {
  if is_linux; then
    systemctl --user show "${HMB_HEAL_UNIT}.service" -p ExecMainStatus --value 2>/dev/null
  else
    launchctl print "gui/$(id -u)/${HMB_HEAL_LABEL}" 2>/dev/null \
      | awk -F'= *' '/last exit code|LastExitStatus/{print $2; exit}' | tr -d ' '
  fi
}
