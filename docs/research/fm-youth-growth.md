# FM 유망주 성장·육성 시스템 조사 → HMB 온라인 적용 연구

> SoT = 이슈 **#172**. 세션 = hmb:research. owned-glob = `docs/research/**`. **코드 변경 0 — 리서치·설계 문서.**
> 작성 2026-07-22. 파트 A = FM 조사(출처 명시), 파트 B = HMB 적용안(설계 옵션 + 트레이드오프), 파트 C = 최소 스펙 제안, 파트 D = **hero 결정 필요사항**.
>
> **범위**: 이 문서는 **유망주 성장**(CA/PA · 유스 인테이크 · 나이곡선 · 멘토링 · 포지션 재훈련)을 다룬다.
> **팀 훈련 시스템**(주간 스케줄 · 훈련 강도 · 세션 유형 · 코치/시설)은 **별개 시스템**이며 자매 문서 [`fm-training-system.md`](./fm-training-system.md) 에서 다룬다. 두 시스템의 경계·접점은 그 문서 §B2·§C 참조.

**신뢰도 표기**: `[공식]` SI/FM 공식 문서 · `[실측]` 커뮤니티 대규모 테스트(fm-arena 등) · `[통설]` 널리 받아들여지나 미검증. FM 내부 수치는 상당수 커뮤니티 역공학이며 버전마다 바뀐다 — **수치 감각용이지 사양이 아니다.**

---

# 파트 A. FM 조사

## A1. CA / PA 모델 — 성장 시스템의 뼈대

| 개념 | 내용 |
|---|---|
| **CA (Current Ability)** | 지금의 실력. **0~200 정수**. 아마추어 20~30, 프리미어 주전급 130~150, 월드클래스 170+. 유저에게 **비공개**(별점으로만 노출) `[통설]` |
| **PA (Potential Ability)** | 도달 가능한 CA **상한**. DB 생성 시 고정, 세이브 중 **절대 불변** — 코칭·출전·시설 무엇으로도 안 오른다. CA가 PA에 닿으면 성장 정지 `[통설]` |
| **CA↔능력치 관계** | CA는 "예산", 눈에 보이는 능력치(1~20)는 그 예산의 **지출 내역**. 능력치마다 **포지션별 가중치**가 달라 같은 CA라도 포지션에 따라 능력치 프로파일이 다르다. 예: 헤딩은 타겟맨에서 무겁고 폴스나인에서 가볍다. 속도/가속은 윙에서 무겁다 `[통설]` |
| **CA 제외 능력치** | **Aggression · Determination · Flair · Natural Fitness** 4종은 CA 계산에서 완전히 빠진다 → "공짜 스탯". 세트피스 계열은 가중치 최하 `[통설]` |

### 음수 PA — "잠재력 자체가 매 세이브 랜덤"
DB에 PA를 음수로 넣으면 **세이브마다 다른 범위 롤**이 된다. 주로 22세 이하 = "현실에서도 얼마나 클지 모르는 선수"에 부여 `[통설]`

| 값 | 실제 PA 범위 |
|---|---|
| −10 | 170–200 |
| −9 | 150–180 |
| −8 | 130–160 |
| −7 | 110–140 |
| −6 | 90–120 |
| −5 | 70–100 |

→ **설계적 함의**: "잠재력"은 단일 숫자가 아니라 **밴드 + 세이브별 롤**이다. 같은 유망주를 두 번 키워도 결과가 다르다 = 재플레이 동기.

### 별점(star rating)의 정체 — 불확실성의 UI
- 금별 = 현재능력, 은별 = 잠재능력. **절대치가 아니라 "내 스쿼드 기준 상대평가"** — 같은 선수가 2부에선 4성, 프리미어에선 2성 `[통설]`
- **빈 별/흰 별 = 불확실성**(정보 부족), 낮음의 표시가 아니다. 스카우팅을 더 하면 좁아지지만, **어린 선수는 아무리 스카우팅해도 잠재력 별이 범위로 남는다** — 나이를 먹어야 확정된다 `[통설]`
- 별점 정확도 = 스카우트의 `Judging Player Ability` / `Judging Player Potential` 능력치에 의존 `[통설]`

> **핵심**: FM은 잠재력을 감추는 게 아니라 **"흐릿하게 보여주고 시간이 지나며 초점이 맞는" UX**를 판다. 도박이 아니라 관측이다.

## A2. 유스 인테이크 — 유망주 생성

- **연 1회**, 국가별로 날짜가 다름(잉글랜드 등 대부분 시즌 중후반). 몇 달 전 "인테이크 프리뷰" 인박스가 뜨지만 **실제 결과와 상관이 약하다**(커뮤니티 정설) `[통설]`
- 인테이크 인원 통상 **10~16명 규모**, 나이 **14~16세**(간혹 21세까지). 대부분은 쓰레기고 **2~3명만 남길 가치**가 있다 `[통설]`
- 유스는 **완전 신규 생성(newgen)** — 은퇴 선수의 능력/성격을 승계하지 않는다. 랜덤 비중이 크다 `[통설]`

