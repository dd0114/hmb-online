# HMB 온라인 — Phase 1 PoC 구현 계획 (PLAN-phase1)

> 근거: `docs/PRD.md` §5·§6·§7·§8·§9·§11·§12, `research/match-engine.md` §2·§3·§5, `research/_synthesis.md` 연결1~5, `research/tactics-instructions.md` §5(프리셋 8종).
> 성격: 리스크 우선(risk-first) vertical-slice 분해. 이 문서는 `/epic-flow decompose`(구현 에픽) 의 입력이다.
> 리포 상태: `hmb-online` 에 아직 코드 없음(docs/research만) — 그린필드.

---

## 0. 이 PoC가 증명해야 하는 단 하나의 명제

> **"자연어 프롬프트 전략을 바꾸면, 결정론 엔진의 결과가 서로 다르되 납득 가능하게 바뀌고, 어느 한 프롬프트로 수렴(dominant strategy)하지 않는다."** (PRD §6-3, §12)

기술 성립성(결정론·재현·렌더)은 이 명제의 **필요조건**일 뿐. 마일스톤은 "가장 불확실한 것 = 프롬프트→계수 변환의 유의미성·밸런스 수렴"을 **가장 빨리 관측 가능한 형태**로 끌어오도록 배열한다. 렌더/반응형 UX는 명제와 독립이므로 뒤로 민다.

---

## 1. 아키텍처 개요

### 1.1 모노레포 패키지 경계 (PRD §11)

```
hmb-online/
├─ packages/
│  ├─ engine/     # 순수 결정론 코어. 프레임워크·IO·시간·전역난수 의존 0.
│  │              # 입력:(TacticalInput 양팀 + SelectData) → 출력:MatchLog(이벤트 시계열)
│  │              # Math.random 금지, Date.now 금지, 부동소수 비결정 격리.
│  ├─ shared/     # 직렬화 계약(zod): TacticalInput, SelectData, MatchLog, PlayerCard.
│  │              # engine·server·web 공유 "네트워크 페이로드 = 타입 원천".
│  └─ server/     # 권위. AI 오케스트레이션(Claude) + engine 실행 + 재생 러너.
│                 # 프롬프트→TacticalInput 변환, 검증/클램프/폴백, 시드 발급.
└─ apps/
   └─ web/        # TS+React(상태머신·개입 UI) + PixiJS v8(2D 피치). 결과 "재생"만.
```

**의존 방향(단방향)**: `web → server → engine`, 그리고 모두 `→ shared`. `engine` 은 `shared` 타입만 알고 위쪽을 모른다 → headless 재현·테스트·향후 Rust 포팅의 핵심.

### 1.2 데이터 흐름 (PRD §5 방식1)

```
[web] 프롬프트 UI (선수별 자연어 + 프리셋 칩 8종 + 라인업/포메이션)
   │  POST /match/prematch {prompts,lineup,presets}   ← OPEN 커밋 = freeze
   ▼
[server] AI 파이프라인
   │  (프롬프트 + 선수 raw속성 + 상대 라인업) → Claude(Sonnet, tool-use JSON강제)
   │  → TacticalInput(JSON) → zod 검증 → 클램프 → (위반 시 1회 재요청 → 프리셋 폴백)
   │  → seed 발급(서버 권위)
   ▼
[engine] runMatch(seed, homeInput, awayInput, selectData)  [순수·결정론]
   │  ESMS식: 능력치→팀총합→전술곱셈계수→분/포제션 확률 이벤트 → MatchLog{events,score,stateHashes}
   ▼
[server] MatchLog 저장 (seed+selectData+inputLog = 재현 3종세트)
   │  하프타임: 전반 요약 → web 개입창(OPEN) → 갱신 TacticalInput 델타 → 후반 재개(시드 연속)
   ▼
[web] PixiJS 좌표 보간 재생 + 텍스트 커멘터리 (배속). 관전 중 개입=로컬 초안 버퍼만.
```

### 1.3 서버/클라 책임 분할 (PRD §12 PvP-ready)

