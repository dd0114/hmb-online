# 엔진 리얼리즘 갭 분석 (E3 · Track α)

> **목적**: 현 엔진(`engine@0.10.0` = `defaultEngineConfig` 리얼 config)의 게임 양상을 실제 축구
> (`research/football-stats.md`, 주로 PL/Opta) + 축구게임 엔진(FM/ESMS 관례)과 대조해 **부족분 목록 +
> E1/E2 목표치**를 데이터로 확정한다(헛튜닝 방지). SoT 에픽 = GH #99 · 계획 SoT = `docs/PLAN-v2.1-features.md` §2.
>
> **방법**: 리얼 config 로 20개 고정 시드(90분) 시뮬 → 팀-경기(=시드×2) 평균 스탯을 벤치와 대조.
> 하니스 = `packages/engine/src/realism/harness.ts`(computeMatchStats 재사용 + 점유율·패스길이·xG 재구성).
> 재생성: `HMB_GEN_GAP=1 npx vitest run packages/engine/src/realism/gap-report.test.ts` → `engine-realism-gap.data.md`.
> 조사일: 2026-07-19 · lastHash `dda2d08e` (결정론 앵커).

---

## 1. 대조표 (리얼 config `engine@0.10.0`, 20 시드 · 팀-경기 40)

| 지표 (팀·경기) | 엔진 | ±SD | 벤치마크 | 판정 |
|---|---|---|---|---|
| **패스 성공률** | **85.99%** | 1.32 | 78–85% | **HIGH ▲0.99** |
| **롱패스 비율(≥30m, 재구성)** | 22.58% | 1.42 | 12–15% (명시적 롱패스 = **0**) | **GAP (아래 §2-E2)** |
| 점유율 | 50.0% | 1.85 | 30–65% (대칭→~50) | OK |
| **슛(시도)** | **19.5** | 5.3 | 12–14 | **HIGH ▲5.5** |
| **유효슛** | **8.75** | 3.58 | 4.5–5.5 | **HIGH ▲3.25** |
| 유효슛 비율 | 45.2% | 13.2 | 45–50% | OK |
| **골** | **2.6** | 1.76 | 1.4–1.65 | **HIGH ▲0.95** |
| 슛→골 전환 | 13.75% | 9.6 | 10–12% | HIGH ▲1.75 |
| 슛당 xG | 0.13 | 0.02 | 0.10–0.12 | HIGH ▲0.01 |
| 코너 | 6.95 | 3.18 | 4–6 | HIGH ▲0.95 |
| 스로인 | 14.88 | 3.66 | 17–19 | LOW ▼2.12 |
| 파울 | 10.93 | 2.8 | 11–12 | LOW ▼0.07 (≈OK) |
| 오프사이드 | 1.68 | 1.19 | 1–3 | OK |
| 옐로카드 | 1.8 | 1.29 | 1.8–2 | OK |
| 팀 width | 49.35m | 0.4 | 40–50m | OK |
| 팀 length | 39.63m | 0.6 | 25–40m | OK |
| 주행거리 | 10.27km | 0.19 | 10–12km | OK |

- **골(양팀/경기)**: 5.2 (벤치 ~2.7–3.3).
- **패스 길이 분포(팀·경기 평균, 소유권 이전 재구성)**: short <15m **20.3%** · medium 15–30m **57.1%** · long ≥30m **22.6%**.

### 판정 요약
- **이미 정합(OK)**: 점유율·팀 shape(width/length)·주행거리·유효슛 비율·오프사이드·카드. (0.2.0~0.9.0 재튜닝 성과 유지.)
- **HIGH(과함)**: 패스 성공률(경미) · **슛/유효슛/골(크게)** · 코너·xG(경미).
- **LOW(부족)**: 스로인(경미).
- **구조적 갭(모델 없음)**: **명시적 롱패스/롱킥 액션 부재** — 현 롱거리 볼 이동(≥30m 22%)은 근접 리시버 패스+턴오버·GK 배급이 섞인 부산물이지 "의도한 롱볼"이 아니다. FM/실축구의 다이렉트 플레이(전진 롱볼·GK 롱킥·수비 롱 클리어)가 없다.

