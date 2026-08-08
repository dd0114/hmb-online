#!/usr/bin/env bash
# AC1.4 계약 — 이송 팩 pack-move.sh / unpack-move.sh (#472 W1, tier:H)
#
# 왜 이 파일이 있나: 이사에서 **실제로 잃어버리는 것은 코드가 아니라 리포 밖 상태**다.
# #472 조사(첫 코멘트 §B/§C)가 센 것만 6종이고, 하나하나가 무음 장애로 이어진다:
#   1. `infra/.env`                     — 없으면 java 가 안 뜬다(SERVANT_TOKEN·admin 짝)
#   2. `~/.config/hmb/deploy.env`       — CF 토큰. 없으면 라우터 스왑(web 재배포)이 안 된다
#   3. `~/.cache/hmb/dist-current*`     — 마지막 성공 배포 스냅샷. 없으면 publish-backend-url 이
#                                          exit 2 로 죽어 **터널 URL 을 바꿔도 반영이 안 된다**.
#                                          `.functions` 가 없으면 재배포가 OG Function 을 **삭제**한다(#299)
#   4. `~/.local/state/hmb/`            — deploy.lock(배포↔워치독 직렬화)·admin-pw·heal 상태
#   5. `~/.claude`                      — 모드 A 구독 세션(AI 가 산다)
#   6. `economy.override.json`          — **DB 볼륨 안**에 있다. 플레이북 자산 tar(:620-621)가
#                                          `notice-assets char-bundles` 만 잡아 이게 빠진다.
#                                          빠지면 initialGems 12000 운영조정이 소멸하고 구운 값으로 돌아간다.
#
# 사람이 목록을 손으로 옮기는 방식은 이미 실패했다 — 플레이북이 6종 중 하나(economy)를
# 빠뜨린 채 운영돼 왔다. 그래서 **목록을 기계가 들고, 빠지면 멈춘다.**
#
# ⚠️ 이 팩은 **시크릿 덩어리**다(토큰·admin 평문·구독 세션). 그래서 계약이 세 가지를 같이 문다:
#   - 값이 출력에 실리지 않는다(카나리아)
#   - 산출물 권한 600
#   - 기본 출력 경로가 **리포 밖**이고, 리포 안으로 쓰라면 거부한다(실수 커밋 차단)
#
# 실행: bash infra/tests/move-pack.test.sh
# 판정: exit code. 실패 1건이라도 있으면 exit 1.
# ⚠️ 실 도커·실 HOME 무접촉 — HOME 샌드박스 + docker PATH 스텁으로만 돈다.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ✓ %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  ✗ %s\n' "$1"; }
head_(){ printf '\n[%s] %s\n' "$1" "$2"; }

PACK=infra/pack-move.sh
UNPACK=infra/unpack-move.sh
CANARY='c4n4ry-m0ve-do-not-print-7q6w5e'

TD=$(mktemp -d); trap 'rm -rf "$TD"' EXIT
STUB="$TD/bin"; mkdir -p "$STUB"

# ── docker 스텁 ────────────────────────────────────────────────────────
# 실 볼륨(hmb-p3-db, 659MB 라이브 DB)을 절대 건드리지 않는다. `docker run` 호출을 기록하고,
# economy.override.json 을 요구하면 $TD/volume 에서 꺼내 준다(있을 때만 — 부재 변이를 위해).
mk_docker(){
  cat > "$STUB/docker" <<EOF
#!/usr/bin/env bash
printf 'docker %s\n' "\$*" >> "$TD/docker.log"
# economy 를 꺼내가는 호출: 있으면 stdout 으로 흘려준다.
if printf '%s' "\$*" | grep -q 'economy.override.json'; then
  [ -f "$TD/volume/economy.override.json" ] || exit 1
  cat "$TD/volume/economy.override.json"
  exit 0
fi
exit 0
EOF
  chmod +x "$STUB/docker"
}
mk_docker

