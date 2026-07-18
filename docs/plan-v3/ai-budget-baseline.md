# AI 예산 기준선 — 컨텍스트 블록별 입력 토큰 증분 (AC-C5 / P2-D8)

> 하네스: `packages/server/scripts/ai-budget.mjs` (계측 코어 `ai-budget-core.ts`).
> 재생성: `env -u ANTHROPIC_API_KEY npx tsx packages/server/scripts/ai-budget.mjs --out docs/plan-v3/ai-budget-report.json`
> 회귀 가드: `packages/server/scripts/ai-budget.test.ts` (블록 증분 ±20% · 출력 스키마 불변 · allOn 상한).

이 문서는 **오프라인 근사**(토크나이저 = `chars/4` 휴리스틱) 기준선이다. 실입력/출력 토큰·시간은
`--live`(실제 claude 콜)로 통합 게이트에서 채운다 — 아래 "라이브 실측" 표는 **미기입(TBD)**.

## 방법

- 프롬프트 빌더 = `buildTeamInputPrompt`(coach). 지시 카탈로그(6종)는 안정 프리픽스로 **항상 on**.
- `base` = Phase2 컨텍스트 블록 전부 off(카탈로그만 on). 각 `+블록` = base 에 그 블록 하나만 켠 컨텍스트.
- 블록 증분(Δ) = `len(base+블록) − len(base)`. 카탈로그(full)는 프리픽스 상주분이라 "카탈로그 제외 base" 대비 증분으로 표기.
- 픽스처 = `test-fixtures.ts`(결정론, 네트워크 0). `approxTokens = ceil(chars/4)`.

## 오프라인 기준선 (근사)

`base(카탈로그 on)` = **4980 chars ≈ 1245 tok**  ·  카탈로그 제외 base = **1940 chars ≈ 485 tok**

| 블록 | chars | ≈tok | Δchars | Δtok(근사) | 비고 |
|---|---:|---:|---:|---:|---|
| `+manualTactics` | 5250 | 1313 | +270 | +68 | A-base(수동 전술) 블록 |
| `+conditions` | 5353 | 1339 | +373 | +94 | 라인업 컨디션(11명 표기) |
| `+relations` | 5815 | 1454 | +835 | +209 | 성격 4종 규칙 + 선수별(가장 큼) |
| `+teamMorale` | 5054 | 1264 | +74 | +19 | 사기/연승 문맥(가장 작음) |
| `+opponentRoster` | 5223 | 1306 | +243 | +61 | 마킹 해석용 상대 11명 |
| `catalog(full)` | 4980 | 1245 | +3040 | +760 | 지시 카탈로그 6종 전체(프리픽스 상주분) |
| **전부 on** | **6775** | **1694** | **+1795** | **+449** | 5블록 전부 + opponentRoster |

관찰:
- 카탈로그(760 tok)가 base 프리픽스의 최대 항목 — 캐시 프리픽스라 요청마다 재청구 아님(프롬프트 캐시 대상).
- Phase2 컨텍스트 블록 합(전부 on Δ = 449 tok)에서 `relations`(209)가 절반 가까이. 나머지는 소액.
- **전부 on 도 ~1.7k 입력 토큰** — 입력측 증가는 예산 정책상 허용(P2-D8: 출력 증가만 금지).

## 출력 스키마 불변 (P2-D8 가드)

컨텍스트 확장은 **입력만** 늘린다. `TacticalInput` 출력 계약은 Phase2에서 **필드 증가 0**:
- `TacticalInput` = {seed, team, players, meta}
- `TeamInput` = 7필드 · `PlayerInput` = 7필드(markTarget 포함) · `PlayerBehavior` = 9필드
- 회귀 가드가 이 필드 집합을 박제 — Phase2에서 출력 필드가 늘면 테스트 FAIL.

## 라이브 실측 (통합 게이트에서 채움 — 현재 TBD)

`--live`(실제 claude 콜, 구독·`ANTHROPIC_API_KEY` unset)로 base~allOn 각 변형의 실입력/출력 토큰·TTFT·total 을 채운다.
출력 토큰 상한 정책(PRD AC-C5): 컨텍스트 추가로 **출력 토큰 +10% 초과 금지**(입력 무관). 이 실측이 그 게이트의 증거.

| 변형 | in_tok(실) | out_tok(실) | ttft_ms | total_ms |
|---|---:|---:|---:|---:|
| base | TBD | TBD | TBD | TBD |
| +manualTactics | TBD | TBD | TBD | TBD |
| +conditions | TBD | TBD | TBD | TBD |
| +relations | TBD | TBD | TBD | TBD |
| +teamMorale | TBD | TBD | TBD | TBD |
| +opponentRoster | TBD | TBD | TBD | TBD |
| allOn | TBD | TBD | TBD | TBD |

> 라이브 콜은 이번 웨이브에서 실행하지 않음(구현만). 통합 게이트에서 1회 실행해 위 표·`ai-budget-report.json.live` 를 채운다.
