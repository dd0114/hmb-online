-- #286 W4 (#319) — 원정 복수 큐.
--
-- ⚠️ **복수는 V22 가 일부러 닫아 둔 문을 다시 여는 기능이다.** away_offers 주석이 지목 원정을
--    어뷰징 경로로 명시하며 닫았다(클라가 고른 id 를 믿으면 부계정 반복 지목 = 레이팅 무한 생성,
--    독립검증 4R MAJ-4). 복수는 그 문을 **"나를 실제로 친 기록에 대해서만, 기록당 2회, 최근 5건"**
--    으로 좁혀 다시 연다. 그래서 아래 컬럼들은 표시용이 아니라 **자물쇠의 일부**다.
--
-- 새 표를 만들지 않는 이유: 한 리포트당 복수 상태는 정확히 하나라 1:1 이고, 조회 화면(복수 큐)이
-- 곧 리포트 목록이다 — 조인 하나를 벌자고 원장을 둘로 쪼갤 값이 없다.

-- ── 시도 횟수·상태 ──────────────────────────────────────────────────────────
-- 왜 상태를 컬럼으로 박나: V27(몰수)이 같은 결론에 도달했다 — **판정에 쓸 사실은 파생하지 않는다**.
-- 'AVENGED' 를 "이 리포트를 참조한 복수 매치 중 승리가 있나"로 파생하면 규칙이 하나 늘 때
-- (예: 무승부 재도전, 몰수 복수) 조용히 오분류된다.
ALTER TABLE away_reports ADD COLUMN revenge_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE away_reports ADD COLUMN revenge_state TEXT NOT NULL DEFAULT 'AVAILABLE';

-- ── ⚠️ 복수의 복수는 없다 (hero 확정) ───────────────────────────────────────
-- 내가 복수해서 이기면 **상대 쪽에 새 away_reports 행이 생긴다**(그가 수비자). 표식이 없으면 그 행이
-- 그의 복수 큐에 들어가고, 둘이 서로 갚기를 무한히 주고받는 핑퐁이 열린다 — hero 가 명시적으로
-- 닫은 경로다. 정산 시 "이 매치가 복수였나"를 그대로 리포트에 옮겨 큐에서 제외한다.
ALTER TABLE away_reports ADD COLUMN from_revenge INTEGER NOT NULL DEFAULT 0;

-- ── 매치 → 리포트 역참조 ────────────────────────────────────────────────────
-- 소모 판정이 **정산 시점**이라(승=완료 / 패=시도+1 / 무=횟수 안 씀 — hero 확정) 정산할 때
-- "이 매치가 어느 기록의 복수였나"를 알아야 한다. 생성 시점에 미리 깎으면 무승부 규칙이 성립하지 않는다.
--
-- ⚠️ NULL 기본값이어야 한다 — SQLite 는 REFERENCES 를 가진 컬럼을 ADD COLUMN 할 때 기본값이
--    NULL 이 아니면 거부한다(그리고 기존 행에 채울 유효한 리포트도 없다).
ALTER TABLE away_challenges ADD COLUMN revenge_report_id TEXT REFERENCES away_reports(id);

-- 복수 큐 = "내가 수비자인 최근 N건". 로비/원정 화면 진입마다 도는 경로라 인덱스를 둔다.
-- (기존 idx_away_reports_unseen 은 seen_at 을 두 번째 키로 잡아 이 정렬에 쓰이지 않는다.)
CREATE INDEX idx_away_reports_revenge ON away_reports(defender_id, from_revenge, created_at DESC);
