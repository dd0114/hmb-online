-- 카탈로그 (data 도메인 산출물 임포트 — 수정은 새 버전 임포트로만)
CREATE TABLE players (
  id            TEXT PRIMARY KEY,          -- 'P001'.. 고유 ID (실선수 아님)
  name          TEXT NOT NULL,
  position      TEXT NOT NULL CHECK (position IN ('GK','DF','MF','FW')),
  grade         TEXT NOT NULL CHECK (grade IN ('BRONZE','SILVER','GOLD','DIA','LEGEND')),
  attributes_json TEXT NOT NULL,           -- shared PlayerAttributes (9종 0..100)
  data_version  TEXT NOT NULL              -- 'v1' — 임포트 원본 버전
);

CREATE TABLE users (
  id            TEXT PRIMARY KEY,          -- ULID
  nickname      TEXT NOT NULL UNIQUE,
  auth_provider TEXT NOT NULL DEFAULT 'mock',  -- 추후 'oauth:google' 등
  created_at    TEXT NOT NULL
);

CREATE TABLE sessions (
  token         TEXT PRIMARY KEY,          -- 불투명 랜덤 토큰
  user_id       TEXT NOT NULL REFERENCES users(id),
  expires_at    TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE wallets (
  user_id       TEXT PRIMARY KEY REFERENCES users(id),
  points        INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0)
);

CREATE TABLE point_ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL REFERENCES users(id),
  delta         INTEGER NOT NULL,          -- +지급/-차감
  reason        TEXT NOT NULL,             -- 'starter','gacha_single','gacha_ten','reward_win','reward_draw','reward_loss'
  ref_id        TEXT,                      -- match_id / pull_id 등 (멱등 검사 키)
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_ledger_reason_ref ON point_ledger(user_id, reason, ref_id)
  WHERE ref_id IS NOT NULL;                -- 보상 중복 지급 방지(AC-M6)

CREATE TABLE user_players (                -- 보유 풀 (중복 획득은 count 증가)
  user_id       TEXT NOT NULL REFERENCES users(id),
  player_id     TEXT NOT NULL REFERENCES players(id),
  count         INTEGER NOT NULL DEFAULT 1,
  acquired_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, player_id)
);

