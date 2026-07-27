-- #207 파트 A — 어드민 유닛 카탈로그(배포 없이 데이터 운영 + 전 변경 이력).
-- additive only — V1~V12 는 손대지 않는다(체크섬 불변).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 1) players 확장 2컬럼
-- ─────────────────────────────────────────────────────────────────────────────
--
-- active: 0 이면 **신규 획득 경로에서만** 제외한다(가챠 추첨 풀 · 트레이드 타깃 · 도감 목록 중
--   미보유분). 이미 가진 카드는 건드리지 않는다 — user_players 행 · star · stat_levels ·
--   card_potentials · 덱 편성 · 유효스탯 계산 · 매치 SelectData 는 전부 그대로 동작한다.
--   근거 = #207 hero 결정 U-D1(조합안): "구 LEGEND 14종은 등급 유지 + 비활성화, 기보유 유저 손실 0".
--   등급을 내리지 않으므로 GrowthService.GRADE_BAND 캡 역전(4★ 평균 -7.33)이 발생하지 않는다.
--   DEFAULT 1 = 기존 172행 전부 활성 = **무회귀**(마이그레이션만으로는 아무것도 사라지지 않는다).
--
-- admin_locked: 1 이면 **부팅 재임포트가 이 행을 덮지 않는다**(PlayerCatalogService 의
--   ON CONFLICT DO UPDATE ... WHERE admin_locked = 0).
--   왜 이 컬럼이 필요한가: 시드 파일(data/players/*.json)은 도커 이미지 안에 있어 배포해야 바뀐다.
--   어드민 API 로 런타임 DB 를 고쳐도 다음 부팅의 시드 임포트가 그대로 되돌려 놓으면
--   "배포 없이 데이터 운영"이라는 요구사항 자체가 성립하지 않는다.
--   대안이던 `player_overrides` 오버레이 테이블은 소비자 SELECT 5~6곳을 전부 병합 쿼리로
--   바꿔야 해서 기각했다(#207 웨이브1 §1.1 표 A안). 이 방식은 소비자 무변경이다.
--   되돌리기 = DELETE /api/admin/units/{id}/override → admin_locked=0 → 다음 부팅에 시드가 다시 이긴다.
--   DEFAULT 0 = 기본은 시드가 권위. 어드민이 만진 행만 잠긴다.
--
-- ⚠️ SQLite ALTER TABLE ADD COLUMN 은 NOT NULL 에 상수 DEFAULT 가 있어야 한다(둘 다 만족).
--   테이블 재작성이 아니므로 기존 인덱스·FK(user_players.player_id REFERENCES players(id))는 그대로다.
ALTER TABLE players ADD COLUMN active       INTEGER NOT NULL DEFAULT 1;
ALTER TABLE players ADD COLUMN admin_locked INTEGER NOT NULL DEFAULT 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) admin_catalog_audit — 카탈로그 변경 이력 원장
-- ─────────────────────────────────────────────────────────────────────────────
--
-- **왜 기존 admin_audit 을 재사용하지 않는가**
--   admin_audit.target_user_id 는 `TEXT NOT NULL REFERENCES users(id)` 다 → 대상이 유저가 아닌
--   (유닛) 액션을 담을 수 없다. NULL 허용으로 바꾸려면 SQLite 특성상 테이블 재작성이 필요하고
--   (V8 matches_new 선례), 컬럼의 성격 자체가 다르다: 포인트 감사는 `delta` 라는 스칼라 금액이고
--   카탈로그 감사는 **필드 집합의 변화**다. 그래서 원장 패턴(액터·사유·멱등키·시각)은 계승하되
--   테이블은 분리한다. players 는 **현재 상태만** 갖고 이력의 SoT 는 이 테이블이다 —
--   기존 wallets ↔ point_ledger 와 동일한 층 분리.
--
-- **왜 diff 가 아니라 before/after 전체 스냅샷인가**
--   필드 diff 만 쌓으면 "2월 3일 시점에 이 유닛이 어땠나"를 답하려고 전 이력을 처음부터 접어야 한다
--   (그리고 중간에 한 행이라도 유실되면 영영 복원 불가다). 스냅샷이면 **한 행이 그 답 자체**이고,
--   export/롤백도 그 행을 그대로 쓰면 된다. 카탈로그는 172행 규모라 용량 부담이 사실상 0이다.
--   changed_fields 는 스냅샷에서 파생되는 **조회 편의 컬럼**이지 권위가 아니다(권위는 두 스냅샷).
CREATE TABLE admin_catalog_audit (
  id             TEXT PRIMARY KEY,               -- ULID
  actor_user_id  TEXT NOT NULL REFERENCES users(id),
  player_id      TEXT NOT NULL,                  -- FK 걸지 않음: 삭제·미존재 유닛의 이력도 보존해야 한다
  action         TEXT NOT NULL CHECK (action IN
                   ('unit_create','unit_update','unit_deactivate','unit_activate','unit_override_reset')),
  before_json    TEXT,                           -- 변경 **전 전체 스냅샷**(unit_create 는 NULL)
  after_json     TEXT,                           -- 변경 **후 전체 스냅샷**
  changed_fields TEXT,                           -- 'grade,attributes' — 조회 필터용(파생, 편의)
  reason         TEXT NOT NULL,                  -- 운영 사유. 감사 원장이므로 NULL 불가(포인트 감사보다 강하다)
  idem_key       TEXT,
  created_at     TEXT NOT NULL
);

-- 조회용: "이 유닛에 무슨 일이 있었나" / "이 admin 이 뭘 했나" 두 방향 모두 최신순.
CREATE INDEX idx_catalog_audit_player ON admin_catalog_audit(player_id, created_at DESC);
CREATE INDEX idx_catalog_audit_actor  ON admin_catalog_audit(actor_user_id, created_at DESC);

-- 멱등 백스톱. 스코프를 **처음부터 대상별**(action, player_id, idem_key)로 잡는다 —
-- V5 가 감사 멱등을 전역 (action, idem_key) 으로 잡았다가 서로 다른 대상에 같은 키가 오면
-- UNIQUE 로 터져 500 이 나서 V6 로 고쳐야 했다. 멱등키는 클라이언트가 정하는 값이므로
-- 서로 다른 유닛에 같은 키가 오는 건 **정상 시나리오**다. 그 실패를 반복하지 않는다.
CREATE UNIQUE INDEX uq_catalog_audit_idem
  ON admin_catalog_audit(action, player_id, idem_key) WHERE idem_key IS NOT NULL;
