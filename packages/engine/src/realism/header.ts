import type { MatchLog } from "@hmb/shared";

/**
 * realism/header — **헤더 슛/골 집계**(#306 계약과 #357 스윕이 공유하는 측정).
 *
 * 왜 파일로 뺐나: 같은 수를 두 곳에서 각자 세면 계약과 진단이 조용히 갈린다(#327 이 `loft.ts` 로
 * 같은 처리를 한 이유와 동일). 헤더 임계를 필드 임계에서 분리하는 작업(#357)은 **헤더가 죽지
 * 않았음**을 스윕 격자 매 점에서 확인해야 하므로, 계약(`ball-physics.test.ts`)이 쓰는 바로 그
 * 함수를 쓴다.
 *
 * 순수 분석 유틸(프로덕션 `index.ts` 에 export 되지 않는다).
 */
export interface HeaderCounts {
  headerShots: number;
  headerGoals: number;
  /** `detail="header"` 이벤트 전체(경합 포함 — 슛만이 아니다). */
  headerEvents: number;
}

/**
 * 헤더 슛 → 골 연결: **같은 팀의 직전 슛이 헤더였던** `goal` 이벤트를 헤더 골로 센다
 * (엔진은 골 이벤트에 헤더 플래그를 싣지 않는다 — 슛 이벤트의 detail 이 유일한 출처).
 */
export function countHeaders(logs: MatchLog[]): HeaderCounts {
  let headerShots = 0;
  let headerGoals = 0;
  let headerEvents = 0;
  for (const l of logs) {
    const lastShotWasHeader = new Map<string, boolean>();
    for (const e of l.events) {
      if (e.detail === "header") headerEvents++;
      if (e.type === "shot" && e.team) {
        const isHeader = e.detail === "header";
        lastShotWasHeader.set(e.team, isHeader);
        if (isHeader) headerShots++;
      }
      if (e.type === "goal" && e.team && lastShotWasHeader.get(e.team)) headerGoals++;
    }
  }
  return { headerShots, headerGoals, headerEvents };
}