# ── 샌드박스 HOME 을 6종이 다 있는 상태로 만든다 ───────────────────────
mk_home(){ # <dir>
  local h="$1"; rm -rf "$h"
  mkdir -p "$h/.config/hmb" "$h/.cache/hmb/dist-current" "$h/.cache/hmb/dist-current.functions" \
           "$h/.local/state/hmb" "$h/.claude/projects"
  printf 'CLOUDFLARE_API_TOKEN=%s\nCLOUDFLARE_ACCOUNT_ID=%s\n' "$CANARY" "acct" > "$h/.config/hmb/deploy.env"
  chmod 600 "$h/.config/hmb/deploy.env"
  printf '<html>dist</html>\n' > "$h/.cache/hmb/dist-current/index.html"
  printf 'og function\n'       > "$h/.cache/hmb/dist-current.functions/og.js"
  printf 'backend=https://x\n' > "$h/.cache/hmb/dist-current.meta"
  printf '%s\n' "$CANARY"      > "$h/.local/state/hmb/admin-pw-v8.txt"
  chmod 600 "$h/.local/state/hmb/admin-pw-v8.txt"
  printf 'lock\n'              > "$h/.local/state/hmb/deploy.lock"
  printf 'session\n'           > "$h/.claude/projects/p.jsonl"
}
mk_home "$TD/home"
mkdir -p "$TD/volume"; printf '{"initialGems":12000}\n' > "$TD/volume/economy.override.json"

# infra/.env 는 **리포 안**이다. 라이브 파일을 건드리지 않도록 별도 경로를 주입한다.
printf 'SERVANT_TOKEN=%s\nHMB_ADMIN_NICKNAME=a\nHMB_ADMIN_PASSWORD=%s\n' "$CANARY" "$CANARY" > "$TD/dotenv"
chmod 600 "$TD/dotenv"

# pack 실행 헬퍼.  run_pack <추가인자...>
run_pack(){
  : > "$TD/docker.log"
  HOME="$TD/home" PATH="$STUB:$PATH" HMB_ENV_FILE="$TD/dotenv" \
    bash "$PACK" "$@" > "$TD/pack.out" 2>&1
  echo $?
}

printf '=== AC1.4 이송 팩 ===\n'

# ── Q0: 존재·문법 ─────────────────────────────────────────────────────
head_ Q0 "스크립트 존재·문법"
for f in "$PACK" "$UNPACK"; do
  if [ -f "$f" ]; then
    bash -n "$f" 2>"$TD/syn" && ok "$(basename "$f"): syntax ok" || bad "$(basename "$f"): $(cat "$TD/syn")"
  else bad "$f 없음"; fi
done

# ── Q1: --dry-run 이 6종을 **전부** 이름으로 보고한다 ──────────────────
head_ Q1 "--dry-run 이 이송 목록 6종 전부 보고"
rc=$(run_pack --dry-run)
[ "$rc" = "0" ] && ok "전부 존재 → exit 0" || bad "exit $rc (전부 있는데 실패): $(tail -3 "$TD/pack.out" | tr '\n' ' ')"
for pat in 'infra/.env' 'deploy.env' 'dist-current' 'dist-current.functions' \
           'dist-current.meta' 'state/hmb' '.claude' 'economy.override.json'; do
  grep -qF "$pat" "$TD/pack.out" && ok "목록에 $pat" || bad "목록에 $pat 없음"
done

# ── Q2: 누락 fail-fast — 6종 각각을 빼면 멈추고 **이름을 댄다** ─────────
# AC 의 핵심. 하나라도 조용히 넘어가면 그게 이사 사고다.
head_ Q2 "누락 fail-fast (6종 각각)"
drop_and_check(){ # <라벨> <제거 명령> <출력에 있어야 할 문자열>
  mk_home "$TD/home"; printf '{"initialGems":12000}\n' > "$TD/volume/economy.override.json"
  eval "$2"
  rc=$(run_pack --dry-run)
  if [ "$rc" = "0" ]; then
    bad "$1 누락인데 exit 0 — 조용히 빠진다(=이사 사고)"
  else
    grep -qF "$3" "$TD/pack.out" && ok "$1 누락 → exit $rc + 이름 지목" \
      || bad "$1 누락 → exit $rc 이나 어떤 항목인지 안 알려줌"
  fi
}
drop_and_check "infra/.env"        'rm -f "$TD/dotenv"'                                  'infra/.env'
printf 'SERVANT_TOKEN=%s\n' "$CANARY" > "$TD/dotenv"; chmod 600 "$TD/dotenv"
drop_and_check "deploy.env"        'rm -f "$TD/home/.config/hmb/deploy.env"'             'deploy.env'
drop_and_check "dist-current"      'rm -rf "$TD/home/.cache/hmb/dist-current"'           'dist-current'
drop_and_check "dist-current.functions" 'rm -rf "$TD/home/.cache/hmb/dist-current.functions"' 'dist-current.functions'
drop_and_check "state/hmb"         'rm -rf "$TD/home/.local/state/hmb"'                  'state/hmb'
drop_and_check "~/.claude"         'rm -rf "$TD/home/.claude"'                           '.claude'
# ⚠️ economy 는 AC 가 이름을 박아 요구한 변이다(플레이북이 실제로 빠뜨렸던 항목).
drop_and_check "economy.override.json" 'rm -f "$TD/volume/economy.override.json"'        'economy.override.json'