| 책임 | 위치 | 근거 |
|------|------|------|
| 시뮬 실행·시드 발급·상태 진행 | **server(권위)** | PvP-ready ①: 싱글에서도 클라 계산 금지 |
| AI 호출·스키마 검증·클램프·폴백 | **server** | PRD §6-1·§11 |
| 결정론 코어(runMatch) | **engine(순수)** | headless 재현·Rust 포팅 |
| 직렬화 계약(타입 원천) | **shared** | PvP-ready ④: TacticalInput=네트워크 페이로드 |
| 결과 재생·개입 UI·상태머신 | **web** | 클라는 재생만 |

---

## 2. `packages/engine` 결정론 코어 설계

### 2.1 핵심 모듈
- `rng.ts` — 시드 PRNG **mulberry32/xorshift128**. 32-bit 상태, `next()/nextInt(n)/fork(label)`. 전역·`Math.random` 불가 — RNG 인스턴스를 인자로 관통.
- `ratings.ts` — 선수 raw(기술/정신/신체) + `weights`(곱셈 계수) + 포지션 → **팀 3대 총합(Tk/Ps/Sh)** (ESMS §2-2).
- `sim.ts` — 분/포제션 이벤트 루프(§2.3). 매 분 공격총합 비교→찬스 귀속→슛→xG→시드고정 득점.
- `events.ts` — `MatchEvent` 유니언(KickOff/Possession/Chance/Shot/Goal/Interception/Card/Sub/HalfWhistle/FullWhistle).
- `match.ts` — `runFirstHalf` / `resumeSecondHalf`. 하프타임 델타 주입 후 **전반 RNG 상태·스코어 이어받아** 후반 재개.
- `hash.ts` — state hash(FNV-1a). 재현·desync 탐지.
- `fixedmath.ts` — 부동소수 비결정 격리. 계수 곱·누적은 **정수 스케일(×1000 고정소수)** 후 경계에서만 실수화.

### 2.2 시드 PRNG & 재현 계약
- 서버가 매치 시작 시 `seed` 발급 → `TacticalInput.seed` 에 인풋 일부로 고정.
- **재현 3종세트 = `(seed + selectData + inputLog)`**. `inputLog`=[경기전 TacticalInput, 하프타임 델타]. server 없이 engine headless로 100% 동일 MatchLog 재생성.
- **결정: 단일 스트림 순차 소비 + 골든 스냅샷 잠금**(단순성 우선). fork는 필요 시 도입.

### 2.3 ESMS식 이벤트 루프 의사코드
```
function runHalf(rng, home, away, select, startMinute, endMinute, carryState):
  state = carryState ?? initState(home, away)
  Hagg = teamTotals(home.lineup, home.input.weights, select)   // {Tk,Ps,Sh}
  Aagg = teamTotals(away.lineup, away.input.weights, select)
  Hmod = mentalityMod(home.input.team); Amod = mentalityMod(away.input.team)
  log = []
  for minute in [startMinute .. endMinute):
     if rng.next() < chanceRate(Hagg, Aagg, Hmod, Amod):
        atk = weightedPick(rng, Hagg.Ps*Hmod.attack, Aagg.Ps*Amod.attack); def = other(atk)
        if rng.next() < breakThrough(atk.Ps, def.Tk, riskOf(atk)):
           xg = shotQuality(atk.Sh, def.gk, atk.input.mentality)
           log.push(Shot{minute,atk,xg})
           if rng.next() < xg: log.push(Goal{minute,atk}); state.score[atk]++
        else: log.push(Interception{minute,def})
     applyFatigue(state, Hmod, Amod)   // 소프트캡: 극단계수 페널티(밸런스 §6-3-3)
  state.rngSnapshot = rng.serialize()   // 후반 재개용
  return {log, state}
```
접합: `weights.{attack,defend,press,risk,..}` = `teamTotals` 곱셈 계수. `team.{mentality,tempo,lineHeight,pressingIntensity}` = `chanceRate/riskOf/applyFatigue` 스칼라. 소프트캡 = "단일 최적 프롬프트" 방지의 엔진측 착지점.

### 2.4 테스트 전략
1. **골든 테스트**: 고정 `(seed,inputA,selectFixture)` → MatchLog 스냅샷 바이트 동일(결정론 1차 게이트).
2. **크로스-런 재현**: 같은 3종세트 N회 → 모든 stateHash 동일(desync 0).
3. **부동소수 회귀**: 누적 순서 바꿔도 결과 불변(fixedmath 검증).
4. **밸런스 계측 하니스(headless)**: 프롬프트 전략 × 상대 매트릭스 × 다수 시드 배치 → 승률·xG 분포표. "어느 전략도 압도적 아님(가위바위보)" 수치 관측 = §0 증빙.

