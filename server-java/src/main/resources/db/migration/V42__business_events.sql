-- #492 비즈니스 이벤트 원장 — "심사위원이 게임을 어디까지 플레이했나"의 SoT. additive only(V1~V41 무변경).
--
-- 왜 admin_ops_audit(V18)을 안 쓰나: 그 원장은 **운영자가 한 일**(actor_user_id = admin)을 남긴다.
--   여기 쌓이는 것은 **유저가 한 일**이라 actor 의 뜻이 정반대다. 원장은 "무슨 일이 있었나"의
--   정본이므로 스키마가 사실과 어긋나면 안 된다(V18 이 admin_audit 을 재사용하지 않은 것과 같은 이유).
--
-- 형태는 V18 을 그대로 계승한다 — 범용 `event` 문자열 + `props_json` + ISO 시각 + 시간 인덱스.
--
-- ⚠️ 의도적으로 **걸지 않은** 제약 두 가지 (둘 다 "기록이 본 동작을 깨뜨리지 않는다"가 근거):
--   1. `event` 에 CHECK 없음 — 이벤트 종류가 늘 때마다 마이그레이션이 필요해지면 계측을 추가하는
--      비용이 배포 비용이 된다(V18 선례). 알려진 종류의 열거는 코드(BusinessEvent)가 소유한다.
--   2. `user_id` 에 FK 없음 — FK 위반은 곧 INSERT 실패이고, 그건 **기록이 본 동작을 깨는 경로**다.
--      이 테이블의 존재 이유가 "계측은 절대 게임을 방해하지 않는다"이므로 참조 무결성보다
--      쓰기 성공을 택한다. 조회 시 users LEFT JOIN 이라 유저가 지워져도 행은 살아남는다.
--
-- append-only: UPDATE/DELETE 하는 코드가 없다(원장이므로 사실을 고쳐 쓰지 않는다).
CREATE TABLE business_events (
  id          TEXT PRIMARY KEY,   -- ULID (시간순 정렬 PK — 같은 초 안의 tie-break 가 공짜다)
  event       TEXT NOT NULL,      -- 'user_signup' | 'tutorial_complete' | 'deck_save' | 'gacha_pull'
                                  --  | 'match_start' | 'match_finish' | 'league_season_start'
  user_id     TEXT NOT NULL,      -- 행위자(유저). FK 없음 — 위 ⚠️2 참조
  occurred_at TEXT NOT NULL,      -- ISO-8601 UTC (Instant.toString()). 리포 전역 규약 — epoch millis 아님
  props_json  TEXT                -- {mode:…, matchId:…, result:…} 등 이벤트별 속성. NULL 허용
);

-- 조회 방향은 셋뿐이다: "최근에 무슨 일이" / "이 종류의 이력" / "이 유저가 어디까지".
CREATE INDEX idx_business_events_time  ON business_events(occurred_at DESC);
CREATE INDEX idx_business_events_event ON business_events(event, occurred_at DESC);
CREATE INDEX idx_business_events_user  ON business_events(user_id, occurred_at DESC);
