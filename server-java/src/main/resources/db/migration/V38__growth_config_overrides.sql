-- #405 W2a 성장 계수 무배포 변경 — 오버레이 원장. additive only(V1~V37 무변경).
--
-- 배경: 성장 계수는 지금 **두 곳에 흩어져** 있고 둘 다 무배포로 못 만진다 —
--   등급 밴드는 Java 하드코딩(GrowthService.GRADE_BAND)이라 아예 배포가 필요했고, xp/baseline 은
--   economy 발행물이라 볼륨 손편집 + 리로드만 가능했다(server-java/CLAUDE.md §무배포 운영).
--   설계 §2.8 이 그걸 하드 AC 로 올렸다: "새 계수 중 admin API 로 조정 불가한 것 0개".
--   그 AC 의 저장소가 이 표다. 설계 SoT = docs/plan-v5/growth-redesign.md §2.8.3.
--
-- ⚠️ 이 마이그레이션은 user_players 를 건드리지 않는다. 성장 스키마 변경(add 저장 형태·소급 지급)은
--    백업·백필과 한 세트여야 하므로 W2b 소관이다 — 이 웨이브만 적용해도 서버가 그대로 뜬다.

-- ── 오버레이 원장 (append-only, V37 engine_config_revisions 와 동형) ──────────
--
-- 왜 economy(#209)처럼 override **파일**이 아닌가: economy 의 base 는 이미지에 구워진 발행물이라
--   "리로드"만으로는 같은 바이트를 다시 읽을 뿐이었고 그래서 볼륨 파일이 필요했다. 여기 base 는
--   컴파일된 상수(GrowthTuning.CODE_DEFAULTS) + 발행물 승계이고 오버레이는 순수 서버 상태다 —
--   DB 가 정본이면 이력·멱등·트랜잭션이 따라온다.
--
-- 왜 UPDATE 가 아니라 append-only 인가: 정산이 쓴 리비전 id 를 사후에 가리키게 되므로(W2b 가
--   growth_applied.report_json 에 박제한다) 행을 덮어쓰면 **과거 정산의 근거가 소급으로 바뀐다**.
--   롤백은 "직전 내용을 새 리비전으로 다시 쓰는 것"이고, 기본값 복귀는 overrides_json = '{}' 리비전이다.
--
-- ⚠️ PK 가 `seq`(AUTOINCREMENT)이고 ULID 는 UNIQUE 다 — 보통과 반대다. 이유는 **정렬이 곧 동작**
--    이기 때문이다(V37 이 같은 이유로 같은 선택을 했다): 이 표의 "최신 행 하나"가 지금 적용되는
--    계수라, 동률이 나면 잘못된 값이 남은 채 롤백이 무시된다. 후보 둘 다 동률에서 깨진다 —
--    `created_at` 은 Instant.toString() 이 나노초 0 이면 소수부를 생략해 사전순이 뒤집히고,
--    **ULID 는 48bit ms + 80bit 난수라 같은 밀리초 안에서 난수가 순서를 정한다**(V37 이 3차 게이트에서
--    실제로 발화시킨 결함). SQLite rowid 로 바꿔도 되지만 그건 문서화된 보장이 아니라 구현 세부이고
--    VACUUM 이 재배치할 수 있다 — AUTOINCREMENT 는 **재사용하지 않는 단조 증가**를 스키마가 보장한다.
CREATE TABLE growth_config_revisions (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,   -- 삽입 순서 = "최신 = 현재"의 유일한 기준
  id             TEXT NOT NULL UNIQUE,                -- ULID (정산 리포트가 이 id 로 근거를 가리킨다)
  overrides_json TEXT NOT NULL,                       -- 정본(키 정렬) 오버레이 **전체 스냅샷**(델타 아님)
  actor_user_id  TEXT NOT NULL REFERENCES users(id),
  reason         TEXT NOT NULL,                       -- 운영 사유(필수 — "왜 바꿨나"가 없으면 이력이 아니다)
  idem_key       TEXT,
  request_hash   TEXT NOT NULL,                       -- 요청 원문 해시 = 멱등 판정의 **유일** 기준
  created_at     TEXT NOT NULL
);

-- 멱등 백스톱. 앱의 check-then-act 는 경합을 못 막는다(V6·V14·V37 이 같은 교훈을 남겼다) —
-- 같은 키 동시 PUT 이 리비전을 둘 만들면 "현재 값"이 어느 쪽인지 경합 결과에 달리게 된다.
CREATE UNIQUE INDEX uq_growth_config_rev_idem ON growth_config_revisions(idem_key)
  WHERE idem_key IS NOT NULL;

-- ⚠️ `(created_at DESC, id DESC)` 인덱스를 두지 않는다(V37 과 같은 이유). 어느 쿼리도 그 정렬을 쓰지
-- 않을뿐더러, 하필 **코드가 의도적으로 기각한 정렬**을 스키마가 광고하면 다음 사람이 그걸 근거로
-- 정렬을 되돌린다. 이력 조회는 `seq` 역순 + LIMIT 이라 PK 를 그대로 탄다.
