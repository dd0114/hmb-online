-- #179 gverify M1/m3: 성장 리포트를 정산 시점 스냅샷으로 — growthReport 가 minutesMult/이벤트를
-- 재계산하지 않고 이 컬럼을 읽는다(교체 mult 불일치·과거 리포트 드리프트 해소).
-- {statXp:{stat:int}, levelUps:[stat], ovrBefore:real, ovrAfter:real}
ALTER TABLE growth_applied ADD COLUMN report_json TEXT;