### 인테이크 품질을 정하는 요인 `[공식]` (FM26 The Dugout)
| 축 | 통제 | 효과 |
|---|---|---|
| **National Youth Rating** (1~200) | ✗ 불가 | 그 나라 뉴젠 평균 수준. **150년에 2포인트** 수준으로만 변한다 = 사실상 상수 `[통설]` |
| **Game Importance** | ✗ 불가 | 그 나라에서 축구의 위상 |
| **Youth Facilities** | ○ 이사회 요청 | 인테이크 **전에** 아카데미 유망주가 자라는 환경 |
| **Junior Coaching** | ○ 이사회 요청 | 인테이크 전 CA/PA 모두 끌어올림 |
| **Youth Recruitment** | ○ 이사회 요청 | 지역 스카우팅/트라이얼 — **좋은 원석이 애초에 들어오게** |
| **Head of Youth Development** | ○ 고용 | ① **선호 포메이션이 생성 포지션 분포를 바꾼다**(5-3-2 → 윙백↑, 4-3-3 → 윙어↑) ② **자기 성격을 유망주에게 전파할 확률** — Model Citizen/Professional 계열이 이상적 |
| **클럽 평판** | 간접 | 성적으로 상승 |

> **설계적 함의**: FM의 유스 시스템은 "뽑기"가 아니라 **투자 → 확률분포 이동** 구조다. 유저가 돈/시간을 넣는 대상은 개별 선수가 아니라 **인테이크 분포 자체**다.

## A3. 나이별 성장 곡선

`[실측]` fm-arena 대규모 훈련 테스트 — 동일 스케줄, 나이만 다르게:

| 나이 | 한 시즌 CA 증가 | 비고 |
|---|---|---|
| 15 | **+29** | 증가분이 신체 스탯으로 안 감 — 기술/정신에만 배분 |
| 18 | **+30.5** | **성장 정점(17~18세)** |
| 20 | +22.5 | 19세가 첫 번째 감속 노드 |
| 23 | +20 | |
| 27~ | 급감 | 두 번째 노드 |
| 35~ | 하락 방어 불가 | |

부가 실측:
- **신체 능력치는 시즌당 하드캡** — 전문 훈련을 해도 pace는 시즌 **+2~2.5** 정도가 한계. 남는 CA는 기술/정신으로 흘러간다 `[실측]`
- **Professionalism 10 vs 20 = 성장률 30~35% 차이** `[실측]`
- 피크: 필드플레이어 **24세 전후 정점 → 31세부터 급락**, GK는 26세로 늦다 `[통설]`. 다만 FM22 이후로는 **최고 유망주가 25~29세에 만개**하도록 느려졌다 `[통설]`
- **24세 이상은 새 특성(PPM) 습득이 훨씬 어렵다** → 특성은 24세 전에 `[통설]`

## A4. 성장을 좌우하는 요인

### (1) 성격 / 히든 능력치 — **가장 큰 단일 변수**
FM은 표시 능력치와 별도로 히든 능력치(Ambition, Controversy, Loyalty, Pressure, Professionalism, Sportsmanship, Temperament, 각 1~20)를 갖고, 이 조합이 "Model Citizen / Professional / Casual / Slack" 같은 **성격 라벨**로 표시된다 `[통설]`

`[실측]` 성장률 기여도 (3년 누적 능력 상승):
| 조건 | 3년 누적 |
|---|---|
| Professionalism 20 (야망/투지는 보통) | **≈ +46** |
| Ambition 최대 | ≈ +26 |
| Determination 최대 | ≈ +22 |

- **Professionalism이 지배적이고 1~20 전 구간 선형**. Ambition/Determination은 **1→10 구간에서 대부분의 효과가 나오고 10→20은 미미**(수확체감) — 하한 8~10만 확보하면 된다.
- Slack(Professionalism 1), Casual(2~4) 같은 성격은 사실상 육성 불가 판정.

### (2) 멘토링 / 튜터링
- 시니어 선수 + 유망 선수(보통 **24세 미만**)를 한 그룹에 묶으면 **멘티의 히든 능력치가 멘토 쪽으로 이동**. 능력치를 직접 올리는 게 아니라 **성장 계수를 바꾸는 간접 시스템**이다 `[통설]`
- 같은 포지션끼리 묶는 게 유리. **나쁜 멘토는 professionalism을 깎고 controversy를 올린다** — 양방향 리스크 `[통설]`
- 속도: **1~3시즌에 1~3포인트** 수준의 느린 변화 `[통설]`
- 그룹 멘토링 외에 **스쿼드 문화(squad culture)** 도 작동 — adaptability 높은 24세 이하는 팀 전체 성격에 서서히 물든다 `[통설]`

### (3) 출전 시간 — 훈련보다 중요하다는 게 정설
- **1군 교체 출전 10~20회 > 유스리그 지배** `[통설]`
- 최적 구간: 시즌 **2,000~3,000분**. 3,000~4,000분에서 성장 평탄화, **4,000분 초과부터 피로·부상 급증** `[통설]`
- 유망주에겐 팀 총 출전분의 **60% 이하 / 시즌 15경기·1,500분** 정도를 권장하는 가이드가 많다 `[통설]`
- 자리가 없으면 **임대**. 단 임대처 수준이 중요 — 못 뛸 임대보다 좋은 B팀이 낫다 `[통설]`
- FM26은 **불만족(훈련·출전) 시 퇴보**한다 — 성장은 사기(morale)와 결합돼 있다 `[공식/통설]`

