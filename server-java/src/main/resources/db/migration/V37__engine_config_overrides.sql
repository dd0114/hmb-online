-- #383 라이브 계수 무배포 변경 — 오버레이 원장 + 매치별 config 스냅샷. additive only(V1~V36 무변경).
--
-- 배경: 재현 계약은 (seed + selectData + inputLog + EngineConfig) 인데, 지금까지 네 번째 항은
--   "러너 이미지에 무엇이 구워져 있냐"라는 **저장되지 않는 값**이었다(matches.engine_version 문자열
--   하나가 전부). 계수를 런타임 입력으로 여는 순간 그 구멍이 곧 사고가 되므로, 이 마이그레이션의
--   절반은 기능이고 절반은 그 구멍 메우기다.
--
-- 설계 SoT = docs/plan-v5/live-engine-config.md.

-- ── 오버레이 원장 (append-only) ────────────────────────────────────────────────
--
-- 왜 economy(#209)처럼 override **파일**이 아닌가: economy 의 base 는 이미지에 구워진 발행물이라
--   "리로드"만으로는 같은 바이트를 다시 읽을 뿐이었고, 그래서 볼륨의 파일이 필요했다. 여기 base 는
--   컴파일된 상수이고 오버레이는 순수 서버 상태다 — DB 가 정본이면 이력·멱등·트랜잭션이 따라온다.
--
-- 왜 UPDATE 가 아니라 append-only 인가: matches.config_revision_id 가 리비전을 가리키므로, 행을
--   덮어쓰면 **과거 매치의 근거가 소급으로 바뀐다**. 롤백은 "직전 내용을 새 리비전으로 다시 쓰는 것"
--   이고(그 사실도 원장에 남는다), 기본값 복귀는 overrides_json = '{}' 리비전이다.
--
-- ⚠️ PK 가 `seq`(AUTOINCREMENT)이고 ULID 는 UNIQUE 다 — 보통과 반대다. 이유는 **정렬이 곧 동작**
--    이기 때문이다: 이 표의 "최신 행 하나"가 다음 매치에 박히는 값이라, 동률이 나면 잘못된 계수가
--    남은 채 롤백이 무시된다. 후보 둘 다 동률에서 깨진다 — `created_at` 은 Instant.toString() 이
--    나노초 0 이면 소수부를 생략해 사전순이 뒤집히고(독립검증 m2), **ULID 는 48bit ms + 80bit 난수라
--    같은 밀리초 안에서 난수가 순서를 정한다**(3차 게이트에서 실제로 발화). SQLite `rowid` 로
--    바꿔도 되지만 그건 문서화된 보장이 아니라 구현 세부이고 VACUUM 이 재배치할 수 있다
--    (독립검증 m10) — AUTOINCREMENT 는 **재사용하지 않는 단조 증가**를 스키마가 보장한다.
CREATE TABLE engine_config_revisions (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,   -- 삽입 순서 = "최신 = 현재"의 유일한 기준
  id             TEXT NOT NULL UNIQUE,                -- ULID (매치가 config_revision_id 로 가리킨다)
  overrides_json TEXT NOT NULL,                       -- 정본(키 정렬) 오버레이 **전체 스냅샷**(델타 아님)
  effective_hash TEXT NOT NULL,                       -- 러너가 계산해 준 유효 config 지문
  actor_user_id  TEXT NOT NULL REFERENCES users(id),
  reason         TEXT NOT NULL,                       -- 운영 사유(필수 — "왜 바꿨나"가 없으면 이력이 아니다)
  idem_key       TEXT,
  request_hash   TEXT NOT NULL,                       -- 요청 원문 해시 = 멱등 판정의 **유일** 기준
  created_at     TEXT NOT NULL
);

-- 멱등 백스톱. 앱의 check-then-act 는 경합을 못 막는다(V6·V14 가 같은 교훈을 남겼다) —
-- 같은 키 동시 PUT 이 리비전을 둘 만들면 "현재 값"이 어느 쪽인지 경합 결과에 달리게 된다.
CREATE UNIQUE INDEX uq_engine_config_rev_idem ON engine_config_revisions(idem_key)
  WHERE idem_key IS NOT NULL;

-- ⚠️ `(created_at DESC, id DESC)` 인덱스를 두지 않는다(독립검증 m9). 어느 쿼리도 그 정렬을 쓰지
-- 않을뿐더러, 하필 **코드가 의도적으로 기각한 정렬**을 스키마가 광고하면 다음 사람이 그걸 근거로
-- 정렬을 되돌린다. 이력 조회는 `seq` 역순 + LIMIT 이라 PK 를 그대로 탄다.

-- ── 매치별 스냅샷 ──────────────────────────────────────────────────────────────
--
-- **값 복사**다(참조 아님). user_deck_json(=매치 시점 덱 스냅샷, V1)과 같은 관용구 — 이 리포는 이미
-- "진행 중 매치는 자기 스냅샷만 본다"를 덱에 대해 하고 있고, config 를 그 목록에 한 줄 더 넣는다.
-- 진행 중 매치가 라이브 값을 **조회하는 경로가 없다**는 것이 #241 재발 방지의 전부다.
--
-- NULL = 오버레이 없음 = 러너 기본값(= 이 기능 이전과 bit-identical). 기존 행은 전부 NULL 이다.
ALTER TABLE matches ADD COLUMN config_overrides_json TEXT;
ALTER TABLE matches ADD COLUMN config_revision_id    TEXT;

-- 하프 번들 = **실적**(실제로 이걸로 돌았다). matches.* 는 의도(이걸로 돌기로 했다).
-- 두 축을 나누는 이유: 구 러너·재시도·경합에서 둘이 갈라질 수 있고, 갈라진 사실이 보여야 고칠 수 있다.
-- effective_config_hash 는 러너가 계산한 **유효 config 전체**의 지문이다(오버레이만의 해시가 아니다) —
-- 러너 이미지가 바뀌어 기본값이 달라지면 같은 오버레이라도 다른 경기가 되고, 그 사고가 여기 잡힌다.
ALTER TABLE match_halves ADD COLUMN config_overrides_json  TEXT;
ALTER TABLE match_halves ADD COLUMN effective_config_hash  TEXT;

-- 이번 재생에서 **적용하지 못해 버린** 경로(#383 독립검증 B3). NULL = 전부 적용됐다(정상).
-- 매치는 생성 시점 오버레이를 들고 두 하프를 도는데, 그 사이 엔진 배포가 노브를 삭제·개명하면
-- 그 경로는 더 이상 적용할 수 없다. 그때 러너가 400 을 내면 진행 중 매치가 FAILED 가 되고 원장의
-- 현재 리비전이 그 키를 든 한 신규 매치도 전부 죽는다 — 노브 삭제는 사고가 아니라 엔진 열차의
-- 정상 활동이므로 버리고 진행한다. **버린 사실은 여기 남는다**(조용히 버리는 것과의 차이 전부).
--
-- ⚠️ 이것이 막는 것은 **오버레이 때문에 죽는 것**뿐이다. 엔진이 동작을 바꾸며 config.version 을
--    올리면 진행 중 매치의 resumeState 가 거부되는 것은 여전히 그대로다(선존 #241 축, 별건).
ALTER TABLE match_halves ADD COLUMN dropped_overrides_json TEXT;
