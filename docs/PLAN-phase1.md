# HMB 온라인 — Phase 1 PoC 구현 계획 (PLAN-phase1) · v1.1 (Tier B)

> 근거: `docs/PRD.md` v1.1 §5·§6·§7·§8·§11·§12, `research/match-engine.md` §1-1·§2·§3, `research/tactics-instructions.md` §5.
> 성격: 리스크 우선(risk-first) vertical-slice 분해. 이 문서는 `/epic-flow decompose`(구현 에픽) 의 입력.
> **v1.1 변경: 매치 엔진을 Tier B(축소 공간 에이전트)로 확정.** 엔진이 좌표·움직임을 내므로 §2 엔진 설계·§4 렌더·§6 슬라이스가 재작성됨. 리포는 그린필드(docs/research만 존재).

---

## 0. 이 PoC가 증명해야 하는 명제 (Tier B 로 강화됨)

> **"자연어 프롬프트, 특히 위치·움직임 지시('풀백 올라가라', '더 침투해라')를 바꾸면, 22 에이전트가 실제로 다르게 움직이고, 결과가 서로 다르되 납득 가능하게 바뀌며, 어느 한 프롬프트로 수렴하지 않는다."**

Tier A(추상 통계) 대비 검증 명제가 **두 겹**으로 강해졌다:
1. **움직임 성립성** — 축소 공간 엔진이 "그럴듯한 축구 움직임"을 내는가(에이전트 행동 신뢰성). ← Tier B 의 새 핵심 리스크.
2. **프롬프트→움직임→결과 유의미성** — 위치 지시가 실제 다른 움직임으로 나타나고 결과가 갈리며 단일 최적으로 붕괴 안 하는가.

두 겹 모두 **눈으로 봐야** 검증되므로, 최소 디버그 뷰어를 M1 로 앞당긴다(Tier A 계획에선 렌더가 맨 뒤였음).

---

## 1. 아키텍처 개요

### 1.1 모노레포 (PRD §11)
```
hmb-online/
├─ packages/
│  ├─ engine/     # 순수 결정론 공간 시뮬. 프레임워크·IO·시간·전역난수 의존 0.
│  │              # 입력:(TacticalInput 양팀 + SelectData) → 출력:MatchLog(틱별 좌표+이벤트)
│  │              # Math.random·Date.now 금지, 위치/속도는 고정소수.
│  ├─ shared/     # 직렬화 계약(zod): TacticalInput(행동 파라미터), SelectData, MatchLog, PlayerCard.
│  ├─ server/     # 권위. Claude 오케스트레이션 + engine 실행 + 재생 러너.
│  └─ (dev)       # engine 내 최소 디버그 뷰어(headless→2D 관찰용)
└─ apps/
   └─ web/        # TS+React(상태머신·개입 UI) + PixiJS v8(2D 실좌표 재생). 재생만.
```
**의존 방향**: `web → server → engine`, 모두 `→ shared`. engine 은 shared 타입만 안다.

### 1.2 데이터 흐름 (PRD §5·§7)
```
[web] 프롬프트 UI(선수별 자연어 + 프리셋칩 8종 + 라인업/포메이션)
   │  OPEN 커밋 = freeze
   ▼
[server] (프롬프트 + 선수 raw속성 + 상대 라인업) → Claude(Sonnet, tool-use JSON강제)
   │  → TacticalInput{team, players[].behavior, basePosition, seed} → zod 검증 → 클램프 → (위반→재요청→프리셋 폴백)
   ▼
[engine] runMatch(seed, homeInput, awayInput, selectData)  [순수·결정론 공간 시뮬]
   │  1초 틱 × 5,400: perceive→decide→act→resolveContests → MatchLog{tickSnapshots[coords], events[], score, hashes[]}
   ▼
[server] MatchLog 저장 (seed+selectData+inputLog = 재현 3종세트)
   │  하프타임: 전반 요약 → web 개입창 → 갱신 TacticalInput 델타 → 후반 재개(좌표·속도·시드 연속)
   ▼
[web] PixiJS 좌표 보간 재생(부드러운 움직임) + 이벤트 커멘터리(배속). 관전 중 개입=로컬 초안만.
```

