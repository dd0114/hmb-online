-- #493 W6-v3 — **무료 쿠폰**(1회성 권리) 인프라.
--
-- hero verbatim: *"이런 무료쿠폰개념은 나중에 쓰일수있으니까 이것도 설계 잘해두자"* — 즉 이 표의
-- 존재 이유는 튜토리얼이 아니라 **재사용 가능한 일반 인프라**다(튜토리얼은 첫 소비자일 뿐).
--
-- **이것은 지갑도 원장도 아니다.** V33(우편함)·V40(데일리 미션) 머리말의 규율 — *"지급 표를 새로
-- 만들지 않는다 / 여기에 새 지갑·멱등 메커니즘을 만들지 마라"* — 은 **재화**에 관한 것이다.
-- 쿠폰이 나타내는 것은 잔액이 아니라 **"이번 한 번은 값을 안 낸다"는 권리**이고, 그건 기존 어느
-- 표에도 자리가 없다:
--   · `wallets`/`*_ledger` 로 흉내내면 = "5,000 G 를 줬다가 다시 받는다" → 원장에 가짜 수급이
--     찍히고 유저 잔액이 잠시 부풀어 다른 소비에 쓸 수 있다(권리가 재화로 샌다).
--   · `user_mails` 로 흉내내면 = 첨부가 재화뿐이라 "무료로 만든다"를 표현할 수 없다.
-- 그래서 **권리 원장 하나**를 새로 두고, 재화는 여전히 기존 원장만이 만든다(쿠폰이 소비되면
-- 애초에 차감 자체가 일어나지 않는다 = 원장에 행이 안 생긴다).
--
-- **지급 멱등 = `uq_user_coupons_grant(user_id, type, grant_key)`.** `grant_key` 는 "무엇 때문에
-- 줬나"(예: `starter`)다 — 스타터 지급이 재실행돼도 `INSERT OR IGNORE` 가 두 장을 만들지 않는다.
-- 같은 유저에게 같은 종류를 **여러 장** 주는 것도 가능하다(`grant_key` 를 달리하면 된다: 이벤트
-- 회차·우편 캠페인 id 등). 상한을 표에 박지 않는 이유 = 상한은 정책이고 정책은 지급하는 쪽에 있다.
--
-- **소비 멱등 = `used_at IS NULL` CAS.** 이중 소비 방어를 애플리케이션 선검사에 두지 않는다
-- (read-then-act 는 #286 BL-1 이 실측으로 뚫었다 — 동시 6요청이 6판을 만들었다). 소비는 항상
-- `UPDATE … WHERE used_at IS NULL` 의 **갱신 행 수**로 판정하고, 0행이면 이미 쓰인 것이다.
--
-- **`type` 에 CHECK 를 걸지 않는다.** 종류가 늘 때마다 마이그레이션이 필요해지면 "나중에 쓰일 수
-- 있는 인프라"라는 목적이 깨진다. 유효 종류의 SoT 는 `CouponService.CouponType` enum 이고,
-- 모르는 문자열은 조회에서 아무것도 매치하지 않으므로(=혜택 없음) 실패 모드가 안전하다.
--
-- **`expires_at` 은 NULL 이 정상값**이다(만료 없는 쿠폰). 만료를 유저 행에 스냅샷하는 것은 V33
-- 우편함과 같은 이유 — 나중에 정책을 당겨도 이미 받은 사람의 마감이 소급으로 짧아지면 안 된다.
CREATE TABLE user_coupons (
  id          TEXT PRIMARY KEY,                          -- ULID
  user_id     TEXT NOT NULL REFERENCES users(id),
  type        TEXT NOT NULL,                             -- CouponService.CouponType (FREE_ENHANCE, FREE_TRADE_RUSH, …)
  grant_key   TEXT NOT NULL,                             -- 지급 사유 = 멱등 키 ('starter', 'mail:<campaignId>' …)
  granted_at  TEXT NOT NULL,                             -- ISO-8601 (#245 규율: 시각은 전부 ISO)
  used_at     TEXT,                                      -- NULL = 미사용. 소비 CAS 의 판정 컬럼
  used_ref    TEXT,                                      -- 어디에 썼나 (감사용: 'dice:P122', 'trade:1' …)
  expires_at  TEXT                                       -- NULL = 무기한
);

CREATE UNIQUE INDEX uq_user_coupons_grant ON user_coupons(user_id, type, grant_key);

-- 보유 조회(`hasUnused`)와 소비 후보 선정이 같은 조건을 쓴다 — 미사용분만 훑는다.
CREATE INDEX ix_user_coupons_unused ON user_coupons(user_id, type, used_at);