---

## 2. 부족분 → 작업 매핑 & 목표치 (E1/E2 확정)

### E1 — 패스 정확도 하향 (mandated, config only) — ✅ 완료 (engine@0.11.0)
- **현상(0.10.0)**: 전체 패스 성공률 **85.99%** — 벤치 상한(85%) 초과.
- **근본원인(E1에서 발견)**: `resolveArrival` 이 계획된 `passOutcome`(computePassProb 롤)을 무시하고 **순수 기하(도착점 최근접 아무나)** 로 소유를 판정 → **실패 롤 패스도 의도 리시버가 우연히 되찾아 "완성"으로 집계**. 그래서 `passBase` 를 8pt 내려도 완성률이 거의 안 움직였다(0.84→0.76 = 86.0→85.3%). "패스 정확도 과다"의 진짜 원인.
- **수정**:
  1. `resolveArrival` 이 `passOutcome` 을 존중(`contest.passOutcomeAuthoritative`) — 성공 롤→동료, 실패 롤→상대 컨트롤. 실측 완성률 == 계획 확률 → **passBase/페널티가 성공률의 실제 노브가 됨**.
  2. 패스 압박은 근접만: `contest.passPressureRangeM`(6m) 신설 — 기존 `movement.pressRange`(22m, 압박 배정용)는 거의 모든 패스에 3~4명 적용돼 성공률을 광범위 하향(합성 프로브 91% vs 실경기 66%)했음.
  3. `computePassProb` 순수 함수 추출(planPass 가 호출) → 단조성 계약 단위테스트 가능.
- **최종 config**: passBase 0.84→**0.94** · passForwardPenalty 0.22→**0.20** · passFinalThirdPenalty 0.14→**0.12** · passPressurePenalty 0.05→**0.06**(범위 6m) · passFailOutProb 0.16→**0.45**(스로인 복원, 완성률엔 무관 — 실패의 out/intercept 분배만).
- **결과(0.11.0, 20시드)**: 패스 성공률 **79.3% (OK)** · 구조 short≈0.92 / **forward≈0.71** / **long≈0.44**(전진/롱 ≪ 숏, 벤치 정합) · 스로인 14.88→**19.9**(LOW 갭 개선) · **슛 20.1 / 골 2.68 (G-A 무회귀)**. 게이트: npm test 530 pass·desync0·golden 갱신·qa-match·perceptibility 6/6.
- **계약**: `packages/engine/src/realism/pass-accuracy.test.ts` — A) computePassProb 단조성(전진/롱<숏) B) 20시드 평균 78–85%(회귀 가드).

### E2 — 롱패스/롱킥 액션 추가 (mandated, 엔진 피처) — ✅ 완료 (engine@0.12.0)
- **현상(0.11.0)**: `Action = shoot|pass|dribble|hold`, 리시버는 perception 반경(33m) 내 근접만 → **의도적 롱볼 = 0**.
- **구현**:
  - `passOptions` 가 인식 반경 밖(**`longPass.minM`~`maxM`** = 30~55m)의 **전진** 동료를 롱볼 후보로 추가(`PassOption.long`). 전환/스루볼/다이렉트.
  - `scoreOption` 롱 분기: 원거리 롱볼의 큰 forwardGain 이 선택을 지배하지 않게 **`fwdCapM`**(22m) 캡 + **`distPenalty`**(0.22) 강화 → argmax 독점 방지, **`selectBias`**(6.0, ×passDirectness)로 시도율 튜닝.
  - 롱 성공률은 **별도 곡선 없이 `computePassProb` 거리 페널티**로 숏보다 낮음(합성 short≈0.95 vs long≈0.47).
  - `long` 플래그 관통: Action.pass → BallFlight.long → `resolveArrival` 이 **MatchEvent(pass/interception) `detail:"long"`** 방출 → 뷰어(β) 구분.
