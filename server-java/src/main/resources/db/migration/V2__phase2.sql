-- Phase 2 증분 (ERD-v2.md DDL 그대로). V1(V1__init.sql) 위에 적용 — ALTER 포함.
-- 규약은 V1과 동일(ULID TEXT PK, ISO-8601 TEXT, JSON은 TEXT).

-- B. 팀 스냅샷 프리셋 (기존 decks/deck_slots는 유지하되 '현재 편집 상태'로 역할 축소.
--    스냅샷이 저장의 SoT — 3슬롯.)
CREATE TABLE team_presets (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  slot_no       INTEGER NOT NULL CHECK (slot_no IN (1,2,3)),
  name          TEXT NOT NULL DEFAULT '프리셋',
  snapshot_json TEXT NOT NULL,   -- {formation, starters[11:{playerId,slotIndex,promptText?,role?}], bench[], teamTactics{line,press,tempo,width}?, teamPrompt?}
  updated_at    TEXT NOT NULL,
  UNIQUE (user_id, slot_no)
);

-- C1. 매치 컨디션 (매치 스냅샷에 포함 — matches에 컬럼 추가)
ALTER TABLE matches ADD COLUMN conditions_json TEXT;      -- {playerId: 0.0~1.0} 시드 결정론 롤
ALTER TABLE matches ADD COLUMN mode TEXT NOT NULL DEFAULT 'practice'
  CHECK (mode IN ('practice','league'));
ALTER TABLE matches ADD COLUMN league_fixture_id TEXT;    -- 리그 경기면 참조

-- C4. 감독 관계 (성격은 players 확장, 신뢰도/사기는 유저 상태)
ALTER TABLE players ADD COLUMN personality TEXT NOT NULL DEFAULT 'CALM'
  CHECK (personality IN ('FIERY','CALM','GLASS','AMBITIOUS'));   -- data v2.1에서 부여
CREATE TABLE player_relations (
  user_id     TEXT NOT NULL REFERENCES users(id),
  player_id   TEXT NOT NULL REFERENCES players(id),
  trust       INTEGER NOT NULL DEFAULT 50 CHECK (trust BETWEEN 0 AND 100),
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, player_id)
);
CREATE TABLE team_morale (
  user_id     TEXT PRIMARY KEY REFERENCES users(id),
  morale      INTEGER NOT NULL DEFAULT 50 CHECK (morale BETWEEN 0 AND 100),
  streak      INTEGER NOT NULL DEFAULT 0,      -- +연승/-연패
  updated_at  TEXT NOT NULL
);

-- D. 트레이드
CREATE TABLE trade_slots (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  slot_no       INTEGER NOT NULL CHECK (slot_no IN (1,2,3)),
  state         TEXT NOT NULL CHECK (state IN ('WAITING','OPEN','RESOLVING')),
  offer_kind    TEXT CHECK (offer_kind IN ('FA','TRADE')),
  target_player_id TEXT REFERENCES players(id),    -- 등장 선수(FA) 또는 대가 선수(TRADE)
  demand_player_id TEXT REFERENCES players(id),    -- TRADE: 상대가 지목한 내 선수
  seed          TEXT NOT NULL,                     -- 오퍼 생성·판정 재현
  opens_at      TEXT NOT NULL,                     -- 대기 만료 시각 (레어도별 config)
  created_at    TEXT NOT NULL,
  UNIQUE (user_id, slot_no)
);
CREATE TABLE trade_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(id),
  kind        TEXT NOT NULL CHECK (kind IN ('FA','TRADE')),
  result      TEXT NOT NULL CHECK (result IN ('SUCCESS','FAIL','DECLINED','EXPIRED')),
  detail_json TEXT NOT NULL,   -- {target, offered:[...], points, probability, roll}
  created_at  TEXT NOT NULL
);
-- 대기 단축 지출은 point_ledger(reason='trade_speedup', ref=slot id)로 — 멱등 인덱스 재사용

-- F. 리그
CREATE TABLE league_seasons (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  season_no   INTEGER NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('ACTIVE','FINISHED')),
  seed        TEXT NOT NULL,                 -- 봇팀 구성·일정·봇전 결과 재현
  teams_json  TEXT NOT NULL,                 -- [{teamId, name, persona, rosterPlayerIds[], power}] 10팀(유저 포함)
  created_at  TEXT NOT NULL, finished_at TEXT,
  UNIQUE (user_id, season_no)
);
CREATE TABLE league_fixtures (
  id          TEXT PRIMARY KEY,
  season_id   TEXT NOT NULL REFERENCES league_seasons(id),
  round       INTEGER NOT NULL CHECK (round BETWEEN 1 AND 18),
  home_team   TEXT NOT NULL, away_team TEXT NOT NULL,     -- teams_json의 teamId
  is_user     INTEGER NOT NULL DEFAULT 0,                 -- 유저 경기 여부
  state       TEXT NOT NULL CHECK (state IN ('SCHEDULED','PLAYED')),
  score_home  INTEGER, score_away INTEGER,
  match_id    TEXT REFERENCES matches(id),                -- 유저 경기만
  UNIQUE (season_id, round, home_team)
);
-- 순위표는 league_fixtures에서 파생(뷰/쿼리) — 승점 3-1-0, 골득실→다득점→승자승

-- E. 랭킹은 파생(매치/시즌 테이블 쿼리). 별도 테이블 없음(PoC).