### 1.3 서버/클라 책임 (PRD §12 PvP-ready)
| 책임 | 위치 |
|------|------|
| 공간 시뮬 실행·시드 발급·상태 진행 | **server(권위)** |
| AI 호출·스키마 검증·클램프·폴백 | **server** |
| 결정론 공간 코어(runMatch) | **engine(순수, 고정소수)** |
| 직렬화 계약(타입 원천) | **shared** |
| 좌표 재생·개입 UI·상태머신 | **web** |

---

## 2. `packages/engine` 결정론 공간 코어 설계 (Tier B)

### 2.1 핵심 모듈 (PRD §7-2)
- `config.ts` — **`EngineConfig` (모든 튜닝 값 격리, PRD §7-6)**: `msPerTick`(1000), 피치 치수, 좌표 모드(`continuous`|`grid`+`gridSize`), 인식 반경, decision 가중치, contest 확률 계수, 소프트캡·체력 감가율, 고정소수 스케일, 포메이션 정의. 로직은 config 를 읽을 뿐 magic number 하드코딩 금지. `version` 필드로 태깅(재현 번들 포함).
- `rng.ts` — 시드 PRNG(mulberry32/xorshift). 전역·`Math.random` 불가, 인스턴스 관통.
- `fixedmath.ts` — 위치·속도·거리·각도를 **정수 스케일 고정소수**로 계산(부동소수 비결정 격리). 이게 Tier B 결정론의 핵심.
- `pitch.ts` — 좌표계(정규화 105×68), 구역·거리·각도·라인 유틸.
- `ball.ts` — 공 이동(패스/슛 궤적·감속), 소유 상태.
- `perception.ts` — 선수별 주변 인식(근접 동료/상대, 공간, 압박도, 패스 옵션 후보).
- `decision.ts` — 행동 선택 정책. 볼 소유자 {슛/패스/드리블/홀드}, 오프더볼 {역할위치 이동 + 침투런(forwardRunFreq) + 폭(widthTendency)}, 수비 {라인/마크/압박(pressAggression·triggerLine)/커버}. **선택 = [속성 + behavior 파라미터 + ctx]의 시드 고정 가중 확률.**
- `contest.ts` — 볼 경합·태클·인터셉트·슛→xG→득점 판정(능력치 대결 확률화, ESMS/xG 참고).
- `events.ts` — MatchEvent 유니언(KickOff/Pass/Interception/Tackle/Shot/Goal/Card/Sub/Whistle) + 틱별 좌표 스냅샷.
- `hash.ts` — 틱 state hash(FNV-1a), desync·재현 검증.
- `match.ts` — `runFirstHalf` / `resumeSecondHalf`. 하프타임 델타 후 **전반 종료 좌표·속도·스코어·RNG 상태 이어받아** 후반 재개.

### 2.2 재현 계약
- `seed` 를 `TacticalInput` 일부로 고정 + 동일 RNG + fixed-point → 같은 서버·같은 인풋=같은 경기.
- **재현 3종세트 = `(seed + selectData + inputLog)`**. server 없이 engine headless 100% 동일 재생.
- **결정: 단일 RNG 스트림 + 골든 스냅샷 잠금**. fork 는 필요 시.

### 2.3 틱 루프 의사코드 (PRD §7-3)
```
function runTick(rng, state, inputs):
  updateBall(state.ball)                        // fixed-point 궤적·감속
  for p in state.players (22):
     ctx = perceive(p, state)
     action = decide(rng, p, ctx, inputOf(p, inputs))   // 속성 + behavior 가중 확률
     apply(p, action, state)                    // 이동/패스개시/슛/압박
  resolveContests(rng, state)                   // 경합·태클·인터셉트·슛→xG→득점
  applyFatigue(state)                           // 소프트캡: 극단 behavior 페널티
  emitEvents(state); state.hash = hash(state)
```
접합: `behavior.{forwardRunFreq,widthTendency,basePosition}` → 오프더볼 이동 좌표. "풀백 올라가라" = x좌표 상승 + 오버랩 런. `team.{defensiveLineHeight,pressingScheme}` → 수비 라인·압박 좌표. 소프트캡 = 전원 침투 시 뒤 공간 노출 → 역습 실점↑.

