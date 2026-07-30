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
--  * 인덱스는 표와 함께 사라지므로 **셋 다 다시 만든다**(V14 둘 + V15 부분 유니크 하나).
--    ⚠️ V15 인덱스를 빠뜨리면 `unit_create` 멱등 백스톱이 조용히 사라진다 — 같은 키 동시 생성이
--    유닛을 두 개 만들던 그 결함(#207 blocker B1)이 되살아난다.
--  * 계약 = `FlywayV32CatalogAuditRebuildTest`(기존 행이 **내용까지** 살아남는지 + 인덱스 3개 재생성
--    + 새 action 수용 + 옛 오타 action 은 여전히 거부).
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

-- V15 멱등 백스톱(부분 유니크). **왜 부분인가**: 전역 (action, idem_key) 는 서로 다른 대상에 같은
-- 키가 오면 터진다(V5 가 그래서 V6 로 되돌려졌다). unit_create 는 대상이 아직 없어 "같은 키의 두
-- create = 같은 요청의 재전송"이 정의상 성립하므로 그 액션만 전역으로 잠근다.
CREATE UNIQUE INDEX uq_catalog_audit_create_idem
  ON admin_catalog_audit(action, idem_key)
  WHERE action = 'unit_create' AND idem_key IS NOT NULL;
