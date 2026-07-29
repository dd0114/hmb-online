-- 다이스 구매 제거 (#247, hero 확정 2026-07-29) — "다이스는 사는 게 아니다".
--
-- 구조: 상점에서 다이스를 사서 user_dice 에 쌓아 두고 강화 상세에서 그걸 소모하던 흐름에서
-- **중간 재고를 통째로 들어낸다**. 롤 버튼이 지갑(G/Z)에서 직접 결제한다(단가 무변경 =
-- economy.dice.{normalCost,cashGemCost} 재사용 → 재화 유출량 롤당 동일, 경제 영향 0).
--
-- 기보유 재고 = **소각**(hero 확정 — 환불안을 제시했으나 소각 선택). 다만 소각은 되돌릴 수
-- 없으므로 **소각 시점 잔량을 박제**한다: 나중에 보상 요구가 오면 이 표가 유일한 근거고,
-- 없으면 "얼마였는지"를 아무도 답할 수 없다(starter_grants 와 같은 원칙 — 지급/소각 사실을
-- 계산으로 만들지 않는다. 가격은 override 로 바뀔 수 있어 사후 재계산이 성립하지 않는다).
--
-- user_dice / dice_rolls 는 **드롭하지 않는다**(V10 선례: 구 스키마는 남기고 코드 참조만 제거).
-- dice_rolls 는 롤 감사 로그라 계속 쓰인다. user_dice 는 이 마이그레이션 이후 무참조가 된다.

CREATE TABLE dice_burned (
  user_id     TEXT PRIMARY KEY REFERENCES users(id),
  normal      INTEGER NOT NULL,   -- 소각 시점 무료 다이스 잔량
  cash        INTEGER NOT NULL,   -- 소각 시점 유료 다이스 잔량
  burned_at   TEXT NOT NULL
);

INSERT INTO dice_burned(user_id, normal, cash, burned_at)
SELECT user_id, normal, cash, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  FROM user_dice
 WHERE normal > 0 OR cash > 0;

UPDATE user_dice SET normal = 0, cash = 0;