### 2.4 테스트 전략
1. **골든 테스트**: 고정 `(seed,inputA,selectFixture)` → MatchLog(좌표 포함) 스냅샷 바이트 동일.
2. **크로스-런 재현**: 같은 3종세트 N회 → 모든 tick hash 동일(desync 0).
3. **고정소수 회귀**: 누적 순서·경로 바뀌어도 결과 불변.
4. **움직임 성립성(정성, 디버그 뷰어)**: 2D 뷰어로 "선수가 바보짓 안 하고 축구처럼 움직이나" 육안 확인 — Tier B 새 게이트.
5. **프롬프트→움직임 계측**: 특정 선수 behavior(예: 풀백 forwardRunFreq 0→1) 변경 시 그 선수 평균 x좌표·터치맵이 유의미하게 전진하는지 수치 검증(§0 명제-①·② 증빙).
6. **밸런스 매트릭스(headless)**: 전략×상대×시드 배치 → 승률·xG 분포 + "가위바위보 성립".

---

## 3. AI 인풋 파이프라인 (프롬프트→행동 파라미터)

### 3.1 단계 (PRD §6)
```
프롬프트 UI(web) ─OPEN커밋→ server /prematch
  → 컨텍스트: {선수별 자연어, 프리셋칩, 라인업/포메이션, 선수 raw속성, 상대 포메이션/전술요약}
  → Claude(Sonnet) tool-use: emit_tactical_input(schema=TacticalInput 행동파라미터) 강제
  → zod 검증 ─실패→ 1회 재요청 ─실패→ 역할 프리셋 기본값 폴백
  → 범위 클램프 → seed 주입 → engine
하프타임: team·players[].behavior·basePosition·교체 델타만(시드·경기상태 연속)
```
### 3.2 밸런스 반영 (PRD §6-3)
- **선수 종속성**: 컨텍스트에 선수 raw속성 필수(느린 풀백 오버랩=역습 리스크). LLM 가이드 + 엔진 소프트캡 이중.
- **상대 종속성**: 상대 포메이션/전술 포함 → 상성.
- **소프트캡·노이즈**: AI 는 파라미터만, 페널티·노이즈는 engine 결정론 구간.
### 3.3 캐싱·예산
- 경기당 ≤2회 × 양팀. vs AI 감독도 동일 파이프라인.
- **CI/결정론 테스트는 Claude 호출을 고정 fixture 스텁으로** 대체(engine 을 AI 비결정성과 분리).

---

## 4. 렌더 / UX (PixiJS 실좌표 재생 + 상태머신)

- **상태머신 5-상태**: `PreMatchSetup(OPEN)→FirstHalf(LOCKED)→HalfTime(OPEN)→SecondHalf(LOCKED)→FullTime`. 커밋은 OPEN만.
- **디버그 뷰어(M1, dev tool)**: MatchLog 좌표를 최소 2D 로 그려 엔진 움직임 검증. 정식 UX 이전 단계.
- **정식 재생(M5)**: PixiJS v8, 틱별 좌표 보간 → 부드러운 움직임 + 공 궤적 + 이벤트 하이라이트/커멘터리. 배속 즉시/1x/2x.
- **개입 창**: 폰=세로 스텝 위저드(요약→교체→프롬프트), 데스크탑=3분할 대시보드. 프리셋 칩 8종(tactics §5). PoC 절감: 히트맵은 스탯 요약 대체 가능.

---

## 5. 마일스톤 순서 (리스크 우선)

