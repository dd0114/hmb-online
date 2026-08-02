-- #408 원정 데일리 미션 — 하루(KST) 2개, 14종 균등 추첨, 달성 시 다이아, 미션당 1회 리롤.
-- 설계 SoT = docs/plan-v5/away-daily-mission.md (hero 확정 2026-08-02, §7).
--
-- **왜 파생이 아니라 테이블인가.** 진행도는 matches 에서 매번 다시 셀 수도 있다. 그럼에도 행을
-- 박제하는 이유는 `league_daily_rewards`(#368)·`starter_grants`(#209)와 같다: 금액·티어·목표·풀
-- 구성이 전부 config 노브라, 읽을 때마다 재계산하면 운영이 노브를 돌리는 순간 **오늘 이미 받은
-- 보상의 이력이 소급 변조**된다("아까 200 받았는데 화면엔 100").
--
-- ⚠️ **박제 범위가 doc §8 의 DDL 보다 넓다 — 그게 이 표의 계약이다.**
-- `title` 과 `rule` 이 추가돼 있다. 근거: §6.3 이 "달성했는데 안 받은 보상은 **기한 없이** 남는다"
-- 이고 §9 롤백이 "카탈로그를 비우면 새 미션이 생성되지 않는다"이므로, **카탈로그에서 사라진
-- 미션의 미수령 행**이 반드시 남는다. 그때 문구를 카탈로그에서 조회하는 구현은 화면에 빈 제목을
-- 그리고(또는 500), 판정 규칙을 조회하는 구현은 그날의 나머지 경기에서 진행도를 못 올린다.
-- **행 하나만 읽어도 표시·판정·지급이 완결**되어야 카탈로그가 바뀌어도 오늘이 무너지지 않는다.
--
-- **리롤은 UPDATE 가 아니라 은퇴 + 새 행**이다(`rerolled_at` + 부분 유니크 인덱스).
-- 제자리 UPDATE 를 쓰면 daily_mission_progress 가 가리키는 행의 미션이 사후에 바뀌어,
-- **지난 경기 결과 화면이 "그 경기가 밀지도 않은 미션"을 그린다**. 행은 한 번 정해지면 안 바뀐다.
-- 리롤 횟수는 **그 슬롯의 은퇴 행 수**로 센다(별도 카운터 컬럼 없음) — 은퇴가 곧 소모의 기록이라
-- 두 값이 갈라질 수 없고, `hmb.mission.daily.reroll-per-slot` 을 2 로 올리면 그대로 따라간다.
CREATE TABLE daily_missions (
  id            TEXT PRIMARY KEY,             -- ULID. claim·reroll 의 키이자 진행도 원장의 참조 대상
  user_id       TEXT NOT NULL,
  day           TEXT NOT NULL,                -- 'yyyy-MM-dd' (KST, ConditionService.dateOf)
  slot_no       INTEGER NOT NULL,             -- 1 | 2
  mission_id    TEXT NOT NULL,                -- 카탈로그 키('away_streak_2' 등) — 분석·디버깅용
  title         TEXT NOT NULL,                -- 화면 문구(박제, 위 ⚠️ 참조)
  tier          TEXT NOT NULL,                -- 'EASY' | 'NORMAL' | 'HARD' (박제)
  rule          TEXT NOT NULL,                -- 판정 규칙(박제, MissionRule)
  currency      TEXT NOT NULL,                -- 'GEM' (박제)
  amount        INTEGER NOT NULL,             -- 그 미션의 보상액(박제 — economy 노브를 돌려도 불변)
  target        INTEGER NOT NULL,             -- 목표치(박제)
  progress      INTEGER NOT NULL DEFAULT 0,
  completed_at  TEXT,                         -- 달성 시각(진행도는 여기서 멈춘다)
  claimed_at    TEXT,                         -- 수령 시각. NULL 이면 기한 없이 받을 수 있다(§6.3)
  rerolled_at   TEXT,                         -- 은퇴 시각. NULL 인 행만 '현재 미션'이다
  created_at    TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 한 슬롯에 **살아 있는** 미션은 하나. 은퇴 행(rerolled_at IS NOT NULL)은 이 제약 밖이라 이력으로 남는다.
-- 이게 없으면 동시 조회 두 건이 같은 슬롯에 미션을 두 개 만든다(생성이 lazy 라 실제로 열리는 창이다).
CREATE UNIQUE INDEX uq_daily_mission_slot
    ON daily_missions(user_id, day, slot_no) WHERE rerolled_at IS NULL;
CREATE INDEX idx_daily_mission_user_day ON daily_missions(user_id, day);

-- 경기 한 판이 미션 하나를 얼마나 밀었나.
--
-- **왜 필요한가 — 두 가지다.**
--  ① **멱등**: 재정산(스위퍼 경합·재진입)이 진행도를 두 번 올리면 안 된다. `league_daily_rewards`
--     의 match_id PK 와 같은 층이고, 여기선 (경기 × 미션) 축이라 복합 PK 다.
--  ② **결과 화면의 `missions` 배열**: "이 경기로 미션이 얼마나 갔나"는 **누적 진행도에서 사후에
--     분해되지 않는다**(1→2 인지 0→2 인지 알 길이 없다). GET /result 는 몇 번을 다시 불러도 같은
--     답을 해야 하므로 델타를 행으로 남긴다.
--
-- `completedNow` 는 저장하지 않는다 — `progress_before < target <= progress_after` 로 파생되고,
-- target 은 미션 행에 박제돼 사후에 바뀌지 않으므로 두 값이 갈라질 수 없다.
--
-- match_id 에 FK 를 걸지 않는 것은 `league_daily_rewards` 와 같은 선례다(그쪽도 user_id 에만 건다).
CREATE TABLE daily_mission_progress (
  match_id        TEXT NOT NULL,
  mission_row_id  TEXT NOT NULL,
  progress_before INTEGER NOT NULL,
  progress_after  INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (match_id, mission_row_id),
  FOREIGN KEY (mission_row_id) REFERENCES daily_missions(id)
);
