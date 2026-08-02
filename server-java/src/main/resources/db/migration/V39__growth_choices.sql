-- #405 W2b 성장 로직 본체 — 카드 레벨/XP · 3지선다 선택권 · 소급 이관 스냅샷 · 보상 봉투.
-- 설계 SoT = docs/plan-v5/growth-redesign.md §2.1(모델 전환) §2.4(XP) §2.5(3지선다) §2.7(이관) §2.9(보상).
--
-- W2a(V38)는 **계수와 인프라**까지였고 user_players 를 일부러 건드리지 않았다(계약 =
-- FlywayMigrationTest.v38DoesNotTouchUserPlayers) — 스키마 변경은 백업·백필과 한 세트여야 하기
-- 때문이다. 그 한 세트가 이 파일이다: 컬럼 추가 + 하향 전 base 스냅샷을 **같은 마이그레이션에서**
-- 남긴다.

-- ── 1. 카드 단위 성장 (§2.1 모델 전환) ────────────────────────────────────────
--
-- 구 모델: 스탯별 XP 풀 9개(stat_levels_json) → 자동 레벨업 → 자동 +1.
-- 신 모델: 카드 XP 풀 1개(card_xp) → 카드 레벨업 → **유저가 3지선다에서 고른 스탯만** 소수 상승.
--
-- ⚠️ stat_levels_json 은 **남긴다**(드롭하지 않는다). 두 가지 역할이 있다:
--   ① 소급 이관(§2.7)의 입력 — "기존 스탯 레벨 합 = 지급할 선택권 수"
--   ② 롤백 근거 — 구 모델로 되돌려야 하면 이 컬럼이 유일한 원본이다.
-- 백필이 끝난 뒤에도 지우지 않는다(지우는 순간 되돌릴 길이 사라진다).
ALTER TABLE user_players ADD COLUMN card_level INTEGER NOT NULL DEFAULT 1;
ALTER TABLE user_players ADD COLUMN card_xp INTEGER NOT NULL DEFAULT 0;

-- 상승분 누적 = {"shooting": 12.4, ...} (소수). 정수 lv 가 아니라 소수인 이유는 감쇠 곡선(§2.3)이
-- 상승폭을 현재 스탯값의 함수로 주기 때문이다 — 정수로 반올림해 저장하면 반올림 오차가 누적된다.
-- NULL = 아직 아무것도 안 골랐다(기본 안전: 마이그레이션만으로는 어떤 스탯도 오르지 않는다).
ALTER TABLE user_players ADD COLUMN stat_add_json TEXT;

-- ── 2. 3지선다 선택권 (§2.5) ────────────────────────────────────────────────
--
-- 레벨업 순간에 행이 생기고, 유저가 고를 때까지 **대기**한다(chosen_stat IS NULL).
--
-- ⚠️ candidates_json 에 **후보 스탯 3개 + 각각의 상승폭(gain)까지** 박제한다(hero 명시 요구).
--    후보만 박제하고 gain 을 나중에 계산하면, 미루는 동안 다른 픽으로 스탯이 올라 gain 이 줄어
--    "화면엔 +2.9 라고 써 있었는데 +2.1 이 들어왔다"가 된다.
--
-- ⚠️ seed 도 저장한다. 후보는 sha256(matchId+userId+playerId+":"+level) 으로 결정론적으로 뽑히지만,
--    그 사실이 **감사 가능**하려면 무엇으로 뽑았는지가 행에 남아야 한다(dice_rolls.seed 선례).
CREATE TABLE growth_level_choices (
  id              TEXT PRIMARY KEY,                       -- ULID
  user_id         TEXT NOT NULL REFERENCES users(id),
  player_id       TEXT NOT NULL REFERENCES players(id),
  level           INTEGER NOT NULL,                       -- 이 선택권을 만든 레벨(= 도달 전 레벨)
  candidates_json TEXT NOT NULL,                          -- [{"stat":"shooting","gain":3.2}, ...] 박제
  seed            TEXT NOT NULL,                          -- 후보 추첨 시드(감사·재현)
  source_match_id TEXT REFERENCES matches(id),            -- NULL = 소급 지급분(§2.7)
  created_at      TEXT NOT NULL,
  chosen_stat     TEXT,                                   -- NULL = 대기
  chosen_at       TEXT
);

-- 멱등의 뿌리 — **같은 레벨에 선택권이 두 번 생기지 않는다**. 정산 재실행·백필 재실행·경합이
-- 전부 여기서 막힌다(앱의 check-then-act 는 경합을 못 막는다는 V6·V14·V37 의 교훈).
CREATE UNIQUE INDEX uq_growth_choice_level ON growth_level_choices(user_id, player_id, level);

