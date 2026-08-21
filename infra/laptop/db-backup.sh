#!/usr/bin/env bash
# HMB 라이브 DB 정기 백업 (#489) — 랩탑(WSL2 Ubuntu) 이사 후 신설.
#
#   bash db-backup.sh            # 1회 백업 + 세대 정리
#   bash db-backup.sh --status   # 세대 목록·용량·마지막 결과
#
# ── 왜 이게 있나 ────────────────────────────────────────────────────────────
# 이사(#489) 직후 랩탑엔 **DB 백업이 하나도 없었다**(crontab 0 · timer 는 tunnel-heal 뿐).
# 맥의 `~/.local/state/hmb/db-backups/`(8.9GB · 66개)는 정기 잡이 아니라 **배포 전 수동**
# 백업이 쌓인 것이라(`pre-v496-…`) 이식할 잡 자체가 없었다. 그래서 새로 만든다.
#
# ── 런북 P2-12 가 가르쳐 준 함정 두 개를 여기서 구조로 막는다 ───────────────
# ① **ro 마운트 금지.** `-v …:ro` + `mode=ro` 는 WAL 의 `-shm` 을 만들 수 없어
#    `unable to open database file` 로 죽는다. 라이브 중에는 java 가 만들어 둔 `-shm` 이
#    있어 통과하고 **정지 상태에서만** 실패하므로, 리허설에서 안 잡힌다. → rw 로 연다.
# ② **검증은 "방금 만든 파일"에만 한다.** 실이사 때 백업이 실패했는데 직전 백업 파일이
#    남아 있어서 `integrity_check`·`shasum` 이 **옛 파일에** 통과했다 = 무음 실패.
#    → 인플라이트 이름으로 쓰고 · 그 파일을 검증하고 · 통과해야만 최종 이름으로 승격한다.
#    실패하면 인플라이트를 지우고 **0 이 아닌 코드로 죽는다**(조용히 넘어가지 않는다).
# ③ **`integrity_check = ok` 는 "백업이 됐다"는 뜻이 아니다.** sqlite3 는 없는 파일을 열면
#    **빈 DB 를 만든다** — 그래서 소스 경로가 틀려도 `.backup` 이 성공하고, 4096바이트짜리
#    빈 DB 가 `ok` 를 받아 정상 세대로 승격된다(설치 당일 실패경로 검증에서 실제로 재현했다:
#    `HMB_DB_FILE=nope.db` → exit 0 · 세대 1→2 · 4096 bytes · integrity=ok). 무결성은 파일이
#    **온전한가**만 보지 **무엇인가**는 안 본다. → 소스를 먼저 확인하고, 결과물의 **테이블 수와
#    크기**를 소스와 대조한다.
#
# ⚠️ `.backup` 은 sqlite **온라인 백업 API** 라 스택을 세우지 않아도 정합하다. 파일을 그냥
#    cp 하면 WAL 이 살아 있는 채로 복사돼 조용히 어긋난다 — 그래서 cp 를 쓰지 않는다.
set -uo pipefail

VOL="${HMB_DB_VOLUME:-hmb-p3-db}"
DB="${HMB_DB_FILE:-hmb.db}"
DEST="${HMB_BACKUP_DIR:-/var/backups/hmb}"
KEEP="${HMB_BACKUP_KEEP:-7}"
IMG="${HMB_SQLITE_IMG:-hmb/sqlite3:local}"
LOG="${HMB_BACKUP_LOG:-/var/log/hmb/db-backup.log}"
BUSY_MS="${HMB_BACKUP_BUSY_MS:-30000}"
# 결과물이 소스 대비 이 비율보다 작으면 실패로 본다(절단·빈 DB 방어).
MIN_RATIO_PCT="${HMB_BACKUP_MIN_RATIO_PCT:-50}"
# 스키마가 이보다 적으면 실패로 본다(빈 DB 는 0 이다). 라이브 실측 61.
MIN_TABLES="${HMB_BACKUP_MIN_TABLES:-10}"

mkdir -p "$DEST" "$(dirname "$LOG")" 2>/dev/null

