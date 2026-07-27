-- #212 재화 경제 정돈 (hero 확정 2026-07-27) — 기존 유저 지갑 마이그레이션.
--
-- 배경: 이 릴리스에서 골드(P) 경제가 통째로 ×10 됐다(리그 매판 500→5,000, 시즌 1위 3,000→100,000,
-- 무료 다이스 500→5,000, 트레이드 단축 h×50→h×500, 선수가치 ×10). 동시에 뽑기가 P 결제에서
-- 젬 결제로 옮겨가고, 젬은 가입 시 6,000 지급된다.
--
-- 마이그레이션이 없으면 기존 테스터는 (a) 구 스케일 P 잔액으로 신 가격표를 만나 다이스 하나도 못 사고
-- (b) 가입 지급 시점이 지나 젬이 0이라 뽑기를 아예 못 한다. 둘 다 여기서 1회 보정한다.
--
-- ⚠️ 아래 6000·×10·×9 는 **2026-07-27 시점 economy config 스냅샷**이다(initialGems=6000 =
--    gacha.tenCost 3000 × 2). 마이그레이션은 "그때 그 시점"을 박제하는 것이므로 config 가 나중에
--    바뀌어도 여기는 따라가지 않는다 — 의도된 분리다(#209 가 initialGems 를 바꿔도 무관).
--
-- 멱등: **마커 테이블**이 전체를 1회로 막는다. 원장의 INSERT OR IGNORE 만으로는 부족했다 —
-- 그건 원장 행만 막을 뿐 UPDATE 는 매번 다시 걸려서, 수동 재실행 시 잔액이 또 ×10 되고
-- 지갑과 원장이 영구히 어긋난다(원장이 SoT 인 설계에서 최악). 그래서 모든 문장을
-- "마커가 없을 때만" 으로 가둔다. Flyway 자체도 1회 실행이지만, 복구/수동 재실행 경로까지 안전하게.

CREATE TABLE IF NOT EXISTS economy_rescale_v14 (
  id          INTEGER PRIMARY KEY CHECK (id = 1),  -- 단일 행만 허용 = 1회성 마커
  applied_at  TEXT NOT NULL
);

-- (1) P 잔액 ×10 — 증분(=잔액×9)을 원장에 남기고 잔액을 올린다. 순서 중요: 원장을 먼저 계산·삽입해야
--     delta 가 구 잔액 기준으로 잡힌다. 잔액 0인 유저는 곱해도 0이라 원장 노이즈를 남기지 않는다.
INSERT INTO point_ledger(user_id, delta, reason, ref_id, created_at)
SELECT user_id, points * 9, 'economy_rescale_v14', 'v14', datetime('now')
FROM wallets
WHERE points > 0
  AND NOT EXISTS (SELECT 1 FROM economy_rescale_v14);

UPDATE wallets SET points = points * 10
WHERE points > 0
  AND NOT EXISTS (SELECT 1 FROM economy_rescale_v14);

-- (2) 젬 6,000 백필 — 가입 지급(reason='initial_gems')을 이미 지나친 기존 유저에게만.
--     신규 가입은 UserOnboardingService 가 지급하므로 여기 대상이 아니다.
--     ref_id='v14' 는 온보딩(ref_id=userId)과 갈라 두 경로를 원장에서 구분 가능하게 한 것이고,
--     **중복 방지는 유니크 키가 아니라 아래 NOT EXISTS 가 reason 단위로** 한다 — 즉 온보딩으로
--     이미 받은 유저는 ref 가 달라도 걸러진다. (유니크 키에만 기대면 두 네임스페이스가 서로를
--     못 막는다.) 이 ref 분리 덕에 아래 UPDATE 가 "이 마이그레이션이 넣은 행"만 정확히 겨눈다.
INSERT INTO gem_ledger(user_id, delta, reason, ref_id, created_at)
SELECT w.user_id, 6000, 'initial_gems', 'v14', datetime('now')
FROM wallets w
WHERE NOT EXISTS (SELECT 1 FROM economy_rescale_v14)
  AND NOT EXISTS (
    SELECT 1 FROM gem_ledger g
    WHERE g.user_id = w.user_id AND g.reason = 'initial_gems'
  );

UPDATE wallets SET gems = gems + 6000
WHERE NOT EXISTS (SELECT 1 FROM economy_rescale_v14)
  AND user_id IN (
    SELECT user_id FROM gem_ledger
    WHERE reason = 'initial_gems' AND ref_id = 'v14'
  );

-- 마커 확정 — 이후 어떤 재실행도 위 네 문장을 통과하지 못한다.
INSERT OR IGNORE INTO economy_rescale_v14(id, applied_at) VALUES (1, datetime('now'));
