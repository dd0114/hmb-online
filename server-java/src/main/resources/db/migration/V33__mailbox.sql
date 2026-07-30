-- #323 우편함 — admin 이 배포 없이 보상(카드·G·Z)+텍스트를 보내고 유저가 [받기]로 수령한다.
-- additive only(V1~V32 무변경).
--
-- ⚠️ **번호는 사람이 기억하지 않는다** — 결번·중복은 `FlywayVersionContinuityTest` 가 기계로 막는다.
--    이미 라이브에 적용된 번호는 절대 바꾸지 마라(체크섬·이력이 깨진다).
--
-- 설계 SoT = docs/plan-v5/mailbox.md. 요지 두 줄:
--   ① 발송 1건 = mail_campaigns 1행(본문·첨부·대상·만료가 여기 하나에만 있다).
--   ② 유저 × 캠페인 = user_mails 1행(**상태만** 산다). 그 id 가 곧 지급 멱등키다.
--
-- **왜 지급 테이블을 새로 만들지 않는가**: G 는 point_ledger, Z 는 gem_ledger, 카드는 user_players 가
--   이미 SoT 다. 우편함이 자기 지급 원장을 따로 가지면 "이 유저의 골드가 왜 늘었나"의 답이 두 곳이 된다.
--   수령은 기존 경로를 부르고 `ref_id = user_mails.id` 로 **기존 멱등 유니크 인덱스**에 얹힌다.

CREATE TABLE mail_campaigns (
  id             TEXT PRIMARY KEY,                    -- ULID
  audience       TEXT NOT NULL,                       -- 'ALL' | 'USERS'
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,                       -- 공지와 같은 마크다운 부분집합(렌더 살균은 web 소관)
  payload_json   TEXT NOT NULL,                       -- {"points":n,"gems":n,"players":[{"playerId":…,"count":n}]}
  -- payload 가 비어 있지 않은가. **발송 시점에 확정되고 이후 절대 바뀌지 않는** 파생값이다.
  -- 두는 이유: 뱃지 수("아직 할 일")가 "첨부가 있는데 안 받았다"를 포함해야 하는데, 그걸 payload JSON
  -- 파싱으로 판정하면 카운트 한 번에 행을 전부 읽어 파싱해야 한다. 여기 있으면 뱃지가 **순수 SQL**이다.
  has_attachments INTEGER NOT NULL DEFAULT 0,
  expires_at     TEXT,                                -- NULL = 무기한(hero 확정 ③). 초 절삭 ISO-8601 UTC
  revoked_at     TEXT,                                -- 오발송 회수 — **미수령분만** 막는다
  target_count   INTEGER NOT NULL,                    -- 팬아웃한 행 수(발송 시점 스냅샷)
  reason         TEXT NOT NULL,                       -- 운영 사유(필수)
  idem_key       TEXT NOT NULL,                       -- Idempotency-Key(헤더 없으면 서버 채번)
  created_by     TEXT NOT NULL REFERENCES users(id),
  created_at     TEXT NOT NULL
);

-- 같은 키의 재전송이 **두 번째 발송이 되지 않게** 하는 것이 이 인덱스다. 애플리케이션 검사만으로는
-- 동시 재전송(더블클릭)이 둘 다 통과한다 — 그때 DB 가 두 번째를 거절하고 서비스가 200 재생으로 바꾼다.
CREATE UNIQUE INDEX uq_mail_campaigns_idem ON mail_campaigns(idem_key);
CREATE INDEX idx_mail_campaigns_time ON mail_campaigns(created_at DESC);

CREATE TABLE user_mails (
  id            TEXT PRIMARY KEY,                     -- ULID — 지급 원장의 ref_id 로 그대로 쓴다
  user_id       TEXT NOT NULL REFERENCES users(id),
  campaign_id   TEXT NOT NULL REFERENCES mail_campaigns(id),
  expires_at    TEXT,                                 -- 발송 시점 캠페인 값의 **스냅샷**
  read_at       TEXT,
  claimed_at    TEXT,
  created_at    TEXT NOT NULL
);

-- 한 캠페인은 한 유저에게 한 번만 간다. 팬아웃이 어떤 이유로 두 번 돌아도(재시도·부분 실패 복구)
-- 유저가 같은 보상을 두 통 받는 일은 구조적으로 불가능하다.
CREATE UNIQUE INDEX uq_user_mails_user_campaign ON user_mails(user_id, campaign_id);
-- 조회는 항상 "내 우편함을 최신순으로" 하나뿐이다.
CREATE INDEX idx_user_mails_inbox ON user_mails(user_id, created_at DESC);

-- ⚠️ **만료는 유저 행에 복사한다**(본문·첨부와 반대). 만료는 "이 사람의 수령 창"이라, 캠페인 만료를
--    나중에 당기면 이미 받아 든 사람의 마감이 소급으로 짧아진다. 스냅샷이 정직하다.
-- ⚠️ 시각 컬럼은 **초 단위로 절삭된 ISO-8601 UTC**(고정 20자)로만 쓴다 — SQLite 비교가 문자열
--    사전순이라 소수초가 섞이면 같은 초 안에서 순서가 뒤집힌다(공지 V26 과 같은 규율,
--    정규화는 Notices.normalizeInstant 재사용).
