-- #217 매치 잠금·재입장 — 터미널 상태 ABANDONED 추가.
--
-- 왜 새 상태인가(설계 근거, 이슈 #217 STATE §4):
--   진행 중 매치가 하나라도 있으면 새 매치를 못 만들게(409) 잠그는 이상, 고아 매치를 **끝낼 수단**이
--   반드시 있어야 한다(영구 잠금 금지). 대안이던 `abandoned_at` 컬럼은 ALTER 한 줄로 끝나지만
--   "이 매치는 끝났다"는 판정을 상태머신 밖으로 빼내 코드 곳곳(kickoff/resume/retry/prompts/halftime/
--   league 재사용)에 흩뿌린다. 상태로 두면 기존 전이가 전부 CAS(`WHERE state = 'BRIEFING'` …)라
--   **폐기된 매치를 자동으로 거부**한다 — 새 가드가 0개다.
--
-- SQLite 는 CHECK 를 ALTER 로 못 바꾸므로 V8 과 같은 표준 12단계 테이블 재작성을 한다.
-- ⚠️ matches 는 자식이 참조한다(match_prompts·match_halves·ai_jobs·point_ledger·growth_applied).
--    `defer_foreign_keys=ON` 으로는 부족하다 — DROP TABLE matches(부모 암묵 DELETE)가 올린 위반
--    카운터는 같은 이름으로 RENAME 해도 줄지 않아 COMMIT 에서 터진다(V8 독립검증 blocker 재현).
--    그래서 트랜잭션 밖에서 PRAGMA foreign_keys=OFF — 짝 파일 V19__match_abandon.sql.conf.
--
-- 컬럼 정의는 V8 의 matches_new 를 그대로 옮긴 것이다(V8 이후 matches 에 ALTER 없음 —
-- V2/V3 의 추가 컬럼은 이미 V8 본문에 흡수돼 있다). state CHECK 만 확장한다.

PRAGMA foreign_keys = OFF;

CREATE TABLE matches_new (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  bot_id        TEXT NOT NULL REFERENCES bots(id),
  state         TEXT NOT NULL CHECK (state IN
                  ('BRIEFING','GEN1','FIRST_HALF','HALFTIME','SECOND_HALF','GEN2',
                   'FINISHED','FAILED','H1_BREAK','ABANDONED')),
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
  kickoff_at    TEXT,
  phase_start_at TEXT,
  phase_ends_at TEXT,
  score_h2_home INTEGER, score_h2_away INTEGER
);

INSERT INTO matches_new
  (id, user_id, bot_id, state, fail_reason, seed, engine_version, user_deck_json, subs_json,
   score_h1_home, score_h1_away, score_home, score_away, result, created_at, finished_at,
   conditions_json, mode, league_fixture_id, relations_applied,
   kickoff_at, phase_start_at, phase_ends_at, score_h2_home, score_h2_away)
SELECT id, user_id, bot_id, state, fail_reason, seed, engine_version, user_deck_json, subs_json,
       score_h1_home, score_h1_away, score_home, score_away, result, created_at, finished_at,
       conditions_json, mode, league_fixture_id, relations_applied,
       kickoff_at, phase_start_at, phase_ends_at, score_h2_home, score_h2_away
FROM matches;

DROP TABLE matches;

ALTER TABLE matches_new RENAME TO matches;

CREATE INDEX idx_matches_user ON matches(user_id, created_at DESC);
CREATE INDEX idx_matches_clock ON matches(state, phase_ends_at);
-- #217: "이 유저에게 끝나지 않은 매치가 있나" 를 매 로비 진입마다 묻는다 — 유저별 상태 스캔이 상시 경로다.
CREATE INDEX idx_matches_user_state ON matches(user_id, state);

-- ⚠️ 배포 1일차 락아웃 방지(오픈베타 DB 정합).
-- 이 마이그레이션 **이전**에는 매치를 몇 개든 만들 수 있었으므로, 실 DB 에는 유저당 끝나지 않은
-- 매치가 여러 건 남아 있다(브리핑만 열고 나간 것, GEN 타임아웃 FAILED 등). 잠금을 켜는 순간
-- 그 유저들은 "진행 중 매치가 있습니다" 409 에 막혀 손으로 하나씩 포기해야 한다.
-- → 유저별로 **가장 최근 1건만 남기고** 나머지 미완 매치를 여기서 회수한다. 배포 순간 실제로
--   경기 중인 매치가 항상 최신이므로(생성 시각 기준) 진행 중 플레이는 끊기지 않는다.
UPDATE matches SET state = 'ABANDONED', fail_reason = COALESCE(fail_reason, 'auto-abandoned by V19 (match lock rollout)')
WHERE state NOT IN ('FINISHED', 'ABANDONED')
  AND id NOT IN (
    SELECT id FROM matches m
    WHERE m.state NOT IN ('FINISHED', 'ABANDONED')
      AND m.created_at = (SELECT MAX(m2.created_at) FROM matches m2
                          WHERE m2.user_id = m.user_id AND m2.state NOT IN ('FINISHED', 'ABANDONED'))
  );

PRAGMA foreign_keys = ON;
