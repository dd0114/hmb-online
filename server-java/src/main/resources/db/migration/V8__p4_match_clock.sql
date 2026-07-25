-- P4-E2 (#170) 서버 권위 시계 + 감독시간 — docs/plan-v5/LLD-e2-flow-clock.md §8.
--
-- 1) matches 에 시계 컬럼 추가(kickoff_at / phase_start_at / phase_ends_at) + 후반 스코어 보관
--    (score_h2_*: 후반 재생이 끝나야 정산·합산하므로 그 전까지 응답에 노출하지 않고 DB 에만 둔다).
-- 2) state CHECK 확장: FIRST_HALF / HALFTIME / SECOND_HALF 추가. SQLite 는 CHECK 를 ALTER 로
--    바꿀 수 없어 표준 12단계 테이블 재작성을 한다.
--    ⚠️ trade_slots(V7)와 달리 matches 는 **자식이 참조한다**(match_prompts·match_halves·ai_jobs).
--    Flyway 가 마이그레이션을 트랜잭션으로 감싸므로 `PRAGMA foreign_keys` 는 여기서 무효(no-op)다 →
--    `PRAGMA defer_foreign_keys=ON` 으로 FK 검사를 커밋 시점까지 미룬다(그 시점엔 새 matches 가 제자리).
-- 3) 레거시 H1_BREAK → HALFTIME 이관: 이미 배포된 진행 중 매치를 살린다. phase_* 는 NULL 로 두어
--    "시계 미적용 = 수동 제출만"이 되게 한다(만료 스위퍼는 phase_ends_at IS NULL 행을 건드리지 않는다).
--    H1_BREAK 은 CHECK 에 남겨두되(감사·부분롤백 대비) 쓰기 경로는 만들지 않는다.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE matches_new (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  bot_id        TEXT NOT NULL REFERENCES bots(id),
  state         TEXT NOT NULL CHECK (state IN
                  ('BRIEFING','GEN1','FIRST_HALF','HALFTIME','SECOND_HALF','GEN2',
                   'FINISHED','FAILED','H1_BREAK')),
  fail_reason   TEXT,
  seed          TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  user_deck_json TEXT NOT NULL,
  subs_json     TEXT,
  score_h1_home INTEGER, score_h1_away INTEGER,
  score_home    INTEGER, score_away INTEGER,
  result        TEXT CHECK (result IN ('WIN','DRAW','LOSS')),
  created_at    TEXT NOT NULL,
  finished_at   TEXT,
  conditions_json TEXT,
  mode          TEXT NOT NULL DEFAULT 'practice' CHECK (mode IN ('practice','league')),
  league_fixture_id TEXT,
  relations_applied INTEGER NOT NULL DEFAULT 0,
  -- P4 시계 (ISO-8601, 밀리초 3자리 고정 — 문자열 비교로 만료 판정이 가능해야 한다)
  kickoff_at    TEXT,                        -- 전반이 라이브로 열린 시각(AC-W3-3)
  phase_start_at TEXT,                       -- 현재 단계 시작
  phase_ends_at TEXT,                        -- 현재 단계 종료 예정(HALFTIME 이면 감독시간 deadline)
  score_h2_home INTEGER, score_h2_away INTEGER  -- 후반 스코어(정산 전 보관, 응답 비노출)
);

INSERT INTO matches_new
  (id, user_id, bot_id, state, fail_reason, seed, engine_version, user_deck_json, subs_json,
   score_h1_home, score_h1_away, score_home, score_away, result, created_at, finished_at,
   conditions_json, mode, league_fixture_id, relations_applied)
SELECT id, user_id, bot_id,
       CASE WHEN state = 'H1_BREAK' THEN 'HALFTIME' ELSE state END,
       fail_reason, seed, engine_version, user_deck_json, subs_json,
       score_h1_home, score_h1_away, score_home, score_away, result, created_at, finished_at,
       conditions_json, mode, league_fixture_id, relations_applied
FROM matches;

DROP TABLE matches;

ALTER TABLE matches_new RENAME TO matches;

CREATE INDEX idx_matches_user ON matches(user_id, created_at DESC);
-- 만료 후보 스캔(스위퍼): 라이브 단계 + 종료시각 경과.
CREATE INDEX idx_matches_clock ON matches(state, phase_ends_at);