### (4) 훈련 / 개인 훈련(Additional Focus) — **별도 시스템은 있으나 효과는 작다**
FM에는 **훈련 전용 대탭이 따로 존재**한다: 주간 팀 훈련 스케줄(세션 단위) · 개인 훈련(역할 + 추가 포커스 + 강도) · 코치 배정 · 훈련 유닛(1군/B팀) · 멘토링 그룹. 화면 존재감은 크다. 그런데 **실측 효과는 작다.**

- 팀 훈련(역할 기반) + **개인 추가 포커스**(특정 능력치 지정). 강도 light/average/heavy — 강할수록 빨리 오르지만 **워크로드·훈련 만족도·체력**을 갉아먹고 다른 개인훈련 시간을 뺏는다 `[공식/통설]`
- 효과 크기: `[실측]` 특정 능력치 집중 훈련 시 **15세 시즌 +2%, 20세 시즌 +4~5%** 수준 — 즉 **개인훈련은 미세조정이고, 성장의 본체는 나이·성격·출전**이다.
- 코치의 해당 분야 능력치가 성장을 가속 `[통설]`
- ※ 커뮤니티 일각에는 "훈련은 CA를 늘리는 게 아니라 **이미 늘어난 CA를 어디에 배분할지 결정할 뿐**"이라는 강한 주장이 있다 `[실측·논쟁중]`. → **HMB 설계에는 이 해석이 오히려 깔끔하다**(B3 참조).

### (5) 포지션 재훈련
- 익숙도 5단계: **Natural > Accomplished > Competent > Unconvincing > Awkward** `[통설]`
- 완전 신규 포지션 습득에 **6~9개월**, `Natural` 도달까지 **약 12개월** `[통설]`
- **훈련만으로는 부족하고 실제 그 포지션 출전이 필수**. 친선 → 컵 → 리그 순으로 노출. **어릴수록 빨리 익히고 오래 유지** `[통설]`

## A5. FM 시스템의 설계 원리 (HMB가 훔칠 것)

1. **잠재력은 숫자가 아니라 안개다.** 범위로 보여주고 시간이 지나며 좁혀진다 → "이 녀석이 진짜일까"라는 장기 서사.
2. **성장은 개별 선수를 직접 조작하는 게 아니라 확률분포·계수를 미는 것.** 시설·코치·멘토·출전은 전부 곱해지는 계수다.
3. **CA는 예산, 능력치는 지출.** 성장 총량과 성장 방향이 분리돼 있다.
4. **성장의 8할은 나이·성격·출전이고, 훈련은 방향타.**
5. **대부분은 실패한다.** 인테이크 16명 중 2~3명 → 선별·방출 자체가 게임플레이.

---

# 파트 B. HMB 적용 연구

## B0. HMB 제약 조건 정리 (재발명 금지 — 기존 자산 우선)

