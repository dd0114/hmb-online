-- #212 재화 경제 정돈 (hero 확정 2026-07-27) — 기존 유저 지갑 마이그레이션.
--
-- 배경: 이 릴리스에서 골드(P) 경제가 통째로 ×10 됐다(리그 매판 500→5,000, 시즌 1위 3,000→100,000,
-- 무료 다이스 500→5,000, 트레이드 단축 h×50→h×500, 선수가치 ×10). 동시에 뽑기가 P 결제에서
-- 젬 결제로 옮겨가고, 젬은 가입 시 6,000 지급된다.
--
-- 마이그레이션이 없으면 기존 테스터는 (a) 구 스케일 P 잔액으로 신 가격표를 만나 다이스 하나도 못 사고
-- (b) 가입 지급 시점이 지나 젬이 0이라 뽑기를 아예 못 한다. 둘 다 여기서 1회 보정한다.
--
-- 멱등: 두 원장 모두 ref_id = 'v14' 고정 + 기존 유니크 인덱스(uq_ledger_reason_ref /
-- uq_gem_ledger_reason_ref)가 재적용을 막는다. Flyway 자체도 1회 실행이지만, 원장 백스톱을 둬
-- 수동 재실행/복구 시에도 이중 지급이 안 되게 한다(P 보상과 동일한 안전 패턴).

-- (1) P 잔액 ×10 — 증분(=잔액×9)만 원장에 남기고 잔액을 올린다. 순서 중요: 원장 먼저 계산·삽입한 뒤
--     지갑을 갱신해야 delta 가 구 잔액 기준으로 잡힌다.
INSERT OR IGNORE INTO point_ledger(user_id, delta, reason, ref_id, created_at)
SELECT user_id, points * 9, 'economy_rescale_v14', 'v14', datetime('now')
FROM wallets
WHERE points > 0;

UPDATE wallets SET points = points * 10 WHERE points > 0;

-- (2) 젬 6,000 백필 — 가입 지급(reason='initial_gems', ref=userId)을 이미 지나친 기존 유저에게만.
--     신규 가입은 UserOnboardingService 가 지급하므로 여기 대상이 아니다.
INSERT OR IGNORE INTO gem_ledger(user_id, delta, reason, ref_id, created_at)
SELECT w.user_id, 6000, 'initial_gems', 'v14', datetime('now')
FROM wallets w
WHERE NOT EXISTS (
  SELECT 1 FROM gem_ledger g
  WHERE g.user_id = w.user_id AND g.reason = 'initial_gems'
);

UPDATE wallets SET gems = gems + 6000
WHERE user_id IN (
  SELECT user_id FROM gem_ledger WHERE reason = 'initial_gems' AND ref_id = 'v14'
);