---

## 3. AI 인풋 파이프라인

### 3.1 단계 (PRD §6)
```
프롬프트 UI(web) ─OPEN커밋→ server /prematch
  → 컨텍스트 조립: {선수별 자연어, 프리셋칩, 라인업, 선수 raw속성, 상대 라인업/전술요약}
  → Claude(Sonnet) tool-use: emit_tactical_input(schema=TacticalInput) 강제
  → zod 검증 ─실패→ 1회 재요청 ─실패→ 프리셋 기본 TacticalInput 폴백
  → 범위 클램프 → seed 주입 → engine
하프타임: 동일, team·players[].weights 델타만(시드 연속)
```
### 3.2 밸런스 반영 지점 (PRD §6-3)
- **선수 종속성**: 컨텍스트에 선수 raw속성 필수 → 같은 지시도 선수별 다른 계수(+엔진 소프트캡 이중 방어).
- **상대 종속성**: 상대 라인업/전술요약 포함 → 상성.
- **소프트캡+노이즈**: AI는 계수만, 페널티·노이즈는 engine 결정론 구간(재현 유지).
### 3.3 캐싱·예산
- 경기당 ≤2회(경기전+하프타임)×양팀. vs AI 감독 상대도 동일 파이프라인.
- **CI/결정론 테스트는 Claude 호출을 고정 fixture 스텁으로 대체**(engine 테스트를 AI 비결정성과 분리).

---

## 4. 렌더 / UX (PixiJS + 상태머신)

- **상태머신 5-상태**: `PreMatchSetup(OPEN)→FirstHalf(LOCKED)→HalfTime(OPEN)→SecondHalf(LOCKED)→FullTime`. 커밋은 OPEN만, 타이머 만료=freeze, LOCKED 초안은 로컬만.
- **렌더**: PixiJS v8 2D 탑다운. **엔진은 좌표 미산출** → web 경량 보간 레이어(MatchEvent→최소 도트 이동+커멘터리). 배속 즉시/1x/2x.
- **개입 창**: 폰=세로 스텝 위저드(요약→교체→프롬프트), 데스크탑=3분할 대시보드. 프리셋 칩 8종(tactics §5). PoC 절감: 하프타임 스텝 분리는 폰 위저드로 최소, 히트맵은 스탯 요약으로 대체.

---

## 5. 마일스톤 순서 (리스크 우선)

| # | 마일스톤 | 증명할 것 | 형태 |
|---|----------|-----------|------|
| **M1** | 결정론 엔진 골격 + 계측 하니스 | 계수가 결과를 유의미하게 흔든다 + 동일입력=동일출력(골든) | headless |
| **M2** | AI 파이프라인(프롬프트→TacticalInput) | 자연어→계수 정확·안정 변환 + 스키마/폴백 견고 | server |
| **M3** | 밸런스 수렴 검증(M1+M2) | 전략 매트릭스 가위바위보 성립(단일 최적 없음) = §0 증명 | headless 배치 |
| **M4** | 상태머신 + 경기 1건 완주 | 경기전→전반→하프타임 재주입(시드 연속)→후반→종료 | server+web 최소 |
| **M5** | PixiJS 2D 재생 + 개입 UI + 반응형 | 관전·커멘터리·개입·배속·폰/데스크탑 | web |

M1→M2→M3 = 핵심 리스크 구간(전부 headless 조기 관측). **M3에서 밸런스가 수렴하면(단일 최적 발견) = 가장 값싼 시점의 실패 신호** → M5 전에 계수/소프트캡 재설계.

---

## 6. 에픽 분해 제안 (vertical slice = sub-issue 후보)

> 다음 `/epic-flow decompose` 입력. 리스크 우선 정렬.

### S1 — 결정론 엔진 코어 + 계측 하니스 (최우선)
- **owned-glob**: `packages/engine/**`, `packages/engine/test/**`
- **의존성**: 없음(그린필드 진입점)
- **AC**: `runMatch(...)` 90분 완주 / 동일 3종세트 100회 → stateHash 전부 동일(desync 0)+골든 바이트 일치 / 극단 계수 두 입력의 xG·스코어 분포 유의미 차이(리포트) / `Math.random`·`Date.now` grep 0

