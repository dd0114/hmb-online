# 매치 엔진 메커니즘 조사 (HMB 온라인 PRD - sub-A)

> 목적: HMB 온라인은 "AI 가 프롬프트로 인풋(전술/지시)을 만들고, 매치 시뮬 자체는 스태틱(결정론)하게 돌린다"는 구조를 지향한다. 이 문서는 기존 축구 시뮬 매치 엔진의 시간 진행 방식·능력치 판정 로직·결정론 처리·오픈소스 사례를 조사해 HMB 설계 시사점을 정리한다.
>
> 조사일: 2026-07-07 / 모든 주장에 출처 URL 부기.

---

## 1. 틱/이벤트 기반 시뮬 구조

축구 시뮬 매치 엔진은 "경기 시간을 어떤 단위로 전진시키고, 각 단위에서 무엇을 해상(resolve)하는가"에 따라 크게 세 계열로 나뉜다.

### 1-1. 초-단위(sub-second) 물리·행위자 시뮬 — Football Manager 계열

Football Manager(FM)의 매치 엔진은 **"slice(슬라이스)"** 라는 틱을 사용한다. 선수와 심판이 **0.25초(1/4초)마다 한 번씩** 자신의 주변 상황을 평가하고 최선이라 판단하는 행동을 수행한다. 즉 경기 90분은 대략 90×60×4 ≈ 2만 1600 슬라이스로 전진한다. 각 선수는 슬라이스 도중에도 상황 전개에 따라 원래 결정을 바꿀 수 있어(mid-slice re-decision) 동적인 흐름이 생긴다. ([footballmanagerguru](https://www.footballmanagerguru.com/how-football-manager-match-engine-works/), [Sports Interactive 커뮤니티](https://community.sports-interactive.com/forums/topic/301766-does-anyone-acyually-know-how-the-match-engine-works-under-the-hood-so-to-speak/))

- 경기 상태 표현: 공/선수의 위치, 속도, 스태미너, 심리(모럴) 등 연속값 상태를 매 슬라이스 갱신 → 사실상 **경량 물리 + 행위자(agent) 기반**.
- 결과는 미리 정해지지 않고, 각 액션(패스/태클/슛)이 선수 데이터·전술 지시·상황 맥락의 계산으로 매 슬라이스 산출된다. "the user/AI must win 같은 오버라이드는 없다". ([Sports Interactive 커뮤니티](https://community.sports-interactive.com/forums/topic/301766-does-anyone-acyually-know-how-the-match-engine-works-under-the-hood-so-to-speak/))

### 1-2. 분-단위(per-minute) 확률 이벤트 시뮬 — ESMS / Bygfoot 계열

텍스트 기반 매니지먼트 시뮬은 **경기를 분 단위(minute loop)** 로 전진시키며, 각 분마다 "찬스(chance)가 생기는가 → 어느 팀에게 → 득점으로 연결되는가"를 확률로 판정한다. 물리 시뮬 없이 팀 능력치 총합을 확률 가중치로 바꿔 이벤트를 뽑는 **이벤트 해상도 = 포제션/찬스 단위** 방식이다.

- ESMS: 매 분 팀 tackling/passing/shooting 총합을 비교해 공격 시도·찬스·슛을 판정한다(§2 상세). ([esmshub - What is ESMS](https://esmshub.com/what-is-esms/), [eliben/esms GitHub](https://github.com/eliben/esms))
- Bygfoot: C/GTK 기반, **텍스트 기반 매치 생성 엔진**으로 통계와 리포트를 재현하며 host 앱에 라이브러리로 통합 가능. ([Bygfoot 공식](https://bygfoot.sourceforge.io/new/))

### 1-3. 포제션-단위 / 트래킹데이터 기반 하이브리드

`openengine`(atas76)은 실제 경기 데이터를 **팀 포제션 단위로 분할**해 입력으로 쓰고, 선수를 "agent(AI+상대 능력치 값)"로 두어 output 을 생성한다. 최근 버전은 슛 시도를 **xG(expected goals)** 로 매핑해 결과에 분산을 준다 — "트래킹 데이터 기반 엔진에 가깝다"고 저자가 기술. ([atas76/openengine GitHub](https://github.com/atas76/openengine))

| 계열 | 시간 단위 | 이벤트 해상도 | 대표 |
|------|-----------|---------------|------|
| 물리/행위자 | 0.25초 slice | 개별 액션(패스·태클·슛) | Football Manager |
| 확률 이벤트 | 1분 | 찬스/슛 | ESMS, Bygfoot |
| 통계/트래킹 | 포제션 phase | 팀 이벤트 → xG | openengine |

---

## 2. 능력치 → 행동 결정 로직

### 2-1. FM: raw attribute + 맥락 평가

FM 엔진은 **스타 등급이 아니라 raw attribute·trait·맥락**을 평가한다. 속성은 세 축으로 작동한다: 기술(technical, 실행 품질) / 정신(mental, 판단·반응) / 신체(physical, 대결·스태미너). 전술은 결과를 직접 정하지 않고 "엔진이 평가할 상황을 만든다"(예: 하이프레스는 스태미너를 깎고, 포제션은 턴오버를 줄인다). ([footballmanagerguru](https://www.footballmanagerguru.com/how-football-manager-match-engine-works/))

대결(duel) 판정: 각 액션은 관련 속성 + 전술 지시 + 모럴 + 피치/날씨 등 다수 요인의 계산으로 확률화된다. 슈터 vs 골키퍼 같은 1:1도 이 계산에 포함된다. ([Sports Interactive 커뮤니티](https://community.sports-interactive.com/forums/topic/301766-does-anyone-acyually-know-how-the-match-engine-works-under-the-hood-so-to-speak/))

### 2-2. ESMS: 능력치 → 팀 총합(Team totals) → 확률

ESMS 는 능력치를 **팀 단위 3대 총합**으로 집계한 뒤 확률에 반영한다. ([esmshub](https://esmshub.com/what-is-esms/), [eliben/esms](https://github.com/eliben/esms))

- **Team tackling** — 상대 공격을 저지
- **Team passing** — 공격(찬스) 생성
- **Team shooting** — (a) 공격 생성에 부수 기여 + (b) 생성된 찬스를 득점으로 전환

집계 규칙:
- GK 를 제외한 각 필드 선수가 자신의 3대 주요 스킬(Tk 태클, Ps 패스, Sh 슛)로 세 총합에 기여한다.
- **전술은 선수 주요 스킬에 대한 곱셈 계수(multiplier)** 로 작동한다. 예: "P(Passing) 전술"에서 수비수의 패스 기여는 **×0.75**, 슛 기여는 **×0.3** 로 가중된다. 계수는 포지션별로 크게 다르며 `tactics.dat` 에 정의된다. (side/체력/포지션도 반영) ([eliben/esms admin manual](https://raw.githubusercontent.com/eliben/esms/master/html_docs/esms_admin_manual.pod))
- 매 분, 두 팀의 공격 총합을 비교해 찬스 귀속을 정하고, 슛 총합 대 상대 태클/GK 로 득점 여부를 판정한다.

핵심: **능력치가 곧바로 개별 물리 행동이 아니라, "확률 가중치"로 환산**된다는 점. 이는 HMB 처럼 인풋(전술 계수)만 바꾸고 시뮬은 결정론으로 돌리려는 구조와 궁합이 좋다.

### 2-3. 통계 모델: Poisson / xG 기반 득점 판정

능력치·팀 강도를 **기대 득점(goal expectancy)** 으로 바꾼 뒤 Poisson 분포로 스코어를 샘플링하는 계열도 널리 쓰인다. Maher(1982) 이래 양 팀 득점 수를 독립 Poisson 변수로 모델링하며, 기대 득점은 (팀 평균 득점 × 상대 평균 실점) ÷ 리그 평균 같은 식으로 산출한다. 다만 실제 축구는 무승부·고득점 빈도가 이론보다 커 "heavy tail" 보정이 필요하다. ([arxiv 2501.05873 - Forecasting Soccer through Distributions](https://arxiv.org/html/2501.05873v1))

---

## 3. 결정론·시드·정합성 처리

HMB 의 "AI 는 인풋만, 시뮬은 스태틱" 원칙은 결국 **결정론적 시뮬(deterministic simulation)** 요구로 귀결된다. 게임 네트워킹/락스텝 분야의 정립된 원리가 그대로 적용된다.

### 3-1. 결정론의 정의

결정론적 시뮬레이션이란 **"동일한 초기 상태 + 동일한 입력 시퀀스 → 항상 동일한 결과"** 를 의미한다. 이동·전투·자원·AI 등 모든 서브시스템이 어느 머신에서도 동일하게 동작해야 한다. ([daydreamsoft - Deterministic Simulation](https://www.daydreamsoft.com/blog/deterministic-simulation-for-lockstep-multiplayer-engines), [socratopia - Lockstep](https://www.socratopia.app/library/math-for-game-devs-en/chapter-30))

### 3-2. 난수 시드(seed) 정합성

확률 이벤트를 쓰면서도 결정론을 지키는 핵심은 **RNG(난수 생성기)와 시드의 통제**다. 모든 참여자(클라이언트/서버)가 **동일 RNG + 동일 시드**를 써야 한다 — 그렇지 않으면 "10% 드롭 확률" 같은 확률 이벤트가 한쪽에서만 발동해 desync 가 난다. ([daydreamsoft](https://www.daydreamsoft.com/blog/deterministic-simulation-for-lockstep-multiplayer-engines))

- **리플레이/검증 러너**: 초기 시드 + 선택 데이터 + 프레임별 입력 시퀀스만 저장하면 headless 재구성으로 경기를 그대로 재현하고, 비결정 지점을 flag 할 수 있다. ([daydreamsoft](https://www.daydreamsoft.com/blog/deterministic-simulation-for-lockstep-multiplayer-engines))
- **서버 권위(state hash) 검증**: 락스텝 P2P 에서도 서버가 100~500 틱마다 state hash 를 비교해 발산한 클라이언트를 탐지하는 하이브리드가 쓰인다. ([daydreamsoft](https://www.daydreamsoft.com/blog/deterministic-simulation-for-lockstep-multiplayer-engines))

### 3-3. FM 의 실제 사례 — "부분 결정론"

FM 은 반복 실행 시 모델의 결정론 성분을 분리하려고 **고정 시드**를 쓰지만, 게임플레이에는 의도적 확률(stochastic) 요소가 남아 있어 결과에 분산이 생긴다. 저장 게임에서 경기를 다시 돌리면(replay) 결과가 달라지되, 일부 결정론 요소는 유지된다(예: 그 경기에 부상은 발생하되 부상 선수는 매번 달라짐). ([mypassion4footballmanager](https://mypassion4footballmanager.com/fm-vs-real-football-results/))

> HMB 시사점: FM 은 "재미(예측불가)"를 위해 일부러 시드를 흔들지만, **HMB 는 반대로 "인풋이 같으면 결과도 같아야" 하므로 완전 결정론 + 명시 시드 저장이 요구된다.** 확률은 쓰되 시드를 인풋의 일부로 고정해야 한다.

---

## 4. 오픈소스 축구 엔진 사례

| 엔진 | 링크 | 언어/방식 | 한계 |
|------|------|-----------|------|
| **ESMS** (Electronic Soccer Management Simulator) | [github.com/eliben/esms](https://github.com/eliben/esms) | C++/Perl. 분 단위 확률 이벤트. 팀 Tk/Ps/Sh 총합 + tactics.dat 곱셈 계수 → 찬스/슛 판정 | 아카이브(유지보수 종료), 물리 없음, 텍스트 결과만 |
| **Bygfoot** | [bygfoot.sourceforge.io/new](https://bygfoot.sourceforge.io/new/) · [SourceForge](https://sourceforge.net/projects/bygfoot/files/bygfoot/bygfoot-2.2.1/) | C/GTK2. 텍스트 기반 매치 생성 엔진, host 앱에 라이브러리 통합 가능 | 내부 확률식 문서화 빈약, 구식 GTK2, GitLab 이전 |
| **open-football** (ZOXEXIVO) | [github.com/ZOXEXIVO/open-football](https://github.com/ZOXEXIVO/open-football) | 순수 Rust, 단일 바이너리. 엔진이 경기 자동 해상("resolved by engine, not user input"), 이적/재정/평판까지 다년 생태계 시뮬 | 매치 틱/시드 세부는 공개 문서에 미기재, 개별 경기 조작 비지향 |
| **openengine** (atas76) | [github.com/atas76/openengine](https://github.com/atas76/openengine) | Java. 데이터드리븐, 포제션 단위 입력 + agent 속성 → 팀 이벤트 output, 슛→xG 매핑 | 실험적/미완성, 실경기 데이터 의존, 팀 레벨 추상 output |
| **SimpleFootie** (atas76) | [github.com/atas76/SimpleFootie](https://github.com/atas76/SimpleFootie) | Java. 경량 축구 경기 시뮬 | 소규모/데모 성격 |

(추가 상용 참고: FM 계열 slice 물리 엔진은 오픈소스 아님 — 위 커뮤니티/가이드 문서만 참조 가능.)

---

## 5. HMB 스태틱 시뮬 관점 시사점

HMB 온라인의 지향("AI 가 프롬프트로 인풋 생성 → 시뮬은 스태틱/결정론")에 비추어, 기존 엔진 방식별 채택 판단을 정리한다.

| 항목 | 기존 방식 | HMB 적용 시사점 |
|------|-----------|-----------------|
| 시간 진행 단위 | FM=0.25초 물리 slice / ESMS=분 단위 확률 | 물리 slice 는 결정론 유지·검증 비용이 큼. **HMB 는 분 또는 포제션 단위 이벤트 시뮬**이 서버 권위·리플레이에 유리 |
| 능력치 반영 | FM=raw attribute 실시간 평가 / ESMS=팀 Tk·Ps·Sh 총합 × 전술 계수 | AI 인풋을 **전술 곱셈 계수/가중치**로 환산하는 ESMS 식이 "인풋만 바꾸고 시뮬 고정" 구조와 정합 |
| 확률 처리 | FM 은 의도적 랜덤으로 결과 분산(재미) | HMB 는 확률을 쓰되 **시드를 인풋의 일부로 고정** → 같은 인풋=같은 결과 보장 |
| 결정론/검증 | 락스텝: 동일 RNG+시드, state hash 검증, headless replay | 서버 권위 시뮬에서 **시드+인풋 로그만 저장**하면 재현·부정검증 가능. FM식 "시드 흔들기"는 배제 |
| 득점 판정 | Poisson/xG 로 기대득점 샘플링 (heavy-tail 보정 필요) | 슛→xG→시드 고정 Poisson 샘플이 경량·설명가능. 무승부/고득점 보정 유의 |
| 결과 산출물 | ESMS/Bygfoot=텍스트 리포트 / FM=2D·3D | HMB 는 AI 프롬프트 서사와 결합 시 **텍스트 이벤트 로그 기반**이 LLM 친화적 |

### 핵심 결론
1. HMB 는 **FM식 물리 slice 보다 ESMS식 "능력치→팀 총합/가중치→확률 이벤트"** 모델이 결정론·서버권위·LLM 인풋 연동에 유리하다.
2. **결정론의 관건은 시드**: 시드를 인풋(전술 프롬프트 산출물)의 일부로 명시 저장하고 동일 RNG 를 강제하면 "같은 인풋=같은 경기"가 보장되어 리플레이·부정검증이 가능하다.
3. 오픈소스 중 **ESMS 는 로직 참고(확률 이벤트+전술 계수)**, **open-football(Rust)** 은 아키텍처/결정론 구현 참고 대상으로 적합하다.