log(){ printf '%s\t%s\t%s\n' "$(date +%s)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; \
       printf '[db-backup] %s\n' "$*" >&2; }

if [ "${1:-}" = "--status" ]; then
  echo "== 세대 ($DEST) =="
  ls -lht "$DEST"/hmb-*.db 2>/dev/null | head -n $((KEEP + 2)) || echo "(백업 없음)"
  echo "== 합계 =="; du -sh "$DEST" 2>/dev/null || true
  echo "== 최근 로그 =="; tail -n 5 "$LOG" 2>/dev/null || echo "(로그 없음)"
  exit 0
fi

command -v docker >/dev/null 2>&1 || { log "FAIL	reason=no_docker"; exit 1; }
docker image inspect "$IMG" >/dev/null 2>&1 || { log "FAIL	reason=no_image	img=$IMG (install-db-backup.sh 가 만든다)"; exit 1; }

# ⚠️ 보관본을 sqlite 로 **열면**(무결성 검증·수동 조회) `-shm`/`-wal` 사이드카가 생긴다.
#    깨끗이 닫히면 sqlite 가 지우지만 컨테이너가 중간에 죽으면 남고, 세대 정리 글롭
#    (`hmb-*.db`)엔 안 걸려 영원히 고아로 남는다. 보관본은 아무도 붙들고 있지 않으므로
#    매 실행 앞에서 쓸어낸다.
rm -f "$DEST"/*.db-shm "$DEST"/*.db-wal 2>/dev/null

# ── ⓪ 소스 사전 확인 — 없는 파일을 열면 sqlite 가 **빈 DB 를 만든다**(위 주석 ③) ──────
SRC_BYTES="$(docker run --rm -v "$VOL":/data "$IMG" \
               sh -c "[ -f /data/$DB ] && stat -c%s /data/$DB" 2>/dev/null | tr -dc 0-9)"
if [ -z "$SRC_BYTES" ] || [ "$SRC_BYTES" -lt 4097 ]; then
  log "FAIL	reason=source_missing_or_empty	vol=$VOL	db=$DB	bytes=${SRC_BYTES:-<none>}"
  exit 1
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TMP="inflight-$STAMP.db"
FINAL="hmb-$STAMP.db"
START="$(date +%s)"

# ── ① 백업 (rw 마운트 — 위 주석 ① 참조) ─────────────────────────────────────
if ! docker run --rm -v "$VOL":/data -v "$DEST":/out "$IMG" \
        sqlite3 -cmd ".timeout $BUSY_MS" "/data/$DB" ".backup '/out/$TMP'" 2>>"$LOG"; then
  rm -f "$DEST/$TMP"
  log "FAIL	stamp=$STAMP	reason=sqlite_backup"
  exit 1
fi

# ── ② 검증 — **방금 만든 파일에만** (위 주석 ② 참조) ────────────────────────
if [ ! -s "$DEST/$TMP" ]; then
  rm -f "$DEST/$TMP"
  log "FAIL	stamp=$STAMP	reason=empty_or_missing"
  exit 1
fi
IC="$(docker run --rm -v "$DEST":/out "$IMG" sqlite3 "/out/$TMP" 'PRAGMA integrity_check;' 2>>"$LOG" | head -1)"
if [ "$IC" != "ok" ]; then
  rm -f "$DEST/$TMP"
  log "FAIL	stamp=$STAMP	reason=integrity	got=${IC:-<empty>}"
  exit 1
fi

# ⚠️ `ok` 만으로는 부족하다 — 빈 DB 도 `ok` 다(위 주석 ③). **무엇인가**를 확인한다.
NT="$(docker run --rm -v "$DEST":/out "$IMG" sqlite3 "/out/$TMP" \
        "select count(*) from sqlite_master where type='table';" 2>>"$LOG" | tr -dc 0-9)"
if [ -z "$NT" ] || [ "$NT" -lt "$MIN_TABLES" ]; then
  rm -f "$DEST/$TMP"
  log "FAIL	stamp=$STAMP	reason=schema_too_small	tables=${NT:-<none>}	min=$MIN_TABLES"
  exit 1
fi
OUT_BYTES="$(stat -c%s "$DEST/$TMP" 2>/dev/null | tr -dc 0-9)"
if [ -z "$OUT_BYTES" ] || [ "$(( OUT_BYTES * 100 / SRC_BYTES ))" -lt "$MIN_RATIO_PCT" ]; then
  rm -f "$DEST/$TMP"
  log "FAIL	stamp=$STAMP	reason=too_small	bytes=${OUT_BYTES:-0}	src=$SRC_BYTES	min_pct=$MIN_RATIO_PCT"
  exit 1
fi

# ── ③ 원자적 승격 (같은 파일시스템이라 mv 는 rename) ────────────────────────
mv -f "$DEST/$TMP" "$DEST/$FINAL" || { rm -f "$DEST/$TMP"; log "FAIL	stamp=$STAMP	reason=promote"; exit 1; }
SZ="$(stat -c%s "$DEST/$FINAL" 2>/dev/null)"
SUM="$(sha256sum "$DEST/$FINAL" 2>/dev/null | cut -d' ' -f1)"
log "OK	file=$FINAL	tables=$NT	bytes=${SZ:-?}	sha256=${SUM:0:16}	integrity=ok	took=$(( $(date +%s) - START ))s"

# ── ④ 세대 정리 — **성공한 뒤에만** 한다 ────────────────────────────────────
# 실패한 실행이 옛 세대를 지우면, 백업이 깨진 날 보관분까지 같이 잃는다.
ls -1t "$DEST"/hmb-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | while IFS= read -r f; do
  rm -f "$f" "$f-shm" "$f-wal" && log "PRUNE	$(basename "$f")"
done
exit 0
