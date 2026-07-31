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

## 5. 산출 게이트 — 무엇을 막고 무엇을 안 막나 (`src/prompt/gates.ts`)

게이트의 원칙은 **값의 '방향'은 강제하지 않는다**는 것이다(감독 지시 해석의 자유도). 막는 것은
자기모순·물리 파손·**명시적 지시의 미이행** 셋뿐이다.

| | 검사 | 근거 |
|---|---|---|
| G1 | 낮은 라인 + 오프사이드 트랩 = 자기모순 | #193 |
| G2 | **대상을 지목한** 마킹 지시인데 `markTarget` 0건 | #193 (지목 없는 마킹은 모델 재량 — 발동 안 함) |
| G3 | 두 선수 `basePosition` 간격 < 0.02 = 배치 파손 | #324 (라이브 실측: 결함은 간격 0, 정상 최소 0.04) |
| G4 | 감독이 고른 포메이션과 **다른 포메이션 배치** | #367 / #295 |

### G4 가 상대 비교인 이유 (절대 임계 금지)
엔진은 `team.formation` **문자열을 읽지 않는다** — 포메이션의 실효는 `basePosition` 11개뿐이다.
그래서 "이름만 4-4-2, 배치는 4-3-3"이면 유저에게 포메이션 선택이 통째로 무효다.
그러나 "기준 좌표에서 N 이상 벗어나면 거부"로 만들면 좌표 충실도를 강제하게 되어 지시(라인 올려·
측면 벌려)를 막는다 — #324 가 좌우 뒤집힘을 게이트로 만들지 **않은** 이유가 그것이다. 그래서 G4 는
임계 대신 **"선언한 포메이션이 후보 표 중 최적인가"** 만 본다(여유 `formationFitMargin` 0.02).
전술적 조정은 모든 후보의 거리를 같이 밀어 순위를 바꾸지 않는다.

슬롯은 **배열 순서가 아니라 `playerId`→`slotIndex`** 로 잡는다 — 라이브 산출의 19.4% 가 로스터와
다른 순서로 선수를 낸다(실측 98건). 배열 인덱스로 재면 순서만 다른 정상 산출을 어긋남으로 읽는다.

포메이션 **이름**은 덱 소유다 — 모델이 바꿔 내면 거부가 아니라 요청값으로 **정정**한다(엔진이 안 읽는
값에 재시도 1회를 쓰지 않는다). 라이브 98건 중 10건이 요청과 다른 이름을 선언하고 있었다.

배포 후 재측정 = `node tools/live-input-audit.mjs <hmb.db 사본>` 의 **D3**(게이트와 같은 표·같은 여유,
드리프트 락은 `tools/live-input-audit.test.ts`).

## 6. 광고 ↔ 실효 감사 (`src/prompt/advertised-fields.test.ts`)

프롬프트가 광고하는 필드가 **실제로 경기를 바꾸는지**를 값 스윕(0/0.5/1 → 산출 해시 비교)으로 잰다.
판정 기준이 "참조가 있다"가 아니라 "효과가 있다"인 이유: #321(GK 능력치)이 정확히 "조회는 되지만
확률식엔 안 들어가는" 함정이었다. `KNOWN_DEAD` 목록이 **광고 중이지만 소비자 0인 필드의 전량**이고,
새 죽은 광고가 생겨도 · 후속 웨이브가 살려도 **양방향으로 깨진다**. 목록을 비우는 것이 목표다.