# 원상복구
mk_home "$TD/home"; printf '{"initialGems":12000}\n' > "$TD/volume/economy.override.json"
printf 'SERVANT_TOKEN=%s\nHMB_ADMIN_NICKNAME=a\nHMB_ADMIN_PASSWORD=%s\n' "$CANARY" "$CANARY" > "$TD/dotenv"
chmod 600 "$TD/dotenv"

# ── Q3: --no-claude 는 **기록되는** 선택이다(조용한 누락과 구분) ────────
# EC2 AI 모드는 hero 게이트다 — 구독 세션을 안 옮기는 선택이 있을 수 있고, 그건 사고가 아니다.
# 다만 **조용하면** 사고와 구분이 안 된다. 그래서 매니페스트에 남는다.
head_ Q3 "--no-claude = 기록되는 의도적 제외"
rm -rf "$TD/home/.claude"
rc=$(run_pack --dry-run --no-claude)
[ "$rc" = "0" ] && ok "명시 제외 시 통과" || bad "exit $rc — 명시 제외인데 막는다"
grep -qi 'claude' "$TD/pack.out" && ok "제외 사실을 출력에 남김" || bad "제외가 조용하다"
mk_home "$TD/home"

# ── Q4: 실제 팩 산출 — tar + 매니페스트 shasum ─────────────────────────
head_ Q4 "팩 산출물 · 매니페스트 shasum"
OUT="$TD/out/move.tar.gz"; mkdir -p "$TD/out"
rc=$(run_pack --out "$OUT")
[ "$rc" = "0" ] && ok "팩 exit 0" || bad "팩 exit $rc: $(tail -5 "$TD/pack.out" | tr '\n' ' ')"
[ -f "$OUT" ] && ok "tar 생성" || bad "tar 없음 ($OUT)"
# ⚠️ docker 호출 기록은 **이 실행의 것**을 따로 보관한다. run_pack 은 매번 로그를 비우므로,
#    뒤에 오는 케이스(Q6 리포경로 거부는 docker 에 닿기 전에 종료)를 보면 항상 0 건이 나온다.
cp -f "$TD/docker.log" "$TD/docker.pack.log" 2>/dev/null || : > "$TD/docker.pack.log"
MAN="$OUT.manifest"
if [ -f "$MAN" ]; then
  ok "매니페스트 생성"
  # 매니페스트에 항목별 shasum(64자 hex)이 있어야 한다.
  n=$(grep -cE '^[0-9a-f]{64} ' "$MAN" 2>/dev/null | tr -d ' ')
  [ "${n:-0}" -ge 6 ] && ok "shasum 항목 $n 개(≥6)" || bad "shasum 항목 $n 개 — 6종 무결성 확인 불가"
  grep -qF 'economy.override.json' "$MAN" && ok "매니페스트에 economy 포함" || bad "매니페스트에 economy 없음"
else bad "매니페스트 없음 ($MAN)"; bad "(동)"; bad "(동)"; fi

# ── Q5: 시크릿 비노출 ─────────────────────────────────────────────────
head_ Q5 "시크릿 비노출(카나리아) · 권한 600"
grep -q "$CANARY" "$TD/pack.out" \
  && bad "출력에 시크릿 값이 실렸다 — 이 로그는 이슈·터미널로 흘러간다" \
  || ok "카나리아 값 출력 0건"
if [ -f "$OUT" ]; then
  p=$(ls -l "$OUT" | cut -c1-10)
  case "$p" in -rw-------) ok "산출물 권한 600";; *) bad "산출물 권한 $p — 시크릿 덩어리인데 타 사용자 접근 가능";; esac
fi

# ── Q6: 리포 안으로 쓰기 거부(실수 커밋 차단) ──────────────────────────
head_ Q6 "리포 내부 출력 거부"
rc=$(run_pack --out "$ROOT/move-oops.tar.gz")
[ "$rc" != "0" ] && ok "리포 안 경로 거부(exit $rc)" || bad "리포 안에 시크릿 팩을 만들었다 — 실수 커밋 경로"
[ -f "$ROOT/move-oops.tar.gz" ] && { bad "리포에 파일이 실제로 생성됨"; rm -f "$ROOT/move-oops.tar.gz"; } \
  || ok "리포에 파일 미생성"