| 제약 | 내용 | 성장 시스템에 주는 함의 |
|---|---|---|
| **결정론 불변** (CLAUDE §2-5) | `Math.random`/`Date.now` 금지, 시드 RNG 관통, 골든 스냅샷 | 성장 계산은 **엔진 밖**. 엔진은 무변경 |
| **재현 3종세트** | `(seed + selectData + inputLog + EngineConfig ver)` | `SelectData`는 매치 시점 **스냅샷** → 나중에 능력치가 자라도 **과거 리플레이는 bit-identical** ✅ 충돌 없음 |
| **능력치 스키마** | 9종 0~100 (`technical/mental/physical/passing/shooting/tackling/pace/stamina/positioning`) | FM의 CA(0~200)·능력치(1~20) 대신 **평균 능력치(OVR 0~100)를 CA로** 쓰면 스키마 변경 0 |
| **등급 = 밴드** (`grade-mapping-v2.md`) | BRONZE 40–55 / SILVER 50–65 / GOLD 60–75 / DIA 70–85 / LEGEND 80–95 | **OVR이 상위 밴드 하한을 넘으면 등급 승급** — 승급 규칙을 새로 만들 필요가 없다 ✅ |
| **카드 시스템** (#85 PRD-cards) | baseId/versionId, 강화 level(+5)·한계돌파(+10), 5등급 | ⚠️ **강화도 스탯을 올린다** → 성장과 축이 겹치면 밸런스 지옥. B2의 핵심 쟁점 |
| **관계 3축** (P2-D7) | personality 4종(FIERY/CALM/GLASS/AMBITIOUS) · 신뢰도 0~100 · 팀사기 0~100 | FM의 Professionalism/Determination 자리에 **그대로 매핑** — 신규 히든 능력치 만들지 말 것 |
| **포인트 경제** | 가챠 300/3000, 승리 500, 트레이드 단축 | 성장은 **새 화폐 없이**(P2-D11) 포인트 sink가 돼야 함 |
| **AI 예산** (P2-D8) | 출력 토큰 +10% 초과 금지 | 훈련 프롬프트 AI 변환은 **저빈도 + 캐시** 필수 |
| **실명 라이선스** | 실선수 172명, 상용화 전 해결 필요 | **뉴젠 유스는 가상 이름 = 라이선스 프리** → 오히려 리스크를 줄인다 ✅ |
| **데이터 갭** | `players.v2.1.json`에 **`age` 필드 없음** | 나이 도입 = data 모듈 스키마 결정 필요 (**D-2**) |

## B1. HMB 차별점과의 결합 — **훈련 화면을 만들지 않는다. 경기 지령이 곧 훈련이다.**

> **hero 방향 (2026-07-22)**: "훈련 시스템을 따로 두지 말고, 경기 중 좋은 프롬프트로 지령하면 그게 성장에 영향을 주게 하자." → **채택 권장.** 아래는 그 설계.

### 왜 이게 맞나
1. **AI 예산 증분 0.** HMB는 이미 매치마다 프롬프트 → `TacticalInput` 을 만든다. 그 결과의 `behavior`(forwardRunFreq·pressAggression·passRisk·widthTendency…)가 **이미 성장 포커스 벡터다.** 별도 훈련 프롬프트 AI 잡이 통째로 불필요(→ C장 M5 삭제). P2-D8 예산 가드에 무부하.
2. **FM 고증과 오히려 더 일치.** A4-(3) "출전 > 훈련", A4-(5) "재훈련은 실제 그 포지션 출전이 필수", A4-(4) "훈련은 총량이 아니라 **배분**만 정한다"는 실측 해석 — 셋 다 "경기에서 한 것이 성장한다"로 수렴한다. FM의 훈련 대탭은 존재감 대비 효과가 작은 부분이고, **HMB는 그 작은 부분을 안 만들 뿐이다.**
3. **화면 1개 절약 + 컨셉 일관성.** 모바일 탭 폭발을 막고, 유저 정체성이 "훈련 시키는 사람"이 아니라 **"지시하는 감독"** 하나로 유지된다(§1 핵심 컨셉).

### 구조
```
경기 전/하프타임 프롬프트  "측면 파고들어서 컷백 넣어"
        ↓ (기존 AI 경로 — 신규 호출 0)
TacticalInput.behavior  {forwardRunFreq↑, widthTendency↑, passRisk↑ …}
        ↓ 정규화
성장 방향 벡터 w  {pace .25, passing .25, physical .20, technical .15, stamina .15}   ← "무엇이" 자라나
        ↓ × match-log 실행 정합
성장 총량 Δ  = 나이·성격·출전 × execMatch(의도 vs 실제 이벤트)                        ← "얼마나" 자라나
        ↓ (server-java, 결정론·멱등)
9능력치 배분 → ovr 상승 → 등급 밴드 승급
```

### ★ "좋은 프롬프트"를 무엇으로 판정하나 — 유일한 위험 지점
| 방식 | 판정 |
|---|---|
| (a) **AI가 프롬프트 품질을 점수화** | ❌ **비결정론**(§2-5 위반 위험) + 게이밍 가능("최고의 선수가 되어라" 스팸) + **문장력 경쟁**이 됨 + AI 예산↑ |
| (b) **지시 × match-log 실행 정합** (`execMatch`) | ✅ 완전 결정론. "돌파해라" 지시 → match-log 에 실제 돌파/전진 이벤트가 있어야 그 능력치가 자람. 게이밍 불가(경기에서 실제로 나와야 함) |
| (c) behavior 벡터를 그대로 배분 | ○ 최단. 단 "무엇을"만 반영되고 "좋은"이 빠짐 |

→ **권장 = (c) 방향 + (b) 총량.** 이러면 *좋은 프롬프트 = 화려한 문장이 아니라 **그 선수가 실제로 해낼 수 있는 걸 시킨 적합한 지시***가 된다. 능력 밖의 지시는 로그에 이벤트가 안 찍혀 성장이 적고, 잘 맞는 지시는 성장이 크다 — 축구적으로도 게임적으로도 건강하고, **AI 판정을 안 쓰므로 결정론이 오히려 더 안전하다.**

`execMatch` 산정 소재는 이미 match-log 에 다 있다: 패스/가로챔/돌파/슛/유효슛/태클/파울/주행거리/롱패스 `detail`. 예 — `passRisk↑` 지시 → 전진·롱패스 시도 수와 성공률로 `passing` 성장 가중.

### 이 방식이 **잃는 것** (정직하게)
| 손실 | 완화 |
|---|---|
| **벤치·미출전 선수가 안 자람** → 카드 컬렉션 성장 병목 (11명만 성장) | 미출전 감쇠 성장 계수(`benchGrowthMult` 예 0.15~0.25) — "팀 훈련" 대용. 하프타임 교체(≤3)가 출전 배분 도구 |
| **이벤트가 적은 포지션(GK)·능력치가 굶는다** | 포지션별 **baseline 배분 벡터**를 깔고 프롬프트가 그걸 편향시키는 구조(w = normalize(baseline + promptBias)) |
| 특정 능력치 **핀포인트 육성**이 어려움 | 의도된 손실. 핀포인트가 필요하면 카탈로그 지시(P2-D6)로 명시적 방향 선택 |
| 명시적 **포인트 sink("훈련비")가 사라짐** | 아카데미 시설 3축·유스 슬롯 확장·스카우팅(PA 범위 축소)이 sink 역할 유지(B5) |

파생 매핑 (전부 **기존 자산 재사용**):
| FM | HMB 대응 | 신규 개발 |
|---|---|---|
| 개인 훈련 포커스 | **경기 지령 프롬프트 → `TacticalInput.behavior` → 성장 방향 벡터** | **0**(기존 AI 경로 재사용) |
| 멘토링(히든 성격 전파) | 시니어 카드 지정 → personality 이동 + **시그니처 프롬프트 상속**(PRD-cards D1 `signature_prompt`) | 없음(스키마 존재) |
| Professionalism/Determination | `personality` 4종 + `player_relations.trust` | 없음 |
| 스쿼드 문화 | `team_morale` | 없음 |
| 출전 시간 성장 | 매치 정산 시 출전 틱 | 없음(매치 정산 훅 존재) |
| 유스 시설 3축 | 아카데미 시설 3레벨(포인트 sink) | 소 |
| 스카우트 별점 불확실성 | **PA 밴드 표시 + 스카우팅으로 범위 축소** | 소 |
| 포지션 재훈련 | position 변경 + 적응도 계수 | 중 |

## B2. 설계 옵션 3안

### 안 1 — **강화 흡수형** (성장을 새로 만들지 않음)
카드 강화(#85 D2)의 **재료 획득 경로**만 추가한다. 출전·훈련이 "훈련 포인트"를 낳고, 그게 강화 레벨을 올린다. 신규 엔티티 0.

| | |
|---|---|
| 👍 | 최소 비용(ERD 델타 거의 0), 카드 시스템과 축 충돌 0, 밸런스 노브 1개 |
| 👎 | 나이·PA·유스 서사 **전무** → 이슈 #172의 "유망주 육성" 요구를 사실상 미충족. 차별점 없음(그냥 육성형 강화) |
| 적합 | Phase 2에 시간이 없을 때의 **폴백** |

### 안 2 — **유스 아카데미 (별도 트랙)** ★ 권장
뉴젠 유스 풀을 신설하고, **실선수 카드(불변, 강화만) ⟂ 유스 카드(나이·CA/PA·성장)** 로 축을 완전 분리한다.

| | |
|---|---|
| 👍 | ① **라이선스 프리**(가상 뉴젠) ② 실선수 카드 밸런스·수집 가치 **무영향** ③ 육성 서사 온전(인테이크→선별→방출→승급) ④ **비과금 획득 경로** = 리텐션 ⑤ 실패해도 유스 테이블만 드롭 = **롤백 쉬움** |
| 👎 | 선수 엔티티가 2종 → 덱/도감/트레이드 UI 전부 분기. 유스가 실선수보다 강해지면 컬렉션 가치 훼손 → **PA 캡 필수** |
| 완화 | 유스 PA 상한을 **GOLD 밴드(≤75)** 로 캡, LEGEND 불가. 인테이크는 **시즌 1회 + 슬롯 제한** |
| 적합 | **Phase 2 최소 스펙의 기본안** |

### 안 3 — **전 카드 통합 CA/PA**
보유 카드 인스턴스 전부에 나이 + CA/PA. 가챠가 "등급 + PA 롤" **2중 복권**이 된다("좋은 호날두"의 정의에 잠재력이 추가).

| | |
|---|---|
| 👍 | 최대 깊이. 가챠 기대감 폭증(PRD-cards §0 목표 "좋은 호날두를 뽑으면 계속 뽑고 싶게"와 직결). 시스템 1개로 통일 |
| 👎 | ① **강화와 축 중복**(둘 다 스탯↑) → 밸런스 지옥 ② 인플레 ③ **노화로 내 레전드가 늙는다 = 수집형에서 강한 유저 반발** ④ 172명 전원 나이 데이터 필요 + 마이그레이션 큼 |
| 완화 | 노화·쇠퇴 미도입(성장만) + **PA를 "강화 상한"으로 재해석**해 강화와 통합(한계돌파의 자연 확장) → 축 중복 해소. 단 hero 확정 O5(+5/+10)와 재조율 필요 |
| 적합 | Phase 2 이후. 안 2가 검증된 뒤의 승격 경로 |

### 권장: **안 2로 착수하되, 성장 엔진을 카드 무관 공용 서비스로 설계**
`GrowthService(playerInstance, matchResult) → Δattributes` 를 **유스/실선수 구분 없이** 받도록 만들면, 안 2는 그 서비스의 소비자가 1종(유스)일 뿐이고 나중에 안 3으로 확장할 때 **서비스는 그대로**다. → 안 2 = 안 3의 부분집합.

## B3. 성장 모델 (수식 — 전부 config)

**CA 대응 = `ovr`** = 9능력치의 포지션 가중평균(0~100). 등급 밴드와 같은 축이라 승급 판정이 공짜.

```
매치 정산 시:
  ── 총량 ("얼마나 자라나") ────────────────────────────────
  Δovr = growthBase
        × ageMult[age]              # A3 곡선 이식
        × minutesMult(playedMin)    # A4-(3) 포화 곡선. 미출전 = benchGrowthMult(0.15~0.25)
        × execMatch                 # ★ B1-(b) 의도(behavior) vs match-log 실제 이벤트 정합 0..1
        × personaMult[personality]  # AMBITIOUS↑ GLASS↓ (A4-(1))
        × trustMult(trust)          # 신뢰도 = 출전 만족도 대용
        × moraleMult(teamMorale)
        × facilityMult[coachingLv]  # 포인트 sink
        × gapDecay((pa - ovr) / span)   # PA 근접 시 수확체감, 도달 시 0

  ── 방향 ("무엇이 자라나") ───────────────────────────────
  w = normalize( baselineByPosition[pos] + promptBias(TacticalInput.behavior) )
      # baseline = GK 등 이벤트 희소 포지션의 성장 굶주림 방지
      # promptBias = 경기 지령이 만든 편향 (신규 AI 호출 0)

배분: Δovr 을 w(합=1)로 9능력치에 분배
      단 physicalCapPerSeason 게이트 (A3 신체 하드캡 이식)
      + 능력치별 상한 클램프
승급: ovr 이 상위 등급 밴드 하한 도달 → grade 승급 (기존 밴드 규칙 재사용)
```

> **`execMatch` 소재는 이미 match-log 에 전부 있다** — 패스/가로챔/돌파/슛/유효슛/태클/파울/주행거리/롱패스 `detail`. 예: `passRisk↑` 지시 → 전진·롱패스 시도수 × 성공률로 `passing` 성장 가중. **AI 판정 없음 = 결정론 무손상.**

**수치 감각 (제안 초안, QA 튜닝 대상)**
- 유스 인테이크: 16세, 시작 `ovr` 38~46(BRONZE 밴드 하단), 인원 **6~8명**(FM 16명은 모바일 UI에 과함), 그중 **슬롯 3~4개만 보유 가능** → 선별 압박 유지.
- PA 롤: 밴드 5단계(`Y1` 50–60 / `Y2` 55–68 / `Y3` 60–72 / `Y4` 65–78 / `Y5` 70–**75캡**). 확률은 시설 3축이 민다(FM 구조 이식).
- 완성 기간: 리그 1시즌=18R. **2시즌(36경기) 목표** → `ovr` +30이면 출전 경기당 평균 **+0.8 ovr**(gapDecay로 초반 가중). FM의 3~4년은 모바일 리텐션엔 너무 길다.
- 나이 진행: **1시즌 = 1살**(실시간 아님). 16→18이 정점, 19+ 감속 — A3 표를 압축 이식.

## B4. 결정론 정합 — **어디서 성장을 처리하나**

```
[web]  훈련 프롬프트 입력
   ↓
[servants/AI]  프롬프트 → 포커스 벡터 w  (저빈도 + 프롬프트 해시 캐시)
   ↓  (결과는 DB에 저장 = 입력 아티팩트. §7 "방식1"과 동일 패턴)
[server-java]  ★ 성장 정산의 유일한 권위
   - 매치 결과 커밋 트랜잭션 안에서 Δ 계산·적용
   - 시드 = hash(userId, youthPlayerId, matchId) → 재실행 멱등
   - 멱등 플래그 growth_applied (기존 relations_applied 패턴 그대로)
   ↓
[engine]  ★ 무변경. SelectData 는 매치 시점 스냅샷 → 과거 match-log 리플레이 bit-identical
```

**불변 보장 3줄**
1. 엔진은 성장을 모른다 — 성장은 "다음 매치의 SelectData가 달라진다"일 뿐. `packages/engine/**` 델타 0, 골든 스냅샷 무변경.
2. `matches.selectData` 스냅샷이 이미 존재 → **과거 경기 재생은 영원히 동일**.
3. AI는 인풋(포커스 벡터)만 만들고 시뮬은 스태틱 — §7 방식1과 완전 동형. AI 출력이 바뀌어도 저장된 벡터로 재현.

## B5. 경제·밸런스 정합

| 항목 | 설계 |
|---|---|
| **포인트 sink** | 아카데미 시설 3축(시설/코칭/스카우팅) 레벨업 — FM 3축 그대로. 유스 슬롯 확장, 스카우팅으로 PA 밴드 좁히기(정보 구매) |
| **가챠 잠식 방지** | 유스 PA 캡 ≤ GOLD(75). DIA/LEGEND는 **오직 가챠·오퍼**로만 → 과금 동기 보존 |
| **유스 방출** | 슬롯 초과분은 방출 → 소량 포인트 환급(PRD-cards D4 3단 배출구와 같은 철학) |
| **승급 카드 편입** | 유스는 `Y###` **별도 ID 네임스페이스** — 실선수 도감(P###) 오염 방지. 도감에 "아카데미" 탭 분리 |
| **봇 리그 팀** | 성장 미적용(간이 결과 유지, AC-F2). 대신 시즌마다 `botPowerScale` config로 난이도 추종 |
| **트레이드** | Phase 2에선 유스 **트레이드 제외**(가치평가 함수 오염 방지). 백로그 |

## B6. 리스크

| 리스크 | 완화 |
|---|---|
| 성장 축이 강화 축과 겹쳐 밸런스 붕괴 | 안 2로 **엔티티 자체를 분리**. 유스는 강화 불가 / 실선수는 성장 불가 |
| 유스가 무과금 최적해가 됨 | PA 캡 + 슬롯 제한 + 시즌 1회 인테이크 |
| 성장이 느려 체감 0 | 2시즌 완성 + gapDecay 초반 가중 + **매 경기 "성장 리포트" 피드백**("이 지시가 이 능력치를 키웠다" — 지시↔성장 인과를 눈에 보이게) |
| ~~AI 훈련 프롬프트 예산 초과~~ | **해소** — B1 채택으로 신규 AI 호출 0(기존 `TacticalInput` 경로 재사용) |
| 유저가 성장만 노려 **비합리적 지시**를 함(경기를 버리고 육성) | `execMatch` 가 실제 이벤트를 요구 → 지지 않는 지시가 곧 잘 자라는 지시. 승패 보상(포인트)이 별도로 존재해 이중 견제 |
| 엔티티 2종화로 UI 복잡도 폭발 | 카드 상세 컴포넌트 재사용, 아카데미는 **탭 1개**로 격리 |
| FM 수치를 그대로 이식 → HMB 축약 스케일에 안 맞음 | 전부 `EngineConfig`/economy config(§2-4). 초기값은 "감각"일 뿐, 밸런스는 QA 튜닝 |

---

# 파트 C. 최소 스펙 제안 (Phase 2 '훈련/성장' 축)

> 안 2 기준. **W0(계약) → W1(성장 코어) → W2(아카데미) → W3(프롬프트 훈련) → W4(심화)** 순. 각 웨이브 module-implementer → module-verifier PASS.

| # | 스코프 | 모듈 | 필수도 |
|---|---|---|---|
| **M1** | 유스 뉴젠 생성기 — 가상 이름풀, 시드 결정론, 포지션 분포, 시작 능력치, **PA 밴드 롤** | `data/**` | ★필수 |
| **M2** | 유스 엔티티 + 인테이크 — `youth_players`(age/ovr/pa_band/pa_hidden/seed), 시즌 종료 트리거, 슬롯 제한·방출 | `server-java/**` | ★필수 |
| **M3** | 성장 코어 — `GrowthService`(B3 수식), 매치 정산 훅, 멱등(`growth_applied`), 등급 승급 | `server-java/**` | ★필수 |
| **M4** | 아카데미 UI — 탭, 인테이크 결과, 유스 카드 상세(**PA를 별 범위로**), **경기 후 성장 리포트**("이 지시가 이 능력치를 키웠다"), 방출 | `apps/web/**` | ★필수 |
| ~~M5~~ | ~~훈련 프롬프트 → 포커스 벡터 AI 잡~~ → **삭제**. B1 채택으로 기존 `TacticalInput.behavior` 재사용, 신규 AI 호출 0 | — | — |
| **M6** | 시설 3축 + 스카우팅(PA 범위 축소) — 포인트 sink | server-java + web | ○ |
| **M7** | 멘토링 — 시니어 지정 → personality 이동 + 시그니처 프롬프트 상속 | server-java + web | ○ |
| **M8** | 포지션 재훈련 — 적응도 계수 | server-java | △ 후속 |
| **—** | **엔진** | `packages/engine/**` | **변경 0** |

**계약 프리즈 대상**: `packages/shared/**` — 유스 카드가 `PlayerCard`로 승격될 때의 직렬화(현 스키마로 충분한지 확인. `attributes` 9종 그대로면 **shared 델타 0**이 목표).

**AC 초안**
- AC-Y1: 같은 시드·같은 시즌으로 인테이크 재생성 시 **바이트 동일**.
- AC-Y2: 같은 매치를 재정산해도 성장이 **한 번만** 적용(멱등).
- AC-Y3: 성장 적용 후에도 **과거 match-log 재생이 bit-identical**(리플레이 회귀 가드).
- AC-Y4: **경기 지령 프롬프트 3종이 서로 다른 능력치 방향**으로 성장시킴을 증명(방향성 테스트 — G-C 라이브 AI 게이트와 동형).
- AC-Y5: 유스 `ovr`이 PA를 **절대 초과하지 않음** + PA 캡 ≤ config 상한.
- AC-Y6: **AI 호출·토큰 증분 = 0**(성장이 기존 `TacticalInput` 경로만 소비함을 테스트로 증명). P2-D8 무부하.
- AC-Y7: 같은 지시라도 **match-log 에 해당 이벤트가 없으면 성장이 유의미하게 작다**(`execMatch` 작동 증명 — 게이밍 방지 계약).
- AC-Y8: GK 등 이벤트 희소 포지션도 `baselineByPosition` 으로 성장이 굶지 않음.

---

# 파트 D. hero 결정 필요사항 (게이트)

| # | 결정 | 옵션 | 리서치 권장 |
|---|---|---|---|
| **D-1** | 기반 안 | 안1 강화흡수 / **안2 유스 아카데미** / 안3 전카드 통합 | **안 2** (안 3으로 승격 가능하게 설계) |
| **D-2** | 실선수 172명에 `age` 부여? | 예 / 아니오 | **아니오** — 나이는 유스 전용. 실선수는 "전성기 박제" 카드 |
| **D-3** | 유스 PA 상한 | GOLD(75) / DIA(85) / 무제한 | **GOLD 75, LEGEND 불가** (가챠 잠식 방지) |
| **D-4** | 노화·쇠퇴 도입? | 예 / 아니오 | **아니오** (Phase 2). 수집형에서 "내 카드가 늙는다"는 반발이 크다 |
| **D-5** | 성장 축 vs 강화 축 | 분리 / 통합 | **분리** (유스=성장, 실선수=강화) |
| **D-6** | 훈련 입력 경로 | 별도 훈련 화면 / **경기 지령 겸용** | **경기 지령 겸용**(hero 방향, B1). 훈련 전용 화면·AI 잡 없음 |
| **D-6b** | "좋은 프롬프트" 판정 | AI 품질점수 / **실행 정합** / 판정 없음 | **실행 정합(`execMatch`)** — AI 판정은 비결정론·게이밍·문장력 경쟁 위험으로 기각 |
| **D-12** | 미출전 선수 성장 | 없음 / **감쇠 성장** | **감쇠 성장**(`benchGrowthMult` 0.15~0.25) — 없으면 11명만 자라 컬렉션 병목 |
| **D-7** | 성장 정산 단위 | 매치 / 주 / 시즌 | **매치 정산 + 시즌 인테이크** (실시간 아님 → 서버시계 P4-D1과 무관) |
| **D-8** | PA 노출 정도 | 완전 히든 / **밴드 범위** / 공개 | **밴드 범위** + 스카우팅으로 축소 (FM의 핵심 UX) |
| **D-9** | 유스 완성 기간 | 1 / **2** / 3+ 시즌 | **2시즌(36경기)** — 모바일 리텐션 기준 |
| **D-10** | 유스 트레이드/도감 편입 | 편입 / 분리 | **분리**(`Y###` 네임스페이스, 트레이드 제외 — 백로그) |
| **D-11** | 인테이크 인원·슬롯 | — | 인테이크 **6~8명 / 보유 슬롯 3~4** (선별 압박) |

**미해결·후속 조사거리**
- 유스 뉴젠 **이름풀** 출처(국가별 가상 이름 생성) — data 모듈 판단 필요.
- 성장이 **AI 전술 프롬프트 품질 평가**에 주는 노이즈(능력치가 변하면 A/B 비교 기준선이 흔들림) — QA 벤치 시드 고정 정책 필요.
- 안 3 승격 시 강화(+5/+10)와 PA의 통합 수식 — PRD-cards O5 재조율 필요.

---

## 출처

**CA/PA·별점**
- [FM Dossier — CA vs PA: Current & Potential Ability Explained](https://fmdossier.dev/guides/current-vs-potential-ability)
- [FM Scout — The Definitive Guide to Current Ability](https://www.fmscout.com/a-guide-to-current-ability-in-football-manager.html)
- [FM Scout — Current and Potential Ability Guide (음수 PA)](https://www.fmscout.com/a-football-manager-current-and-potential-ability-guide.html)
- [Passion4FM — All you need to know about STAR RATINGS](https://www.passion4fm.com/football-manager-guide-star-ratings/)
- [FM Base — The Complete CA/PA Thread](https://fm-base.co.uk/threads/the-complete-ca-pa-thread.44763/)

**유스 인테이크**
- [Football Manager 공식 — Developing and Maximising Your Youth Intakes in FM26](https://www.footballmanager.com/the-dugout/developing-and-maximising-your-youth-intakes-fm26)
- [Football Manager Wiki — Youth Intake](https://footballmanager.fandom.com/wiki/Youth_Intake)
- [FM Projects — Youth Intake (Daniel Evensen)](https://fmprojects.substack.com/p/youth-intake)
- [Passion4FM — Youth Intake: How Clubs Produce Newgens](https://www.passion4fm.com/youth-intake-guide-how-clubs-produce-newgens/)
- [Passion4FM — FM26 Youth Intake Dates](https://www.passion4fm.com/football-manager-youth-intake-dates/)

**나이 곡선·성장률**
- [FM-Arena — Training and age "Golden Age"/"Declining Age"](https://fm-arena.com/thread/13924-training-and-age-golden-age-declining-age/)
- [sortitoutsi — When do players peak in Football Manager?](https://sortitoutsi.net/content/67377/when-do-players-peak-in-football-manager-the-advise-from-si-is-a-lie)
- [Fuller FM — FM22: The Age-Old Problem](https://fullerfm.com/2022/05/02/fm22-the-age-old-problem/)

**성격·멘토링**
- [FM Dossier — Personality and Development](https://fmdossier.dev/guides/personality-and-development)
- [VideoGamer — How to mentor players in FM24](https://www.videogamer.com/guides/football-manager-2024-fm24-how-to-mentor-players/)
- [Guide to FM — Player Tutoring](https://www.guidetofm.com/squad/tutoring/)
- [FM-Arena — Mentoring](https://fm-arena.com/thread/3218-mentoring/)

**훈련·출전**
- [Guide to FM — Additional Focus](https://www.guidetofm.com/training/additional-focus/)
- [FM-Arena — Meta Attributes Weighted Training: Additional Focus](https://fm-arena.com/thread/9309-meta-attributes-weighted-training-part-4-additional-focus/)
- [FM-Arena — "Training is Fake, it just assigns attributes" (논쟁)](https://fm-arena.com/thread/13508-training-is-fake-it-just-assigns-attributes-not-grows-attributes-results-based-on-a-large-number-of-tests/)
- [Passion4FM — The Ultimate Youth Development Guide](https://www.passion4fm.com/football-manager-youth-development-guide/)
- [Passion4FM — Using Loans to Improve Youth Development](https://www.passion4fm.com/using-loans-to-improve-youth-development-on-football-manager/)
- [Operation Sports — FM26: How to Develop Young Players](https://www.operationsports.com/football-manager-26-how-to-develop-young-players/)

**포지션 재훈련**
- [sortitoutsi — FM24 Guide: How to Retrain Player's Position](https://sortitoutsi.net/content/67473/fm24-guide-how-to-retrain-players-position)
- [FM Scout — Position and picking (익숙도 5단계)](https://www.fmscout.com/q-108-Position-and-picking.html)
