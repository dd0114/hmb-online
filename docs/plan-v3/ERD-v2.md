# ERD v2 — Phase 2 증분 (Flyway V2__phase2.sql)

> V1(ERD.md) 위 증분. 이 DDL을 `V2__phase2.sql`로 그대로 옮긴다. 규약은 V1과 동일(ULID TEXT PK, ISO-8601 TEXT, JSON은 TEXT).

```sql
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
-- (V3__relations_applied.sql) 관계 변동 멱등 플래그 — V2 체크섬 불변 위해 별도 마이그레이션
-- ALTER TABLE matches ADD COLUMN relations_applied INTEGER NOT NULL DEFAULT 0;

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
```

## 노트
- **decks/deck_slots 유지 이유**: 브리핑·프리셋 편집기의 "작업 중 상태" + 기존 매치 스냅샷 경로 재사용. 스냅샷 저장/로드는 team_presets가 SoT.
- **컨디션 재현**: conditions_json은 매치 시드 파생(`sha256(seed+':cond:'+playerId)`)으로 롤 — 저장은 감사·표시용, 재계산과 일치해야 함(AC-C1 테스트).
- **versionId 여지(P2-D12)**: user_players/trade/preset의 player_id는 현 players.id 그대로 — 카드 시스템 도입 시 players가 (base, version) 확장돼도 FK 의미 유지되도록 이번 페이즈에서 player_id에 의미 부여 금지.
- **트레이드 시간**: opens_at 비교는 서버 Date.now 허용 영역. 단축 시 opens_at을 앞당기는 UPDATE + 원장 기록을 한 트랜잭션으로.
- **봇전 간이 결과**: league_seasons.seed + fixture id 파생 시드로 결정론 — DB에 저장된 스코어와 재계산 일치(AC-F2 테스트).
