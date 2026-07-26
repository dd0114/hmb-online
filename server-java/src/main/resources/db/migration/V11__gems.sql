-- V2.2 재화 이원화 (hero 확정 2026-07-26 — "지금·최소로"). SoT =
-- issues/2026-07-26-growth-dual-track.md V2.2. 무료 게임머니 P(포인트) vs 충전형 젬 분리.
-- 실결제는 백로그 — 충전은 목업(reason='gem_topup_mock', 즉시 지급).

ALTER TABLE wallets ADD COLUMN gems INTEGER NOT NULL DEFAULT 0 CHECK (gems >= 0);

-- point_ledger 와 동형(컬럼·멱등 유니크 인덱스 복제) — 캐시 다이스 구매(reason='dice')와
-- 충전 목업(reason='gem_topup_mock', ref=팩별 지급 ULID) 둘 다 여기 기록.
CREATE TABLE gem_ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL REFERENCES users(id),
  delta         INTEGER NOT NULL,          -- +지급/-차감
  reason        TEXT NOT NULL,             -- 'dice','gem_topup_mock' 등
  ref_id        TEXT,                      -- pull_id / 팩별 지급 ULID 등 (멱등 검사 키)
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_gem_ledger_reason_ref ON gem_ledger(user_id, reason, ref_id)
  WHERE ref_id IS NOT NULL;                -- 캐시 다이스/충전 중복 처리 방지(point_ledger 패턴 복제)