| # | 마일스톤 | 증명할 것 | 형태 |
|---|----------|-----------|------|
| **M1** | 공간 엔진 골격 + 디버그 뷰어 | 22 에이전트가 축구처럼 움직인다(정성) + 동일입력=동일출력(골든/hash) | engine + 최소 2D 뷰어 |
| **M2** | AI 파이프라인(프롬프트→행동 파라미터) | 자연어(위치·움직임 포함)가 파라미터로 정확·안정 변환 + 폴백 견고 | server |
| **M3** | 프롬프트→움직임→결과 유의미성 + 밸런스(M1+M2) | 위치 지시가 실제 다른 움직임·결과 + 단일최적 비수렴(가위바위보) = §0 증명 | headless 배치 + 뷰어 |
| **M4** | 상태머신 + 경기 1건 완주 | 경기전→전반→하프타임 재주입(좌표·시드 연속)→후반→종료 | server+web 최소 |
| **M5** | PixiJS 실좌표 재생 + 개입 UI + 반응형 | 부드러운 움직임 관전·커멘터리·개입·배속·폰/데스크탑 | web |

M1→M2→M3 = 핵심 리스크(움직임 성립성 + 프롬프트 유의미성). **M1 에서 움직임이 안 그럴듯하거나 M3 에서 위치 지시가 결과를 못 가르면 = 가장 값싼 시점의 실패** → decision 정책·behavior 매핑·소프트캡 재설계.

---

## 6. 에픽 분해 제안 (vertical slice = sub-issue 후보)

> 다음 `/epic-flow decompose` 입력. 리스크 우선.

### S1 — 공간 결정론 엔진 코어 + 디버그 뷰어 (최우선·최대 비중)
- **owned-glob**: `packages/engine/**`, `packages/engine/test/**`, `packages/engine/dev-viewer/**`
- **의존성**: 없음(그린필드 진입점)
- **핵심 AC**:
  - `runMatch(...)` 1초 틱 90분 완주, MatchLog(틱별 좌표+이벤트) 산출.
  - **재현**: 동일 3종세트 100회 → 모든 tick hash 동일(desync 0) + 골든 바이트 일치.
  - **결정론 위생**: `Math.random`·`Date.now` grep 0, 위치/속도 fixed-point.
  - **Config 격리**: 틱 해상도·좌표 모드·범위·계수가 전부 `EngineConfig` 로 빠져 있고 로직에 magic number 하드코딩 0(리뷰), `version` 태깅되어 재현 번들에 포함.
  - **움직임 성립성**: 디버그 뷰어로 1경기 재생 시 (i) 공 소유 이동, (ii) 오프더볼 전개, (iii) 수비 라인 유지가 육안으로 축구스러움(정성 체크리스트 + 스크린샷 증빙).

### S2 — 직렬화 계약 (shared 행동 파라미터 스키마)
- **owned-glob**: `packages/shared/**`
- **의존성**: 없음(S1과 병렬/선행)
- **핵심 AC**: `TacticalInput`(team + players[].behavior + basePosition + seed) / `SelectData` / `MatchLog`(틱 좌표 스냅샷 포함) zod 스키마 + 타입. round-trip 직렬화 무손실. 클램프 유틸 단위테스트.

### S3 — AI 인풋 파이프라인 (프롬프트→행동 파라미터)
- **owned-glob**: `packages/server/src/ai/**`, `packages/server/test/ai/**`
- **의존성**: S2, S1
- **핵심 AC**: Claude tool-use `emit_tactical_input` 강제 → 유효 TacticalInput. 위반→재요청→프리셋 폴백 3분기 커버. **위치·움직임 프롬프트가 해당 파라미터에 반영**(예: "풀백 올라가라" → 그 선수 forwardRunFreq·widthTendency·basePosition.x 상승, 스냅샷 비교). 선수/상대 컨텍스트 종속성. CI 는 스텁 fixture.

