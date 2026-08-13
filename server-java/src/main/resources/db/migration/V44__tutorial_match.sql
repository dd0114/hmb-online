-- #493 W6-v3 — 튜토리얼 **고정 매치** 표식.
--
-- hero verbatim: *"선수도 보유 선수말고 그냥 튜토리얼선수로 … 그래야 시드값이 안바뀌어 … 모든유저가
-- 같은 결과를 보는거야 … 게임도 이겨야해."* → 이 매치는 유저 덱·프롬프트·AI 와 무관하게 **미리 구운
-- 매치로그**(`resources/tutorial/tutorial-match.json.gz`)를 그대로 적재한다.
--
-- **왜 `mode` 값을 새로 만들지 않았나**: `mode` 는 보상 곡선(`economy.rewards.forMode`)·모드별 전적
-- (`GET /api/me/record`)·리그/원정 분기가 전부 읽는 축이다. 값을 하나 더하면 그 소비자 전부가
-- "모르는 모드"를 만나고, 대부분은 조용히 폴백한다(= 보상 0 · 전적 누락). 튜토리얼은 **연습경기의
-- 한 종류**이므로 `mode='practice'` 를 그대로 두고 표식만 따로 단다 — 기존 소비자 변경 0.
--
-- **이 열의 두 번째 일은 파밍 차단**이다. 구운 로그는 항상 유저가 크게 이기므로, 반복 생성이 열려
-- 있으면 승리 보상이 무한 발행된다. `MatchService` 가 "FINISHED 인 튜토리얼 매치가 이미 있으면 409"
-- 를 이 열로 판정한다(ABANDONED·FAILED 는 회수 경로라 재시도를 막지 않는다).
ALTER TABLE matches ADD COLUMN is_tutorial INTEGER NOT NULL DEFAULT 0;

-- "이 유저가 튜토리얼 매치를 했나"는 매치 생성마다 묻는 질문이라 인덱스를 준다(전체 스캔 방지).
CREATE INDEX ix_matches_user_tutorial ON matches(user_id, is_tutorial);