# ── Q7: 라이브 볼륨은 read-only 로만 만진다 ────────────────────────────
head_ Q7 "DB 볼륨 read-only 접근"
if [ -s "$TD/docker.pack.log" ]; then
  grep -q 'hmb-p3-db' "$TD/docker.pack.log" && ok "볼륨 접근 시도 기록됨" || bad "볼륨을 안 읽었다 — economy 를 어디서 가져왔나"
  if grep 'hmb-p3-db' "$TD/docker.pack.log" | grep -qv ':ro'; then
    bad "볼륨을 쓰기 가능하게 마운트 — 라이브 DB 659MB 를 건드릴 수 있다"
  else ok "전부 :ro 마운트"; fi
else bad "docker 호출 기록 0 — 볼륨 안 항목을 어떻게 팩했나"; fi

# ── Q8: 왕복 — unpack 이 원본을 복원한다 ───────────────────────────────
head_ Q8 "pack → unpack 왕복 동일성"
NEW="$TD/newhome"; rm -rf "$NEW"; mkdir -p "$NEW"
if [ -f "$OUT" ]; then
  HOME="$NEW" PATH="$STUB:$PATH" HMB_ENV_FILE="$TD/newdotenv" \
    bash "$UNPACK" --in "$OUT" > "$TD/unpack.out" 2>&1; rc=$?
  [ "$rc" = "0" ] && ok "unpack exit 0" || bad "unpack exit $rc: $(tail -5 "$TD/unpack.out" | tr '\n' ' ')"
  for f in .config/hmb/deploy.env .cache/hmb/dist-current/index.html \
           .cache/hmb/dist-current.functions/og.js .cache/hmb/dist-current.meta \
           .local/state/hmb/admin-pw-v8.txt .claude/projects/p.jsonl; do
    if [ -f "$NEW/$f" ]; then
      a=$(shasum -a 256 "$TD/home/$f" 2>/dev/null | awk '{print $1}')
      b=$(shasum -a 256 "$NEW/$f"     2>/dev/null | awk '{print $1}')
      [ -n "$a" ] && [ "$a" = "$b" ] && ok "복원 일치: $f" || bad "복원 내용 불일치: $f"
    else bad "복원 누락: $f"; fi
  done
  # 시크릿 파일 권한이 살아야 한다(600 → 644 로 풀리면 그 자체가 유출 경로).
  if [ -f "$NEW/.local/state/hmb/admin-pw-v8.txt" ]; then
    p=$(ls -l "$NEW/.local/state/hmb/admin-pw-v8.txt" | cut -c1-10)
    case "$p" in -rw-------) ok "admin-pw 권한 600 보존";; *) bad "admin-pw 권한 $p — 복원이 권한을 풀었다";; esac
  fi
  grep -q "$CANARY" "$TD/unpack.out" && bad "unpack 출력에 시크릿 값" || ok "unpack 카나리아 0건"
else
  for _ in 1 2 3 4 5 6 7 8 9; do bad "팩이 없어 왕복 검정 불가"; done
fi

# ── Q9: 매니페스트 변조 감지 — **쓰기 전에** 멈춘다 ────────────────────
# 이사 중 tar 가 깨지는 것보다 나쁜 것은 **깨진 줄 모르고 절반만 복원되는 것**이다.
head_ Q9 "변조 감지 · 부분복원 방지"
if [ -f "$OUT" ]; then
  cp "$OUT" "$TD/tampered.tar.gz"; cp "$MAN" "$TD/tampered.tar.gz.manifest"
  # ⚠️ 매니페스트 **첫 줄은 주석**(# hmb …)이다. NR==1 을 노리면 변조가 한 글자도 안 일어나고
  #    "변조를 통과시켰다" 라는 거짓 red 가 난다. 첫 **해시 줄**을 골라 한 글자를 바꾼다.
  awk 'done!=1 && /^[0-9a-f]{64} /{sub(/^./,"0"); done=1}1' \
      "$TD/tampered.tar.gz.manifest" > "$TD/t.m" && mv "$TD/t.m" "$TD/tampered.tar.gz.manifest"
  grep -qE '^0[0-9a-f]{63} ' "$TD/tampered.tar.gz.manifest" \
    && ok "변조 주입 확인(계약 자체가 유효)" || bad "변조가 주입되지 않았다 — 이 케이스는 무의미하다"
  T2="$TD/tamperhome"; rm -rf "$T2"; mkdir -p "$T2"
  HOME="$T2" PATH="$STUB:$PATH" bash "$UNPACK" --in "$TD/tampered.tar.gz" > "$TD/tamper.out" 2>&1; rc=$?
  [ "$rc" != "0" ] && ok "변조 매니페스트 거부(exit $rc)" || bad "변조를 통과시켰다"
  n=$(find "$T2" -type f 2>/dev/null | wc -l | tr -d ' ')
  [ "${n:-1}" = "0" ] && ok "거부 시 아무것도 안 썼다(부분복원 0)" \
    || bad "거부했는데 파일 $n 개를 이미 썼다 — 절반만 복원된 상태가 남는다"
