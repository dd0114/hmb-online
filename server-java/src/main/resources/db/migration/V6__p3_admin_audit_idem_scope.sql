-- P3 §C 하드닝 — admin_audit 멱등 인덱스의 **스코프를 원장과 일치**시킨다.
-- V5 는 수정하지 않는다(이미 적용된 DB 가 있고 체크섬 규율상 기존 파일 무수정) — 신규 V6 로 교체한다.
--
-- 문제: V5 의 uq_admin_audit_idem(action, idem_key) 는 **전역**인데, 1차 권위인 원장 멱등
--   uq_ledger_reason_ref(user_id, reason, ref_id) 는 **유저별**이다. 두 층의 스코프가 어긋나서
--   유저 A 에 'K1' 지급 후 **유저 B 에 같은 'K1'** 을 쓰면 원장은 통과하는데 감사가 UNIQUE 로 터졌다.
--   (롤백은 정상이라 데이터 위험은 없었지만 500 + 응답에 SQL 문 노출로 이어졌다.)
--   멱등키는 클라이언트가 정하는 값이라, 서로 다른 유저에 같은 키가 오는 건 정상 시나리오다.
--
-- 해결: 감사 인덱스에 target_user_id 를 넣어 "유저별 멱등"으로 맞춘다. 그러면 두 층이 **같은 단위**로
--   중복을 판정하고, 감사 인덱스는 원래 의도대로 원장과 어긋날 때만 터지는 순수 백스톱이 된다.
--
-- 기존 행 안전성: 새 인덱스는 옛 인덱스보다 **느슨하다**(판정 키에 컬럼이 추가되면 충돌이 줄어든다).
--   옛 인덱스를 통과해 저장된 행 집합은 (action, idem_key) 가 유일하므로
--   (action, target_user_id, idem_key) 도 자동으로 유일하다 → 재생성이 실패할 수 없다. 데이터 이동 없음.
DROP INDEX IF EXISTS uq_admin_audit_idem;

CREATE UNIQUE INDEX uq_admin_audit_idem ON admin_audit(action, target_user_id, idem_key)
  WHERE idem_key IS NOT NULL;
