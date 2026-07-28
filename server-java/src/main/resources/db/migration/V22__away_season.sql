-- #245 원정 v2 (hero 3차 컨펌 2026-07-29): 후보 2택 · 레이팅 밴드 매칭 · 연승 보너스 · 주간 시즌.
--
-- V21 이 만든 것(mode='away' · away_challenges · away_reports · user_ratings · rating_ledger)은 그대로 두고
-- 그 위에 얹는다. matches 재작성은 없다(CHECK 변경 없음) → 이 마이그레이션은 트랜잭션 안에서 돈다.

-- ── 후보 제시 원장 ──────────────────────────────────────────────────────────
-- 왜 저장하나: hero E2 = "무작위 2명 중 택1". 클라가 고른 id 를 그대로 믿으면 **지목 원정**이 되고,
-- 그건 부계정을 반복 지목해 레이팅을 무한 생성하는 경로다(독립검증 4R MAJ-4 가 막은 그것).
-- 서버가 방금 무엇을 제시했는지 기억하고, **그 안에서만** 수락한다.
-- 유저당 1행(PK) — 새로 뽑으면 이전 제시는 무효다(리롤로 후보를 쌓지 못하게).
CREATE TABLE away_offers (
  user_id     TEXT PRIMARY KEY REFERENCES users(id),
  candidates  TEXT NOT NULL,          -- JSON 배열 [userId, ...] (현재 2명, 수는 config)
  created_at  TEXT NOT NULL
);

-- ── 연승 ────────────────────────────────────────────────────────────────────
-- hero E4. 공격/수비 구분 없이 **원정에서 이긴 연속 횟수**다 — 지면 0 으로 끊긴다.
-- 무승부는 유지(끊지도 늘리지도 않는다): 비긴 걸로 연승이 깨지면 방어 성공이 손해가 된다.
CREATE TABLE away_streaks (
  user_id     TEXT PRIMARY KEY REFERENCES users(id),
  streak      INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,   -- 표시·시즌 보상용(현재 미소비, 기록만)
  updated_at  TEXT NOT NULL
);

-- ── 주간 시즌 ───────────────────────────────────────────────────────────────
-- hero E5 = "레이팅이 자연스럽게 올라가다 주마다 보상 + 초기화".
-- ⚠️ 시즌은 **행으로 존재해야 한다**. "지금이 몇 주차인지" 를 시각 계산으로 파생하면 서버가 멈춘
--    동안의 주가 통째로 건너뛰어 보상이 조용히 사라진다. 마감은 이 표의 ends_at 을 지난 ACTIVE 행을
--    찾아 닫는 방식이라, 늦게 켜져도 밀린 시즌이 순서대로 정산된다.
CREATE TABLE away_seasons (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  season_no  INTEGER NOT NULL UNIQUE,
  state      TEXT NOT NULL CHECK (state IN ('ACTIVE','CLOSED')),
  started_at TEXT NOT NULL,
  ends_at    TEXT NOT NULL,
  closed_at  TEXT
);
CREATE UNIQUE INDEX uq_away_seasons_active ON away_seasons(state) WHERE state = 'ACTIVE';

-- 시즌 마감 스냅샷 — 초기화 전에 박제한다. 레이팅을 0 으로 되돌리는 순간 그 시즌의 결과는
-- 어디에도 남지 않으므로, 보상 지급의 근거이자 "지난주 몇 등이었나"의 유일한 기록이다.
CREATE TABLE away_season_results (
  season_no    INTEGER NOT NULL REFERENCES away_seasons(season_no),
  user_id      TEXT NOT NULL REFERENCES users(id),
  rating       INTEGER NOT NULL,
  rank         INTEGER NOT NULL,
  reward_points INTEGER NOT NULL,
  best_streak  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (season_no, user_id)      -- 마감 재실행 멱등의 뿌리
);
CREATE INDEX idx_away_season_results_user ON away_season_results(user_id, season_no DESC);

-- 1주차를 지금 연다. ends_at 은 부팅 시 서비스가 config(length-days)로 재계산해 채우므로
-- 여기서는 자리만 잡는다(빈 표로 두면 첫 원정 전까지 시즌이 없는 상태가 된다).
INSERT INTO away_seasons(season_no, state, started_at, ends_at)
SELECT 1, 'ACTIVE', datetime('now'), datetime('now', '+7 days')
WHERE NOT EXISTS (SELECT 1 FROM away_seasons);
