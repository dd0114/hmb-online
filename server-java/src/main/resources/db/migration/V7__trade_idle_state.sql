-- #149 트레이드 능동화("장 시작!") — trade_slots 에 IDLE 상태 추가.
--
-- IDLE = 장이 닫힘(오퍼 없음). 유저가 POST /api/trade/{slot}/start 를 눌러야 오퍼가 생성되고
-- WAITING(카운트다운) 으로 간다. 판정(FA 성공 / TRADE accept / decline) 후에도 자동 재생성이 아니라
-- IDLE 로 닫힌다. 따라서 IDLE 행은 offer_kind/target/demand/seed/opens_at 이 전부 NULL 이어야 하므로
-- seed·opens_at 의 NOT NULL 을 푼다.
--
-- SQLite 는 CHECK 제약 변경/NOT NULL 해제를 ALTER 로 못 하므로 12단계 테이블 재작성 절차를 쓴다
-- (새 테이블 → INSERT SELECT → DROP → RENAME). trade_slots 를 참조하는 자식 테이블은 없어
-- (참조 방향은 users/players 로 나가기만 한다) FK 무결성 영향은 없다. 기존 행은 전량 보존한다.
--
-- 같이 추가: revealed — "이 오퍼가 한 번이라도 OPEN 으로 공개된 적 있는가". WAITING 마스킹은
-- **아직 공개된 적 없는 오퍼에만** 적용한다. FA 제안 실패 후 재제안 쿨타임(WAITING 재대기)에는
-- 이미 본 선수를 도로 가리지 않는다(인지 부조화 방지 — 계약 TradeSlot 설명 참조).

CREATE TABLE trade_slots_new (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  slot_no       INTEGER NOT NULL CHECK (slot_no IN (1,2,3)),
  state         TEXT NOT NULL CHECK (state IN ('IDLE','WAITING','OPEN','RESOLVING')),
  offer_kind    TEXT CHECK (offer_kind IN ('FA','TRADE')),
  target_player_id TEXT REFERENCES players(id),    -- 등장 선수(FA) 또는 대가 선수(TRADE)
  demand_player_id TEXT REFERENCES players(id),    -- TRADE: 상대가 지목한 내 선수
  seed          TEXT,                              -- 오퍼 생성·판정 재현 (IDLE 이면 NULL)
  opens_at      TEXT,                              -- 대기 만료 시각 (IDLE 이면 NULL)
  revealed      INTEGER NOT NULL DEFAULT 0,        -- 이 오퍼가 OPEN 으로 공개된 적 있는가(0/1)
  created_at    TEXT NOT NULL,
  UNIQUE (user_id, slot_no)
);

INSERT INTO trade_slots_new
  (id, user_id, slot_no, state, offer_kind, target_player_id, demand_player_id, seed, opens_at,
   revealed, created_at)
SELECT id, user_id, slot_no, state, offer_kind, target_player_id, demand_player_id, seed, opens_at,
       CASE WHEN state IN ('OPEN','RESOLVING') THEN 1 ELSE 0 END,   -- 이미 공개된 오퍼는 공개 유지
       created_at
FROM trade_slots;

DROP TABLE trade_slots;

ALTER TABLE trade_slots_new RENAME TO trade_slots;
