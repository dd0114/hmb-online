# ⚠️ 이 디렉토리의 로그는 "실패해야 정상"이다

여기 있는 것은 **기제를 일부러 끄고 돌린 실행**이다(변이체 킬). red 가 곧 성공 신호다.
출하 코드의 실행 로그는 한 단계 위(`evidence/477/AC*.log`)에 있고 그쪽은 green 이어야 한다.

**이 파일들을 출하 코드의 실행 결과로 읽지 마라.** 독립 검증 세 회차에서 그 오독이 세 번
나왔다 — 그래서 파일을 이 이름의 디렉토리로 옮겼다.

| 로그 | 무엇을 껐나 | 기대 | 실제 |
|---|---|---|---|
| `e2e-gate-disabled-RAW.log` | `MaintenanceGate` 의 `health === "outage"` → `false` | e2e "뜬다" 4건 red | 4 failed / 1 passed |
| `route-gate-disabled-RAW.log` | 위와 동일 | 라우트 전수 outage 15건 red | 15 failed / 15 passed |

살아남은 쪽은 둘 다 **"안 뜬다"를 단언하는 테스트**다(기제를 꺼도 참이므로 당연하다).
해석 전문 = `../AC4-variant-kill.md`.
