-- #368 리그 매판 일일 보상 트랙 — 하루 18칸 다이아, 9·18번째 대량, 이긴 판만 수령.
--
-- **왜 파생이 아니라 테이블인가.** 슬롯 번호만 놓고 보면 matches 에서 셀 수 있다(오늘 FINISHED 리그
-- 매치 수). 그럼에도 행을 박제하는 이유는 `starter_grants`(#209)와 같다: 금액·칸 수·대량 위치가
-- **전부 economy 노브**라, 읽을 때마다 다시 계산하면 운영이 노브를 돌리는 순간 **오늘 이미 받은
-- 보상의 이력이 소급 변조**된다("아까 300 받았는데 화면엔 30"). 지급 사실은 계산으로 만들지 않는다.
--
-- 부수 효과가 오히려 UI 의 절반이다 — 승패와 무관하게 "그 칸이 얼마짜리였나"가 남으므로,
-- 소멸한 칸도 무엇을 날렸는지 화면이 말할 수 있다.
--
-- ⚠️ **`big` 도 같은 이유로 행에 있다**(독립검증 minor-2). amount 만 박제하고 big 을 읽을 때
-- 재계산하면, bigSlots 를 [9,18]→[10,18] 로 돌리는 순간 **같은 행**이 "300 Z 를 받았는데 소량 스타일"
-- 로 그려진다. 돈은 맞고 스타일·라벨만 거짓말하는 상태이므로 더 찾기 어렵다.
--
-- **멱등은 두 층**(#251·#245 규율): ① match_id PK — 같은 매치가 두 번 정산돼도 두 번째 INSERT 가
-- 무시된다. ② 원장 유니크 (user_id, reason, ref_id) — walletService.apply* 가 이미 보장하므로
-- 1층이 뚫려도 돈은 안 샌다. uq_league_daily_slot 은 **한 칸이 두 매치에 팔리는 것**을 막는다
-- (1층은 매치 축, 이건 슬롯 축).
--
-- day 는 **매치 종료 시각(KST)** 이다. 생성 시각으로 앵커하면 23:58 에 시작해 00:03 에 끝난 경기가
-- 어제 칸을 먹고, 유저는 오늘 트랙에서 그 판이 사라진 걸 본다(#245 가 두 번 잡힌 UTC-자정 부류).
CREATE TABLE league_daily_rewards (
  match_id      TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  day           TEXT NOT NULL,                 -- 'yyyy-MM-dd' (KST, ConditionService.dateOf)
  slot_no       INTEGER NOT NULL,              -- 그날 순번 1..N
  currency      TEXT NOT NULL,                 -- 'GEM' | 'POINT'
  amount        INTEGER NOT NULL,              -- 그 칸의 값(승패 무관 — 소멸분도 얼마였는지 남는다)
  result        TEXT NOT NULL,                 -- 'WIN' | 'DRAW' | 'LOSS'
  awarded       INTEGER NOT NULL,              -- 1 = 실지급(WIN), 0 = 소멸
  big           INTEGER NOT NULL,              -- 1 = 대량 칸이었나(**그때의 config 기준**)
  opponent_name TEXT,                          -- 그때 붙은 상대 팀명(표시용 스냅샷, 없으면 NULL)
  created_at    TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE UNIQUE INDEX uq_league_daily_slot ON league_daily_rewards(user_id, day, slot_no);
CREATE INDEX idx_league_daily_user_day ON league_daily_rewards(user_id, day);