fi

# ── Q10: 덮어쓰기 보호 ────────────────────────────────────────────────
head_ Q10 "기존 파일 덮어쓰기 보호"
if [ -f "$OUT" ]; then
  HOME="$NEW" PATH="$STUB:$PATH" bash "$UNPACK" --in "$OUT" > "$TD/over.out" 2>&1; rc=$?
  [ "$rc" != "0" ] && ok "이미 있는 HOME 에 무조건 덮어쓰지 않음(exit $rc)" \
    || bad "말없이 덮어썼다 — 새 머신에 이미 상태가 있으면 날아간다"
  HOME="$NEW" PATH="$STUB:$PATH" bash "$UNPACK" --in "$OUT" --force > "$TD/over2.out" 2>&1; rc=$?
  [ "$rc" = "0" ] && ok "--force 로는 진행" || bad "--force 도 막힌다(exit $rc)"
fi

# ── Q11: 라이브 무접촉 ────────────────────────────────────────────────
head_ Q11 "실 HOME · 실 도커 무접촉"
[ ! -e "$HOME/hmb-move" ] && ok "실 HOME 에 산출물 없음" || bad "실 HOME 을 건드렸다"
grep -q 'docker' "$TD/docker.log" 2>/dev/null && ok "docker 호출은 전부 스텁 경유" || ok "docker 미호출"

# ── Q12: db-backups 기본 제외 — 그러나 **조용하지 않게** ───────────────
# 실측(라이브): `~/.local/state/hmb` 8.9GB 중 8.9GB 가 db-backups/(66개)다. 다 싸면 이송이
# 13GB 가 되고 그 전송이 **정지 창 안에** 들어간다. 그런데 이 백업은 이사에 필요 없다 —
# DB 본체는 런북 P2 의 `.backup` 으로 가고, 과거 백업은 **구 머신에 남는다**(롤백 자산은 거기 있다).
# 다만 "용량이 커서 뺐다" 가 조용하면 나중에 아무도 그 사실을 모른다 → 출력·매니페스트에 남긴다.
head_ Q12 "db-backups 기본 제외(기록되는 제외)"
mk_home "$TD/home"
mkdir -p "$TD/home/.local/state/hmb/db-backups"
head -c 200000 /dev/zero > "$TD/home/.local/state/hmb/db-backups/old.db" 2>/dev/null
OUT2="$TD/out/move2.tar.gz"
rc=$(run_pack --out "$OUT2")
[ "$rc" = "0" ] && ok "팩 exit 0" || bad "팩 exit $rc"
grep -qi 'db-backups' "$TD/pack.out" && ok "제외 사실을 출력에 알림" || bad "조용히 뺐다 — 나중에 아무도 모른다"
if [ -f "$OUT2.manifest" ]; then
  grep -q 'excluded:.*db-backups' "$OUT2.manifest" && ok "매니페스트에 제외 기록" || bad "매니페스트에 제외 기록 없음"
  grep -q 'db-backups/old.db' "$OUT2.manifest" && bad "제외한다면서 실제로는 쌌다" || ok "실제로 팩에 미포함"
else bad "매니페스트 없음"; bad "(동)"; bad "(동)"; fi
# 반대 방향: --with-db-backups 면 들어와야 한다(제외가 강제이면 그건 자산 유실 경로다).
rc=$(run_pack --out "$TD/out/move3.tar.gz" --with-db-backups)
if [ -f "$TD/out/move3.tar.gz.manifest" ]; then
  grep -q 'db-backups/old.db' "$TD/out/move3.tar.gz.manifest" \
    && ok "--with-db-backups 로는 포함" || bad "--with-db-backups 인데도 빠진다"
else bad "--with-db-backups 팩 실패(exit $rc)"; fi

printf '\n=== 결과: PASS=%d FAIL=%d ===\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ]
