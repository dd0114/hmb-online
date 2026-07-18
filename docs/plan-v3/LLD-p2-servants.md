# LLD — Phase 2 servants: 지시 카탈로그 + AI 예산 (에픽 p2-servants)

> 스코프: `packages/server/**` + `packages/shared/**`(계약 additive — 매니저 조율). #82(perf, hero 드라이브)의 A+B 구조와 **동일 코드베이스** — 착수 전 #82 현재 상태를 읽고 충돌 없게 조율(A+B가 이미 구현됐으면 그 위에, 아니면 현행 단일 생성 위에 얹되 카탈로그가 A+B 도입을 막지 않게).

## 1. 지시 카탈로그 (AC-C2·C3, P2-D6)
```
packages/server/src/prompt/directives/
  index.ts            # 레지스트리: 파일 스캔이 아닌 명시적 배열(결정론) — 1줄 추가/제거로 증감
  marking.ts          # 예: {id:'marking', promptGuide:'상대 선수명 지목 시 markTarget에 해당 playerId…',
                      #      contextNeeds:['opponentRoster'], outputFields:['players[].markTarget'], examples:[…]}
  overlap.ts forward-run.ts long-ball.ts press-trigger.ts tempo-control.ts …(초기 6종+)
```
- 각 지시 = **프롬프트 조각**(AI에게 이 지시 유형을 해석하는 법 설명 + few-shot 예시) + **출력 필드 명세**(TacticalInput의 어느 필드로 표현하는지) + **필요 컨텍스트 선언**.
- coach 빌더는 레지스트리를 순회해 프롬프트에 "지원 지시 목록" 섹션을 합성 — **지시 추가 = 파일 1개 + 레지스트리 1줄**. 제거 테스트(AC-C3): 1종 빼고도 빌드·기존 테스트 green.
- 마킹: opponentRoster 컨텍스트로 상대 이름→playerId 해석, 복수 마킹은 복수 수비수의 markTarget 분배 지침 포함. E2E: "X 막아" → 산출 인풋에 markTarget=X 검증(stub은 키워드로 흉내, 라이브는 방향성 스모크).

## 2. 컨텍스트 확장 (AC-C4)
- shared `TeamInputJobContext`에 additive optional 필드(manualTactics/conditions/relations/teamMorale/opponentRoster — LLD-p2-server §4와 동일 형태, zod `.optional()`이라 구계약 호환).
- coach 빌더 반영: manualTactics 있으면 "팀 전술은 이 값을 베이스로, 프롬프트로 보정만" 지침(A+B의 A와 정합). relations/personality → 선수별 반응성 지침(성격 4종 규칙 명문화: FIERY=강한 지시에 과반응, GLASS=질책성 문구에 위축(mentalModifier↓), AMBITIOUS=공격 지시 선호, CALM=안정) + trust 낮으면 지시 이행도 완화.
- **출력 스키마는 불변**(TacticalInput 그대로) — 컨텍스트는 입력만 늘린다(P2-D8).

## 3. AI 예산 하네스 (AC-C5)
- `packages/server/scripts/ai-budget.mjs`: 컨텍스트 블록 온/오프 매트릭스(기본/+컨디션/+관계/+카탈로그 full)로 stub·라이브 실행 → 블록별 입력/출력 토큰·시간 증분 리포트(json+표). 라이브는 옵션 플래그(콜 예산 절약).
- 회귀 가드: 출력 토큰 기준선 대비 +10% 초과 시 실패하는 테스트(stub 불가 — 프롬프트 길이 기준 근사 가드 + 라이브 게이트에서 실측).
- 결과는 #82와 공유(같은 관측 인프라 사용 권장).

## 4. 웨이브
W0 카탈로그 구조+마킹+기존 지시 이식 → W1 컨텍스트 확장+관계 반응 규칙(서버 W1과 계약 동시 머지) → W2 예산 하네스+가드. 각 웨이브 verifier PASS. 엔진 무수정 불변.
