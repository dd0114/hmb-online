-- #210 / #309 W2 후속 — 유닛 **회수 이력을 카탈로그 원장에 합친다**(hero 지시 2026-07-30).
--
-- ⚠️ 번호는 merge 시점에 main 이 배정한다. 결번·중복은 FlywayVersionContinuityTest 가 막는다.
--
-- ## 왜 이 마이그레이션이 필요한가
--
-- 회수(`POST /api/admin/units/{id}/purge`)를 처음 넣을 때 그 기록을 `admin_ops_audit`(V18 범용
-- 원장)에 남겼다. 이유는 이 표의 `action` 에 **CHECK 제약**이 있어 값을 늘리려면 테이블을 통째로
-- 재작성해야 했고, "이력 원장을 재작성하는 마이그레이션"의 위험을 그 기능이 지기엔 컸기 때문이다.
--
-- 대가는 **한 유닛의 이력이 두 원장에 나뉜다**는 것이었다: 생성·수정은 여기, 회수는 저기. 운영자가
-- "이 번호에 무슨 일이 있었나"를 물으면 두 곳을 봐야 하고, 회수는 하필 **유닛 감사 조회에 안 나오는**
-- 유일한 액션이 된다. hero 가 그걸 고치라고 했다 — 그래서 지금 CHECK 를 넓힌다.
--
-- ## 이 마이그레이션이 안전한 이유 (⚠️ DROP TABLE 이 있다)
--
-- SQLite 는 CHECK 제약을 ALTER 로 바꿀 수 없어 **표준 12단계 재작성**(새 표 → 복사 → 드롭 → 개명)이
-- 유일한 방법이다. 다만:
--  * **데이터는 변환하지 않는다** — `INSERT ... SELECT` 로 전 컬럼을 그대로 옮긴다(열 순서·타입 동일).
--  * **원자적이다** — Flyway 가 트랜잭션으로 감싸고 SQLite DDL 은 트랜잭션 안에서 롤백된다.
--    (이 파일에 `.sql.conf`(executeInTransaction=false)를 **두지 않는 것이 그 보장**이다.)
--  * `admin_catalog_audit` 를 **FK 로 참조하는 표가 없다** → 드롭·개명이 남의 제약을 건드리지 않는다
--    (그래서 `legacy_alter_table` 프래그마가 필요 없다. 프래그마는 트랜잭션 안에서 무효이기도 하다).
--  * 인덱스는 표와 함께 사라지므로 **넷 다 다시 만든다**(V14 **셋** + V15 하나).
--    ⚠️⚠️ **처음 쓸 때 V14 를 "둘"로 오독해 `uq_catalog_audit_idem` 을 빠뜨렸고, 그 손실을
--    계약이 `containsExactlyInAnyOrder(3개)` 로 박제하고 배포 확인 커맨드가 "3이면 정상"으로
--    보고했다**(독립검증 BLOCKER-1). 즉 고치려 하면 테스트가 막는 상태였다 — 계약이 구현을
--    검증한 게 아니라 복사한 것이다. **인덱스 목록을 세는 계약은 반드시 원본 마이그레이션을
--    직접 읽고 세라.**
--    무엇을 잃었나: `uq_catalog_audit_idem`(대상별 멱등)은 `update`·`deactivate`·`activate`·
--    `override_reset` **4개 액션의 유일한 DB 백스톱**이다(V15 가 스스로 "다른 4개 액션은 V14
--    인덱스가 그대로 담당한다"고 적었다). 앱의 `findAudit` 는 check-then-act 라 경합을 못 막으므로,
--    빠지면 같은 멱등키 동시 PATCH 가 **감사 원장에 중복 행**을 만들고 두 번째 행의 `before`
--    스냅샷은 이미 바뀐 상태라 **"무엇이 바뀌었나"가 거짓이 된다** — 이 커밋이 강화하려던 그 원장이다.
--  * 계약 = `FlywayV32CatalogAuditRebuildTest`(**마이그레이션 전에 심은 행**이 내용까지 살아남는지 +
--    인덱스 **4개** 재생성(부분 조건까지) + 새 action 수용 + 오타 거부 + 두 유니크가 실제로 잠그는지).
--
-- 배포 시엔 §0.5 체크 1·7 에 걸린다 → **백업 필수**(deploy-playbook §8). 그게 이 재작성의 안전망이다.

CREATE TABLE admin_catalog_audit_new (
  id             TEXT PRIMARY KEY,
  actor_user_id  TEXT NOT NULL REFERENCES users(id),
  player_id      TEXT NOT NULL,                  -- FK 걸지 않음: 회수·미존재 유닛의 이력도 보존한다
  action         TEXT NOT NULL CHECK (action IN
                   ('unit_create','unit_update','unit_deactivate','unit_activate',
                    'unit_override_reset','unit_purge')),
  before_json    TEXT,
  after_json     TEXT,
  changed_fields TEXT,
  reason         TEXT NOT NULL,
  idem_key       TEXT,
  created_at     TEXT NOT NULL
);

INSERT INTO admin_catalog_audit_new
  (id, actor_user_id, player_id, action, before_json, after_json, changed_fields,
   reason, idem_key, created_at)
SELECT id, actor_user_id, player_id, action, before_json, after_json, changed_fields,
       reason, idem_key, created_at
  FROM admin_catalog_audit;

DROP TABLE admin_catalog_audit;
ALTER TABLE admin_catalog_audit_new RENAME TO admin_catalog_audit;

-- V14 조회 인덱스 둘: "이 유닛에 무슨 일이 있었나" / "이 admin 이 뭘 했나" 각각 최신순.
CREATE INDEX idx_catalog_audit_player ON admin_catalog_audit(player_id, created_at DESC);
CREATE INDEX idx_catalog_audit_actor  ON admin_catalog_audit(actor_user_id, created_at DESC);

-- V14 멱등 백스톱 — **대상별**(action, player_id, idem_key). `update`·`deactivate`·`activate`·
-- `override_reset` 4개 액션을 담당한다. 멱등키는 클라이언트가 정하는 값이라 **서로 다른 유닛에 같은
-- 키가 오는 건 정상 시나리오**이고, 그래서 스코프가 대상별이다(V5 가 전역으로 잡았다가 500 이 나서
-- V6 로 고쳤다 — 그 실패를 반복하지 않는다).
CREATE UNIQUE INDEX uq_catalog_audit_idem
  ON admin_catalog_audit(action, player_id, idem_key) WHERE idem_key IS NOT NULL;

-- V15 멱등 백스톱(부분 유니크). **왜 전역인가**: `unit_create` 는 대상(id)이 아직 없어 대상별
-- 스코프로는 재전송을 식별할 수 없다 — 같은 키의 두 create 는 정의상 **같은 요청의 재전송**이므로
-- 그 액션만 전역으로 잠근다. 위 V14 인덱스와 **역할이 다르다**(둘 다 필요하다).
CREATE UNIQUE INDEX uq_catalog_audit_create_idem
  ON admin_catalog_audit(action, idem_key)
  WHERE action = 'unit_create' AND idem_key IS NOT NULL;
