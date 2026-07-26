-- 메이플 피벗 (에픽 #179 V2 스펙 — hero 확정 2026-07-26, 안 ㄴ). SoT =
-- issues/2026-07-26-growth-dual-track.md §V2-3. V8(enhance/limit_break/match_xp/growth_level)
-- 모델은 폐기 — 구 컬럼은 유지(데이터 보존, 롤백 여유)하되 코드 참조는 전량 제거한다.
--
-- 3축: ①스탯 성장(경기, stat_levels_json) ②성★(중복=천장, star) ③잠재능력(card_potentials·다이스).

ALTER TABLE user_players ADD COLUMN stat_levels_json TEXT;                    -- {"shooting":{"lv":3,"xp":120},...} 9종. NULL=fresh(전부 lv0/xp0).
ALTER TABLE user_players ADD COLUMN star            INTEGER NOT NULL DEFAULT 1;  -- 1~4

-- 잠재능력 (2★ 해금 시 1행 생성, RARE·빈 lines). 다이스 롤마다 갱신.
CREATE TABLE card_potentials (
  user_id             TEXT NOT NULL REFERENCES users(id),
  player_id           TEXT NOT NULL REFERENCES players(id),
  tier                TEXT NOT NULL DEFAULT 'RARE' CHECK (tier IN ('RARE','EPIC','UNIQUE')),
  lines_json          TEXT,                              -- [{slot,tier,type,stat?,value}]
  rolls_since_tierup  INTEGER NOT NULL DEFAULT 0,          -- 천장 카운터(노말 다이스 승급시도만 증가)
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (user_id, player_id)
);

-- 보유 다이스(노말/캐시).
CREATE TABLE user_dice (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  normal  INTEGER NOT NULL DEFAULT 0,
  cash    INTEGER NOT NULL DEFAULT 0
);

-- 다이스 롤 감사 로그 — SecureRandom seed 저장(가챠 패턴 복제, 재현 가능).
CREATE TABLE dice_rolls (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  player_id    TEXT NOT NULL REFERENCES players(id),
  kind         TEXT NOT NULL CHECK (kind IN ('NORMAL','CASH')),
  seed         TEXT NOT NULL,
  tier_before  TEXT,
  tier_after   TEXT,
  lines_json   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_dice_rolls_user_player ON dice_rolls(user_id, player_id);

-- growth_applied(V8, 멱등 PK)는 그대로 재사용 — 스키마 변경 없음, xp_delta는 스탯 XP 합계로 채운다.