### S2 — 직렬화 계약 (shared 스키마)
- **owned-glob**: `packages/shared/**`
- **의존성**: 없음(S1과 병렬 또는 S1 앞 half-step)
- **AC**: `TacticalInput`/`SelectData`/`MatchLog` zod 스키마+타입 / round-trip 직렬화 무손실 테스트 / 클램프 유틸 단위테스트

### S3 — AI 인풋 파이프라인 (프롬프트→TacticalInput)
- **owned-glob**: `packages/server/src/ai/**`, `packages/server/test/ai/**`
- **의존성**: S2, S1
- **AC**: Claude tool-use `emit_tactical_input` 강제→유효 TacticalInput / 위반→재요청→폴백 3분기 커버 / 선수·상대 컨텍스트 바꾸면 같은 프롬프트도 다른 weights(스냅샷) / CI는 스텁 fixture

### S4 — 밸런스 수렴 검증 리포트 (§0 명제, Go/No-Go 게이트)
- **owned-glob**: `packages/server/src/balance/**` 또는 `tools/balance-sim/**`
- **의존성**: S1, S3
- **AC**: 전략(≥4)×상대(≥4)×시드(≥50) 배치 → 승률/xG 표 / **어떤 단일 전략도 전 상대 우세 아님(가위바위보) + 방향성 납득**(High Press가 느린팀 상대 우세 등)

### S5 — 매치 세션 오케스트레이션 + 상태머신
- **owned-glob**: `packages/server/src/match/**`, `apps/web/src/state/**`, `packages/server/test/match/**`
- **의존성**: S1, S3
- **AC**: 5-상태 진행 / 하프타임 델타가 전반 RNG 상태 이어받아 후반 재개(연속 vs 통짜 90분 동일성 테스트) / 커밋은 OPEN만(LOCKED 커밋 거부 테스트)

### S6 — PixiJS 2D 재생 + 개입 UI + 반응형
- **owned-glob**: `apps/web/src/{render,ui,intervention}/**`
- **의존성**: S5
- **AC**: MatchLog→2D 도트 재생+커멘터리+배속 / 프리셋 칩 8종 / 폰(위저드)·데스크탑(3분할) 반응형 / 경기전·하프타임 개입 커밋→서버 재주입 E2E 1경기 시연

**의존 그래프**: `S2→S1→{S3,S5}`, `{S1,S3}→S4`, `S5→S6`. 크리티컬 패스 = **S1→S3→S4(리스크 게이트)**.

---

## 7. 핵심 리스크 & 미결정

| # | 리스크/미결정 | 검증/결정할 것 | 슬라이스 |
|---|----------------|----------------|----------|
| R1 | **프롬프트→계수 유의미성·밸런스 비수렴**(최대 리스크) | 전략 매트릭스 가위바위보 + 방향성 납득 | S4 |
| R2 | 프롬프트→계수 정확도·안정성 | tool-use 강제+재요청+폴백 견고, 선수/상대 종속성 | S3 |
| R3 | JS 부동소수 결정론 | fixedmath 정수 격리 + 골든/크로스런 stateHash 동일 | S1 |
| R4 | 하프타임 시드 연속 재개 | resume 재현 테스트(연속 vs 통짜 동일성) | S5 |
| R5 | 엔진 좌표 부재→렌더 접합 | 이벤트 로그→최소 도트+커멘터리 가독성 정성 확인 | S6 |
| R6 | soft-cap/노이즈 튜닝 | S4 리포트로 반복 튜닝(결정론 유지) | S1↔S4 |
| R7(미결정) | RNG 단일 스트림 vs fork | 단일+골든 잠금 시작, 필요 시 fork | S1 |
| R8(미결정) | seed uint64 JS 표현 | BigInt or 2×uint32 결정 | S2 |

**Go/No-Go 게이트 = S4(R1)**. 밸런스 수렴/비상식 시 M5(렌더) 착수 전 계수 모델·소프트캡 재설계.

---

## 다음 액션
이 계획을 `/epic-flow` 구현 에픽의 입력으로: S1~S6 을 sub-issue 로 분해. Wave 배치 = **W1: S1·S2(병렬) → W2: S3·S5 → W3: S4·S6**. S4(Go/No-Go)가 최우선 검증 게이트.