### S4 — 프롬프트→움직임→결과 유의미성 + 밸런스 리포트 (§0, Go/No-Go)
- **owned-glob**: `packages/server/src/balance/**` 또는 `tools/balance-sim/**`
- **의존성**: S1, S3
- **핵심 AC**:
  - **움직임 유의미성**: 특정 선수 behavior 변경 → 그 선수 평균 x좌표/터치맵이 방향대로 유의미 이동(수치).
  - **밸런스**: 전략(≥4)×상대(≥4)×시드(≥50) → 승률/xG 표, **어떤 단일 전략도 전 상대 우세 아님(가위바위보) + 방향성 납득**(하이라인이 느린팀 상대 유리 등). = PoC go/no-go 게이트.

### S5 — 매치 세션 오케스트레이션 + 상태머신
- **owned-glob**: `packages/server/src/match/**`, `apps/web/src/state/**`, `packages/server/test/match/**`
- **의존성**: S1, S3
- **핵심 AC**: 5-상태 진행. 하프타임 델타가 **전반 종료 좌표·속도·RNG 상태 이어받아** 후반 재개(연속 vs 통짜 90분 동일성 테스트). 커밋은 OPEN만(LOCKED 커밋 거부 테스트).

### S6 — PixiJS 실좌표 재생 + 개입 UI + 반응형
- **owned-glob**: `apps/web/src/{render,ui,intervention}/**`
- **의존성**: S5
- **핵심 AC**: MatchLog 틱 좌표 → **부드러운 2D 움직임 재생** + 공 궤적 + 이벤트 커멘터리 + 배속. 프리셋 칩 8종. 폰(위저드)·데스크탑(3분할) 반응형. 경기전·하프타임 개입 커밋→서버 재주입 E2E 1경기 시연.

**의존 그래프**: `S2→S1→{S3,S5}`, `{S1,S3}→S4`, `S5→S6`. 크리티컬 패스 = **S1→S3→S4**. Wave: **W1 S1·S2 → W2 S3·S5 → W3 S4·S6**.

---

## 7. 핵심 리스크 & 미결정 (Tier B)

| # | 리스크/미결정 | 검증/결정할 것 | 슬라이스 |
|---|----------------|----------------|----------|
| R1 | **에이전트 움직임 성립성** (Tier B 새 최대 리스크) | 축소 decision 정책만으로 "축구처럼" 움직이나 — 디버그 뷰어 정성 + 지표 | S1 |
| R2 | **위치 프롬프트→움직임→결과 유의미성** | 위치 지시가 실제 다른 움직임·다른 결과, 단일최적 비수렴 | S3, S4 |
| R3 | **고정소수 결정론** | fixed-point 위치·속도로 부동소수 발산 차단, 골든/hash 동일 | S1 |
| R4 | 하프타임 좌표·시드 연속 재개 | resume 재현(연속 vs 통짜 동일성) | S5 |
| R5 | 프롬프트→행동 파라미터 변환 정확·안정 | tool-use 강제+재요청+폴백, 위치어휘 매핑 | S3 |
| R6 | decision/soft-cap 튜닝 | S1↔S4 루프로 움직임·밸런스 반복 튜닝(결정론 유지) | S1↔S4 |
| R7(미결정) | 틱 해상도 1초 적정성 | 1초로 시작, 움직임 거칠면 0.5초 조정(성능 여유 충분) | S1 |
| R8(미결정) | 좌표 연속 vs 코어스 그리드 | 연속 2D + fixed-point 로 시작(표현력), 성능 이슈 시 그리드 | S1 |
| R9(미결정) | seed uint64 JS 표현 | BigInt or 2×uint32 | S2 |

**Go/No-Go 게이트 = S1(R1 움직임 성립) → S4(R2 유의미성)**. 여기서 막히면 M5(정식 렌더) 전에 decision 정책·behavior 매핑·소프트캡을 재설계한다. 이것이 리스크 우선 + 디버그 뷰어 조기 도입의 목적이다.

---

## 다음 액션
이 계획을 `/epic-flow` 구현 에픽 입력으로: S1~S6 을 sub-issue 로 분해. **S1(공간 엔진+뷰어)이 최대 비중·최우선**, S4(Go/No-Go)가 검증 게이트.
