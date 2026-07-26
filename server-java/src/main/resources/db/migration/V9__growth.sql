-- 성장 시스템 (에픽 #179 — 가챠 강화 ⊥ 경기 성장 이중 트랙).
-- SoT = issues/2026-07-26-growth-dual-track.md §1. additive only: user_players 확장 + growth_applied.
-- 원본 players 는 불변(유저별 등급/스탯은 user_players 에서 파생).

ALTER TABLE user_players ADD COLUMN enhance_level   INTEGER NOT NULL DEFAULT 0;  -- 강화 레벨(밴드 내, 0..maxEnhance)
ALTER TABLE user_players ADD COLUMN limit_break     INTEGER NOT NULL DEFAULT 0;  -- 한계돌파 단계(등급 개방, 0..maxLimitBreak)
ALTER TABLE user_players ADD COLUMN match_xp        INTEGER NOT NULL DEFAULT 0;  -- 누적 경기 성장 xp
ALTER TABLE user_players ADD COLUMN growth_level    INTEGER NOT NULL DEFAULT 0;  -- floor(match_xp/xpPerLevel) 파생 캐시
ALTER TABLE user_players ADD COLUMN growth_vec_json TEXT;                         -- 최근 성장 방향 벡터(캐시, topAttrs 파생)
ALTER TABLE user_players ADD COLUMN copies_used     INTEGER NOT NULL DEFAULT 0;  -- 강화/돌파에 쓴 중복 누적

-- 성장 정산 멱등 (matches 1건당 (유저,카드) 1회) — relations_applied / point_ledger 멱등 패턴.
CREATE TABLE growth_applied (
  match_id   TEXT NOT NULL REFERENCES matches(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  player_id  TEXT NOT NULL REFERENCES players(id),
  xp_delta   INTEGER NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (match_id, user_id, player_id)
);
CREATE INDEX idx_growth_applied_match_user ON growth_applied(match_id, user_id);