- **결과(0.12.0, 20시드)**: **의도적 롱패스 시도 비율 14.58% (OK, 벤치 12-15)** · 롱 성공 ≪ 숏 · 패스 성공률 79.78%(passBase 0.94→0.97 재보정으로 밴드 유지) · 스로인 16.5. 게이트: npm test 532 pass·desync0·golden 갱신·penalty-spot 시드(2→3)·qa-match·perceptibility 6/6.
- **shared 계약**: `MatchEvent.detail` 은 이미 free-form `z.string().optional()` → **스키마 변경 없음**. β(#100)엔 새 detail 값 `"long"` 통지만(프리즈 불필요).
- **주의(G-A 악화)**: 롱볼 전진 → 슛 **20.1→23.85**(팀당, 벤치 12-14 초과 심화), 골 2.68→2.88. **슛 과다(G-A)가 이제 최상위 잔여 갭** — 다음 서브태스크로 슛 트리거 하향 강력 권장.

### 백로그(프리오리티) — E1/E2 밖, #99 또는 후속 wave
| 우선 | 갭 | 데이터 | 방향(모두 config 우선) |
|---|---|---|---|
| **G-A (최상위)** | **슛/골 과다** — 슛 19.5(벤치 12–14) · 골 2.6(1.4–1.65) · 5.2골/경기(2.7–3.3) | 관전 재미 쇼케이스와 별개로 **리얼 config 가 실축구 스코어라인과 괴리**. hero ③ "얼마나 비슷한지"의 핵심 갭 | 슛 트리거 하향(`decisionWeights.shoot`·`shootXgThreshold`↑·`shootRange`↓) + `xgBase`(0.225) 미세 하향. **E1 패스실패↑ 반영 후 재계측**(턴오버가 슛수에 영향). 골든 대폭 이동 → 별도 서브태스크 권장 |
| G-B | 코너 경미 과다(6.95 vs 4–6) | 슛→코너 굴절률(`saveCornerProb`·`offTargetBlockCornerProb`) | 슛 하향(G-A)으로 동반 감소 가능 → G-A 후 재판정 |
| G-C | 스로인 부족(14.88 vs 17–19) | 사이드라인 아웃 빈도 | 낮은 우선. 폭 확장(49m)에도 아웃 적음 — 필요 시 아웃 판정 조정 |
| G-D | 다이렉트/템포 변주 | 템포·모멘텀 반영 약함(계획 §2 초안 ④) | E2(롱볼) + 팀 tempo 연동으로 부분 흡수. 별도 백로그 |

- **G-A 판단**: 슛/골 밸런스는 골든·config.version 을 크게 흔들고 E1 패스 튜닝과 상호작용(패스실패↑→소유전환↑→슛기회 변동). **E1 적용 후 재계측**해 남으면 별도 서브태스크로 처리(E1/E2 스코프 오염 방지).

---

## 3. 방법·한계 (재현/신뢰도)
- **표본**: 20 고정 시드 × 90분. 팀-경기 40 표본. SD 병기(슛/골은 분산 큼 — 시드 편차).
- **패스 성공률 정의**: `passCompleted / (passCompleted + interceptionsConceded + throwInConceded)` (match-stats 기존 정의). 실제 완결/시도 근사.
- **롱패스 재구성(≥30m)의 한계**: 소유권 이전(동팀) 시 공 비행거리로 근사 → **의도적 롱패스가 아닌** GK 배급·클리어 리커버리·근접패스 후 볼전개도 포함해 과대(22%). E2 는 "의도적 롱패스 액션 비율"을 별도 계측(패스 시도 대비)해 12–15% 를 판정한다.
- **점유율**: `ballOwner` 보유 틱의 팀 비율. 대칭 입력이라 ~50% (정상).
- 하니스 자체는 결정론(고정 시드) — 값 재현 가능. 엔진 동작 변경 시 이 문서 표 갱신 + config.version 범프(§6).
