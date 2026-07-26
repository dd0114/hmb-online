-- #209 스타터/온보딩 개편. additive only — V1~V12 는 손대지 않는다(체크섬 불변).
--
-- 1) users.tutorial_done: 온보딩 튜토리얼 완료 플래그.
--    지금까지 완료 여부는 **클라 localStorage 전용**이었고(web tutorial-storage.ts), 서버는
--    `user.tutorialDone` 을 발행하지 않았다. 덱 지급을 튜토리얼 완료에 매다는 순간 그 상태는
--    **권위 서버가 쥐어야 한다** — 안 그러면 localStorage 를 지우는 것만으로 덱이 반복 지급된다.
--    DEFAULT 0 = 신규 유저는 미완료.
ALTER TABLE users ADD COLUMN tutorial_done INTEGER NOT NULL DEFAULT 0;

-- 기존 유저 무영향(#209 "기존 유저 무영향 — 가입 시점만"): 이미 플레이 중인 계정은 전부 완료로
-- 백필한다. 이들에게는 튜토리얼이 다시 뜨지도, 덱이 새로 지급되지도 않는다(이미 자기 덱이 있다).
UPDATE users SET tutorial_done = 1;

-- 2) starter_grants: 가입 시 지급한 **최상위 유닛 1장의 박제**(user 당 정확히 1행 = PK).
--    지급 자체는 user_players 에도 남지만, "이 계정이 스타터로 받은 최상위가 누구인가"는
--    거기서 복원할 수 없다(뽑기·트레이드로 얻은 최상위와 구분이 안 된다).
--    재계산으로 답을 만들 수도 없다 — 후보 목록(economy.starterTop.pool)은 데이터라 #207 에서
--    갈아끼워지고, 그러면 같은 userId 의 재계산 결과가 **과거 지급과 달라진다**. 연출(리빌)이
--    읽는 값이므로 계산이 아니라 사실을 저장한다.
CREATE TABLE starter_grants (
  user_id    TEXT PRIMARY KEY REFERENCES users(id),  -- 1인 1회(멱등의 DB 레벨 보증)
  player_id  TEXT NOT NULL,                          -- 지급된 최상위 유닛
  granted_at TEXT NOT NULL
);
