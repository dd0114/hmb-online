-- #245 원정(피침공) 리포트·레이팅 — 별도 '원정' 모드 + 피원정 기록 + 레이팅 축.
--
-- hero 확정(2026-07-28): Q1 별도 '원정' 모드 · Q2 신규 rating 축 **초기 0**(하한 없음) ·
-- Q3 공격자·수비자 **둘 다 ±10** · Q4 고스트는 덱 해시로 박제 · Q5 수비자도 경기 관전.
--
-- 설계 근거(#245 W1): 이 리포 어디에도 "한 유저의 팀이 남의 상대가 되는" 경로가 없었다
-- (matches.bot_id 는 bots FK, bots 출처는 시드 3종 + 리그 생성 봇팀뿐). 원정은 그 경로를 새로
-- 만드는 대신 **리그가 이미 쓰는 패턴**을 재사용한다 — 리그가 생성한 봇팀을 bots 행으로 구워
-- matches.bot_id 로 물리듯(LeagueService.upsertBots), 원정은 **수비자의 덱 스냅샷**을 bots 행으로
-- 굽는다. 그래서 매치 생성·AI 잡·시뮬·정산 경로는 한 줄도 바뀌지 않는다.
--   → 부수 효과 하나가 그냥 따라온다: PromptContextBuilder.buildBotContext 가 봇 덱 JSON 의
--     promptText 를 이미 읽으므로, **수비자가 써둔 선수별 지시가 그대로 상대의 AI 인풋**이 된다.

PRAGMA foreign_keys = OFF;

-- ── matches.mode CHECK 확장 ('practice','league' → +'away') ──────────────────
-- SQLite 는 CHECK 를 ALTER 로 못 바꾼다 → V8/V19 와 같은 표준 12단계 재작성.
-- ⚠️ matches 는 자식이 참조한다(match_prompts·match_halves·ai_jobs·point_ledger·growth_applied).
--    defer_foreign_keys=ON 으로는 부족하다(V19 주석의 독립검증 blocker) → 트랜잭션 밖 PRAGMA,
--    짝 파일 V21__away_raid.sql.conf.
-- 컬럼 정의는 V19 의 matches_new 를 그대로 옮긴 것이다(V20 은 matches 를 건드리지 않았다).
-- mode CHECK 만 확장한다.

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
  mode          TEXT NOT NULL DEFAULT 'practice' CHECK (mode IN ('practice','league','away')),
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
CREATE INDEX idx_matches_user_state ON matches(user_id, state);

-- ── 원정 도전장: 이 매치의 상대 봇이 '누구의 팀'이었나 ──────────────────────
-- matches.user_id 는 **공격자**다(매치는 공격자 소유). 수비자 귀속을 이 표가 소유한다.
-- FINISHED 전에는 리포트가 없으므로(아래) 이 표가 정산 시점의 유일한 근거다.
CREATE TABLE away_challenges (
  match_id     TEXT PRIMARY KEY REFERENCES matches(id),
  defender_id  TEXT NOT NULL REFERENCES users(id),
  ghost_bot_id TEXT NOT NULL REFERENCES bots(id),
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_away_challenges_defender ON away_challenges(defender_id);

-- ── 피원정 기록(수비자 관점) ─────────────────────────────────────────────────
-- match_id UNIQUE = 멱등의 뿌리. 정산이 재시도되거나 두 경로에서 동시에 들어와도 한 행이다.
-- ⚠️ attacker_name·rating_delta 를 **박제**하는 이유: 닉네임이 바뀌거나 ±10 정책이 바뀌어도
--    지난 리포트가 뒤늦게 다른 말을 하면 안 된다(원장의 의미).
-- seen_at IS NULL = 미확인 = 로비 팝업 대상. 이 표가 그 상태의 SoT 다(클라 localStorage 아님).
CREATE TABLE away_reports (
  id            TEXT PRIMARY KEY,
  match_id      TEXT NOT NULL UNIQUE REFERENCES matches(id),
  defender_id   TEXT NOT NULL REFERENCES users(id),
  attacker_id   TEXT NOT NULL REFERENCES users(id),
  attacker_name TEXT NOT NULL,
  goals_for     INTEGER NOT NULL,
  goals_against INTEGER NOT NULL,
  result        TEXT NOT NULL CHECK (result IN ('WIN','DRAW','LOSS')),
  rating_delta  INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  seen_at       TEXT
);
-- 상시 경로 = "이 유저에게 미확인 리포트가 있나"(로비 진입마다).
CREATE INDEX idx_away_reports_unseen ON away_reports(defender_id, seen_at, created_at);

-- ── 레이팅 ──────────────────────────────────────────────────────────────────
-- wallets.points 와 **완전히 다른 축**이다: points 는 뽑기·강화로 소비되는 재화라 실력 지표로
-- 겸용할 수 없다(#245 W1 근거 #7). hero 확정 = 초기 0.
-- ⚠️ wallets.points 와 달리 CHECK(>=0) 을 두지 않는다 — 하한 없이 음수를 허용한다(hero Q2).
--    방어에 계속 실패한 팀이 0 에서 멈추면 "그 아래"가 표현되지 않는다.
CREATE TABLE user_ratings (
  user_id    TEXT PRIMARY KEY REFERENCES users(id),
  rating     INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- 레이팅 원장 — point_ledger 와 동형(멱등의 메커니즘까지 같게 둔다).
-- 유니크 인덱스가 "같은 매치로 두 번 가산"을 막는 최종 방어선이다.
CREATE TABLE rating_ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users(id),
  delta      INTEGER NOT NULL,
  reason     TEXT NOT NULL,            -- 'away_attack' | 'away_defense'
  ref_id     TEXT,                     -- match_id
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_rating_ledger_reason_ref
  ON rating_ledger(user_id, reason, ref_id) WHERE ref_id IS NOT NULL;

-- 기존 유저 백필 — 레이팅 0. 없으면 첫 정산 때 UPDATE 가 0행이라 조용히 사라진다.
INSERT INTO user_ratings(user_id, rating, updated_at)
SELECT id, 0, created_at FROM users;

PRAGMA foreign_keys = ON;
