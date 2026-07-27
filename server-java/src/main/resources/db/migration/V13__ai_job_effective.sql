-- V12 (#193 검증 B-2): (match, half, side) 당 "유효 잡"을 행 위에 명시한다.
--
-- 왜: 유효 잡을 "가장 최근에 갱신된 done 행"(ORDER BY updated_at DESC)으로 추론했는데, 그 시각은
-- **워커가 언제 보고했는지**지 **유저가 언제 지시했는지**가 아니다. 지시가 바뀐 뒤(supersede) 늦게
-- 도착한 낡은 잡의 complete 가 updated_at 을 지금으로 밀면 낡은 결과가 최신 지시를 이겼다.
-- supersede 가 leased/재큐 행을 지우지 않는 것은 의도다(워커의 complete 가 404 로 깨지지 않게, D2) —
-- 그래서 "살아 있지만 무효"를 표현할 자리가 필요하다.
--
-- effective=1 인 행은 (match_id, half, side) 당 최대 1개다(supersede 가 유지). done 이지만 무효인 행은
-- 지우지 않고 남긴다 — promptHash 멱등 캐시(A→B→A 로 지시를 되돌리면 콜 0 으로 재사용).
ALTER TABLE ai_jobs ADD COLUMN effective INTEGER NOT NULL DEFAULT 1;

CREATE INDEX idx_ai_jobs_effective ON ai_jobs(match_id, half, side, effective);
