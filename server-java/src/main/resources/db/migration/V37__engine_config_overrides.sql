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
CREATE TABLE engine_config_revisions (
  id             TEXT PRIMARY KEY,                    -- ULID (정렬 = 시간순 = "최신 = 현재")
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

CREATE INDEX idx_engine_config_rev_time ON engine_config_revisions(created_at DESC, id DESC);

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