-- 대기 목록 조회(홈·선수탭 뱃지)는 "내 것 중 아직 안 고른 것" 이라 이 순서로 탄다.
CREATE INDEX ix_growth_choice_pending ON growth_level_choices(user_id, chosen_stat, player_id);

-- ── 3. 하향 전 base 스냅샷 (§2.7 이관) ──────────────────────────────────────
--
-- 왜 필요한가: players.attributes_json 은 **발행물 임포트가 매 부팅마다 덮어쓴다**
-- (PlayerCatalogService.importPlayers, ON CONFLICT DO UPDATE). v2.5 로 스위치하는 배포가 뜨는
-- 순간 v2.4 의 원본값은 어디에도 남지 않는다 — 그러면 "얼마나 깎였나"에 아무도 답할 수 없고
-- 롤백 근거도 사라진다.
--
-- ⚠️ **Flyway 는 ApplicationRunner 보다 먼저 돈다**(DataSource 초기화 시점). 그래서 이 INSERT 가
--    보는 players 는 **직전 부팅이 임포트한 값**이다:
--      · 의도한 원자 배포(W1+W2a+W2b 한 배) → 스냅샷 = v2.4(하향 전) = 목적한 값
--      · v2.5 가 이미 임포트된 뒤에 이 마이그레이션만 뜨는 경우 → 스냅샷 = v2.5(현재값과 동일)
--    어느 쪽이든 **안전**하다: 백필은 스냅샷의 절대값이 아니라 stat_levels_json 의 레벨 합으로
--    지급 수를 정하고(§2.7 안 C), 스냅샷은 감사·롤백 근거로만 쓴다. 두 경우의 구분은
--    GrowthLegacyBackfillService 가 로그·마커에 남긴다(자세한 근거는 그 클래스 javadoc).
CREATE TABLE growth_legacy_base (
  user_id         TEXT NOT NULL REFERENCES users(id),
  player_id       TEXT NOT NULL REFERENCES players(id),
  attributes_json TEXT NOT NULL,
  captured_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, player_id)
);

-- 보유 카드 **전량** 스냅샷(성장 이력이 없는 카드까지). 성장 이력이 있는 카드만 담으면
-- "안 키운 카드는 얼마나 깎였나"를 나중에 물을 수 없고, 라이브 규모가 3천 행이라 비용이 없다.
INSERT INTO growth_legacy_base(user_id, player_id, attributes_json, captured_at)
SELECT up.user_id, up.player_id, p.attributes_json,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM user_players up
JOIN players p ON p.id = up.player_id;

-- ── 4. 보상 봉투 (§2.9) ─────────────────────────────────────────────────────
--
-- hero 요구: "앞으로 모든 보상이 이 탭 구조를 쓴다." → 매치 전용이 아니라 **공용 계약**이다.
-- E5(데일리 미션)·리그·우편이 source 만 바꿔 그대로 재사용한다.
--
-- sections_json = [{kind:"CURRENCY",entries:[...]}, {kind:"GROWTH",entries:[...]}, ...]
-- ⚠️ 재화는 **코드만** 싣는다(이름·심볼 금지) — 표기는 economy 메타의 몫이고 서버 문자열에 박으면
--    표기 변경이 곧 배포가 된다(#232 재화 표기 메타 규칙).
CREATE TABLE reward_bundles (
  id              TEXT PRIMARY KEY,                       -- ULID
  user_id         TEXT NOT NULL REFERENCES users(id),
  source          TEXT NOT NULL,                          -- MATCH | MISSION | LEAGUE | MAIL
  source_ref      TEXT NOT NULL,                          -- 매치 id 등 출처 키
  sections_json   TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  acknowledged_at TEXT                                    -- NULL = 미확인
);

-- 같은 출처로 봉투가 둘 생기면 유저가 같은 보상을 두 번 본다(지급은 원장이 막지만 화면은 못 막는다).
-- user_id 를 키에 넣는 이유: 미래의 LEAGUE/MAIL 은 하나의 source_ref(시즌 id)로 여러 유저에게 간다.
CREATE UNIQUE INDEX uq_reward_bundle_source ON reward_bundles(source, source_ref, user_id);

-- 로비 뱃지("확인 안 한 보상 N") 조회 축.
CREATE INDEX ix_reward_bundle_unack ON reward_bundles(user_id, acknowledged_at);