CREATE TABLE decks (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  name          TEXT NOT NULL DEFAULT '기본 덱',
  formation     TEXT NOT NULL DEFAULT '4-4-2',   -- 엔진 config 포메이션 키와 일치해야 함
  is_active     INTEGER NOT NULL DEFAULT 1,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_decks_user_active ON decks(user_id) WHERE is_active = 1;  -- PoC: 활성 덱 1개

CREATE TABLE deck_slots (
  deck_id       TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  player_id     TEXT NOT NULL REFERENCES players(id),
  role          TEXT NOT NULL CHECK (role IN ('starter','bench')),
  slot_index    INTEGER NOT NULL,          -- starter: 0..10 = 포메이션 슬롯, bench: 0..6
  prompt_text   TEXT,                      -- 선수별 사전 프롬프트 (≤500자, 프리셋에서 복사 저장)
  PRIMARY KEY (deck_id, role, slot_index),
  UNIQUE (deck_id, player_id)              -- 한 덱에 같은 선수 중복 금지
);

CREATE TABLE prompt_presets (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  name          TEXT NOT NULL,
  prompt_text   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (user_id, name)
);

CREATE TABLE gacha_pulls (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  kind          TEXT NOT NULL CHECK (kind IN ('single','ten')),
  cost          INTEGER NOT NULL,
  seed          TEXT NOT NULL,             -- 뽑기 결정 시드(감사/재현용)
  created_at    TEXT NOT NULL
);
CREATE TABLE gacha_results (
  pull_id       TEXT NOT NULL REFERENCES gacha_pulls(id),
  ordinal       INTEGER NOT NULL,          -- 0..10
  player_id     TEXT NOT NULL REFERENCES players(id),
  PRIMARY KEY (pull_id, ordinal)
);

CREATE TABLE bots (                        -- 싱글 상대(시드 3종: 공격형/수비형/밸런스)
  id            TEXT PRIMARY KEY,          -- 'BOT_ATK','BOT_DEF','BOT_BAL'
  name          TEXT NOT NULL,
  persona       TEXT NOT NULL,             -- AI 팀 지시문(프롬프트)
  analysis_text TEXT NOT NULL,             -- 상대 분석 화면용 성향 요약
  deck_json     TEXT NOT NULL              -- {formation, starters[11:{playerId,slotIndex,promptText?}], bench[]}
);

CREATE TABLE matches (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  bot_id        TEXT NOT NULL REFERENCES bots(id),
  state         TEXT NOT NULL CHECK (state IN
                  ('BRIEFING','GEN1','H1_BREAK','GEN2','FINISHED','FAILED')),
  fail_reason   TEXT,
  seed          TEXT NOT NULL,             -- 매치 시드(half 시드 파생: seed+':h1'/':h2' 해시)
  engine_version TEXT NOT NULL,            -- EngineConfig.version (재현 계약)
  user_deck_json TEXT NOT NULL,            -- 매치 시점 덱 스냅샷(이후 덱 수정과 격리)
  subs_json     TEXT,                      -- 하프타임 교체 [{out,in}] ≤3
  score_h1_home INTEGER, score_h1_away INTEGER,
  score_home    INTEGER, score_away INTEGER,   -- 최종(전+후반)
  result        TEXT CHECK (result IN ('WIN','DRAW','LOSS')),
  created_at    TEXT NOT NULL,
  finished_at   TEXT
);
CREATE INDEX idx_matches_user ON matches(user_id, created_at DESC);

CREATE TABLE match_prompts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id      TEXT NOT NULL REFERENCES matches(id),
  phase         TEXT NOT NULL CHECK (phase IN ('pre','halftime')),
  scope         TEXT NOT NULL CHECK (scope IN ('team','player')),
  player_id     TEXT,                      -- scope='player'일 때
  text          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (match_id, phase, scope, player_id)   -- 같은 대상 재입력은 UPSERT
);

CREATE TABLE match_halves (                -- 재현 번들 + 결과 (half당 1행)
  match_id      TEXT NOT NULL REFERENCES matches(id),
  half          INTEGER NOT NULL CHECK (half IN (1,2)),
  select_data_json TEXT NOT NULL,          -- shared SelectData (교체 반영 후 로스터)
  home_input_json  TEXT NOT NULL,          -- shared TacticalInput (유저팀)
  away_input_json  TEXT NOT NULL,          -- shared TacticalInput (봇)
  half_seed     TEXT NOT NULL,
  match_log_json TEXT NOT NULL,            -- shared MatchLog (해당 half)
  resume_state_json TEXT,                  -- half=1의 엔진 resume 상태(있으면 half=2 승계, R2 참고)
  last_hash     TEXT NOT NULL,             -- MatchLog 마지막 틱 해시(재현 지문)
  PRIMARY KEY (match_id, half)
);

CREATE TABLE ai_jobs (                     -- ADR-1: Java 소유 잡 큐 (서번트가 폴링)
  id            TEXT PRIMARY KEY,          -- promptHash (멱등 키, sha256 hex 16+)
  match_id      TEXT REFERENCES matches(id),
  side          TEXT CHECK (side IN ('home','away')),
  half          INTEGER CHECK (half IN (1,2)),
  status        TEXT NOT NULL CHECK (status IN ('queued','leased','done','failed')),
  context_json  TEXT NOT NULL,             -- AI 실행기 입력(LLD-ts-servants §3 스키마)
  result_json   TEXT,                      -- TacticalInput (status='done')
  error         TEXT,
  usage_json    TEXT,                      -- {inputTokens,outputTokens,cacheReadTokens,cacheCreateTokens,costUSD}
  attempts      INTEGER NOT NULL DEFAULT 0,
  lease_until   TEXT,                      -- 가시성 타임아웃(만료 시 재배포, AC-Q1)
  worker_id     TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_ai_jobs_poll ON ai_jobs(status, created_at);

CREATE TABLE meta_kv (                     -- 시드 임포트 버전 등 ('players_version'='v1')
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
