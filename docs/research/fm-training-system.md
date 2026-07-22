# FM 팀 훈련 시스템 조사 → HMB 적용 연구

> SoT = 이슈 **#172**. 세션 = hmb:research. owned-glob = `docs/research/**`. **코드 변경 0 — 리서치·설계 문서.**
> 작성 2026-07-22 (hero 지적 반영: *"FM에는 훈련 시스템이 유스 성장과 따로 있다"*).
> **자매 문서** = [`fm-youth-growth.md`](./fm-youth-growth.md) (유망주 CA/PA·인테이크·성장곡선). 두 문서의 경계는 §C에서 정리한다.

**신뢰도 표기**: `[공식]` SI 매뉴얼/공식 · `[실측]` 커뮤니티 대규모 테스트 · `[통설]` 널리 받아들여지나 미검증.
⚠️ **조사 한계**: SI 공식 매뉴얼·guidetofm·fmscout 일부 페이지가 **403으로 직접 열람 불가**했고, 해당 `[공식]` 표기는 검색 스니펫 경유 인용이다. **코치 산식은 FM2013 기준**, **FM26 변경분은 커뮤니티 보고 1건 기반**이다. 수치는 사양이 아니라 감각용.

---

# 파트 A. FM 훈련 시스템 조사

## A0. 한 줄 요약 — 훈련은 "성장 시스템"이 아니라 **자원관리 시스템**이다

FM의 훈련 탭이 실제로 산출하는 것은 셋이다:

| 산출 | 내용 | 유스 성장과의 관계 |
|---|---|---|
| ① **성장 가속·배분** | 코치 질·시설·개인훈련 포커스가 CA 증가의 **계수와 방향**에 개입 | 유스 성장의 **곱셈 항** — 본체가 아님(효과 시즌 +2~5%) |
| ② **컨디션·피로·부상** | 훈련 강도 ↔ 체력·부상 위험·훈련 만족도 | **성장과 무관한 독립 축**. 주간 운영의 본체 |
| ③ **전술 친숙도** | Match Preparation 세션이 팀의 전술 이해도를 올림 | 성장과 무관. 경기력에 직접 영향 |

→ **훈련 탭의 재미 대부분은 ②·③에서 나오고, ①(성장)은 곁다리다.** 유스 성장 문서(`fm-youth-growth.md`)가 "성장의 본체는 나이·성격·출전"이라고 결론낸 것과 모순이 아니라 **상보적**이다.

## A1. 주간 훈련 스케줄 구조

- 훈련은 **주 단위 스케줄**로 짠다. 토요일 경기가 있는 통상 주간이면 **하루 2세션 + 강도에 따라 추가 세션 1개** 여지 `[공식/통설]`
- **클럽 등급이 가용 일수를 정한다**: 프로 클럽 = 주 전체 사용, **세미프로/아마추어 = 경기일 포함 3일만** `[공식/통설]`
- **휴식일(Rest)** 을 스케줄에 직접 배치한다. 통상 권장 = 연속 2일 훈련 후 휴식 `[통설]`
- **시즌 단계별로 성격이 다르다** `[통설]`
  - 프리시즌: 신체(Endurance·Strength·Quickness) 위주, 스쿼드가 되면 더블 세션
  - 시즌 중: 신체 비중↓, **회복·분석·전술** 비중↑
  - 주중 배치 통설: 주 초반 = 기술/전술, 목·금 = **Match Preparation**

## A2. 세션 카테고리

세션은 카테고리로 나뉘고, 각 카테고리 안에서 세부 세션을 고른다 `[공식/통설]`

> General · **Match Preparation** · Attacking · Defending · Technical · Tactical · Goalkeeping · Set Pieces · Physical · Extra-Curricular

⚠️ **출처 다수가 "nine categories"라 쓰면서 10개를 나열**한다(복수 사이트가 같은 문장을 복제). 개수는 신뢰하지 말고 **목록만** 쓸 것.

> **★ 흔한 혼동 — 세션 카테고리 ≠ 코치 배정 영역.**
> 위 목록은 **주간 스케줄에 배치하는 세션**의 분류다. 반면 **코치를 배정하는 "training areas"는 별개 목록**이고 FM24 기준 **11개**로 보고된다(A6). 두 축을 같은 것으로 착각하면 설계가 꼬인다.

- 세부 세션은 **전술적으로 구체적**이다. 예: Attacking 카테고리 안에 `Attacking Patient` / `Attacking Direct` / `Attacking Overlap` / `Defending from the Front` `[공식/통설]`
- **Extra-Curricular** = 훈련이 아니라 팀 본딩·휴식 계열 → **훈련 만족도·사기** 관리용.
- **Match Preparation** = 전술 친숙도(A5) 전용 창구.
- **Extra Session(추가 세션)은 피로를 빠르게 부른다.** 단 **유스팀은 예외적으로 이득이 크다** — 어린 선수는 추가 학습시간의 수혜가 피로 손실보다 크다 `[통설]`

## A3. 훈련 강도(Intensity) — 훈련 시스템의 핵심 트레이드오프

가장 중요한 노브. 선수 **개인별로** 강도를 지정하고, 컨디션과 연동한다 `[통설]`

| 컨디션 | 권장 강도 | 효과 |
|---|---|---|
| 초록(full) | **Double** | **세션당 발달 이득 2배**, 대신 부상 위험 소폭↑ |
| 노랑(fair) | Normal / Half | 자동 설정은 fair에서 Half로 낮춤 |
| 빨강 | No Gym / No Pitch | 보호 |

- **자동(Automatic) 설정**: 컨디션 만땅이면 Double, fair면 Half를 자동 적용 → **컨디션 미달 선수는 자동 보호**되므로 전체 부상률은 관리 가능한 수준으로 유지 `[통설]`
- 즉 FM의 훈련 강도 설계 의도 = **"컨디션이 좋을 때 강하게 굴려 이득을 뽑고, 나쁠 때 보호한다"** 는 사이클 운영.

### 모니터링 지표 `[공식/통설]`
| 지표 | 의미 |
|---|---|
| **Match Load** | 최근 경기 출전의 강도·빈도 |
| **Training Load** | 최근 훈련 강도 누적 |
| **Match Sharpness** | 실전 감각(체력과 별개) — 경기를 안 뛰면 떨어짐 |
| **Condition / Fitness Level** | 현재 체력, 훈련·경기 부하를 견딜 능력 |
| **Injury Susceptibility** | 신체 능력치·부상 이력 기반 부상 취약도 |

- Head of Sports Scientist 조언 구조: **장기 고부하 = 부상 위험↑ / 단기 고부하 = 개인·팀 발달 이득↑** `[통설]` — 이 문장이 훈련 시스템 전체의 설계 명제다.

## A4. 개인 훈련 (Individual Training)

> 상세는 자매 문서 [`fm-youth-growth.md` A4-(4)](./fm-youth-growth.md) 참조 — 여기선 훈련 시스템 관점만.

- 구성: **역할(Role) 훈련** + **추가 포커스(Additional Focus, 특정 능력치)** + **포지션 훈련** + 강도(light/average/heavy)
- 추가 포커스 강도를 올리면 해당 능력치는 빨리 오르지만 **개인 워크로드↑ · 훈련 만족도↓ · 체력↓**, 그리고 **다른 개인훈련 시간을 잠식**한다 `[공식/통설]`
- 효과 크기 `[실측]`: 특정 능력치 집중 시 **15세 시즌 +2%, 20세 시즌 +4~5%**. → **미세조정 도구**.
- 포지션 훈련은 훈련만으로 부족하고 **실제 출전이 필수** `[통설]`

## A5. Match Preparation · 전술 친숙도

- 경기 전 Match Preparation 세션에서 선수들이 **전술 친숙도(tactical familiarity)** 를 쌓는다. 친숙도가 높을수록 그 전술로 경기력이 좋아진다 `[공식/통설]`
- **친숙도는 항상 낮게 시작**한다 → 새 전술 도입 시 Match Preparation 비중을 올려야 한다 `[통설]`
- Match Preparation 안에서 다음 경기용 특정 영역(수비 위치·공격 움직임·팀워크)을 지정할 수 있다 `[공식/통설]`

## A6. 코치 · 시설

### 코치 배정
- 코치를 **training areas**(FM24 기준 **11개**로 보고)에 배정한다. 각 영역에 **별점(1~5성)** 이 매겨진다 `[통설]`
- 별점 산정에 쓰이는 **스태프 능력치 12종** `[통설]`
  > Attacking · Defending · Fitness · Mental · Tactical · Technical · GK Distribution · GK Handling · GK Shot Stopping · **Determination · Level of Discipline · Motivating**
- **DDM** = 뒤 3종(`Determination`/`Level of Discipline`/`Motivating`). **모든 영역의 별점에 공통 기여** → 5성 훈련의 필수 조건 `[통설]`
- **산식 예시** `[통설, FM2013 기준 — 최신 버전은 가중치가 다를 수 있음]`
  | 영역 | 가중식 |
  |---|---|
  | Fitness | `Fitness × 9 + DDM × 2` |
  | Technique | `Technique × 2 + DDM` |
  | Tactics | `Tactics × 2 + DDM` |
  | Ball Control | `Technical × 6 + Mental × 3 + DDM × 2` |
  | Defence | `Defensive × 8 + (Tactical + DDM) × 3` |
  | Attack | `Attacking × 6 + Tactical × 3 + DDM × 2` |
  → 패턴: **전문 능력치가 압도적 주항, DDM이 공통 보정항.**
- **한 코치가 여러 영역을 맡을수록 각 영역 별점이 떨어진다** — 공격+수비 겸임 시 각각 5성이 아니라 **3성** 수준으로 하락 `[통설]`
- **워크로드** = f(배정 코치 수, 스쿼드 인원). 목표는 **Light, 최소한 Average** — 높을수록 훈련 품질이 떨어지고 선수가 충분한 지도를 못 받는다 `[통설]`
- 실전 권장 규모: **총 17명**(GK 3 + 피지컬 3 + 세트피스 1 + 필드 10) `[통설]` → **FM 훈련 시스템은 사실상 "스태프 수집·배치 게임"이다.**

### 시설
- **Training Facilities** = 1군 훈련 효율. **Youth Facilities / Junior Coaching / Youth Recruitment** = 유스 인테이크 품질(자매 문서 A2). 전부 **Club Vision 이사회 요청**으로 승급하며 가능 여부는 재정·이사회 목표에 달림 `[공식/통설]`
- 시설은 **4종**이 있고 각각 레벨 사다리를 가지며 최상위는 `state of the art`. CA/PA 양쪽의 발달 속도에 영향 `[통설]`
- ⚠️ **시설만 올려선 부족하다** — 시설 + 코치 품질을 **함께** 올려야 효과가 난다 `[통설]`

## A6b. FM26 변경분 `[통설, 커뮤니티 보고]`
- **Automatic Intensity가 기본값** — *"선수 컨디션에 따라 훈련 강도와 휴식을 자동 설정"*. 32세 이상은 수동으로 `normal` 로 낮춰 과부하를 막는 운용이 보고됨.
- **개인훈련에 "out of possession" 역할 선택 추가** — 이전 버전에 없던 항목.
- 주간 예시(일요일 경기): 월=회복+매치리뷰 / 화=일반 워밍업 / 수=피지컬(지구력) / 목=11대11 연습경기+세트피스 / 금=기술+GK / 토=프리매치 전술+세트피스 / 일=경기.
- 보고된 이슈: 세션 색상 일관성, Match Focus 자동 삽입, 커스텀 스케줄 이름 버그, 유스팀 훈련 직접 편집 불가(Update 3에서 해소 보고).

## A7. 훈련 만족도 · 사기

- 스쿼드가 워크로드에 만족하는지가 별도 지표로 노출된다. **과부하면 불만** `[통설]`
- **Team Bonding(Extra-Curricular)** 이 만족도를 크게 올린다. 사기는 경기력에 큰 영향 `[통설]`
- FM26은 **훈련·출전 불만 시 퇴보(regress)** 한다 `[공식/통설]` → 훈련 시스템이 성장·경기력·사기를 잇는 매듭.

## A8. FM 훈련 시스템의 설계 원리 (HMB가 훔칠 것)

1. **훈련의 본질은 트레이드오프 1개다**: *강하게 굴리면 빨리 늘지만 부러진다.* 나머지(세션 종류·코치 배정)는 그 트레이드오프의 장식이다.
2. **컨디션이 자원, 강도가 지출.** 컨디션 사이클을 읽고 언제 밟을지 고르는 게임.
3. **개인훈련은 미세조정, 팀훈련은 컨디션·친숙도 관리.** 성장 본체가 아니다.
4. **코치·시설은 곱셈 계수**일 뿐 새로운 축이 아니다 — 돈으로 계수를 사는 구조. 단 FM은 여기에 **스태프 17명 수집·배치**라는 별도 수집 게임을 얹었다(A6) — **HMB엔 이미 선수 카드 수집이 있으므로 이 층은 겹친다.**
5. **과부하는 즉시 처벌된다**(부상·불만·퇴보) → 액셀만 밟을 수 없게 만드는 안전장치.

---

# 파트 B. HMB 적용 연구 — 팀 훈련

## B1. HMB 현황 대조 — 세 산출 중 **하나는 이미 있다**

| FM 훈련 산출 | HMB 현재 | 판정 |
|---|---|---|
| ① 성장 가속·배분 | 없음(성장 자체가 미도입) | 유스 성장안의 `facilityMult` 슬롯이 **정확히 이 자리** |
| ② 컨디션·피로·부상 | **P2-D5 컨디션 실효 이미 존재** — 매치별 시드 결정론 롤 → `SelectData` 능력치 배율(6시 −15% ~ 12시 +10%), 엔진 무수정 | ⚠️ **현재는 유저가 손댈 수 없는 순수 롤**. 훈련 강도를 넣으면 **컨디션이 유저 통제 자원으로 승격**된다 = 가장 큰 게임성 이득 |
| ③ 전술 친숙도 | 없음 | HMB는 전술을 **AI 프롬프트**가 만든다 → "친숙도"는 **프리셋 숙련도**로만 번안 가능(B3-T4). 리스크 있음 |

> **핵심 발견**: HMB에 훈련 시스템을 넣는 가장 큰 이유는 성장이 아니라 **"컨디션 롤을 의사결정으로 바꾸는 것"** 이다. 이미 컨디션 배율 파이프(P2-D5)가 깔려 있어 **엔진·계약 변경 없이** 얹을 수 있다.

## B2. 유스 성장안과의 경계 — **분리 / 맞물림**

```
        ┌─────────────────────────────┐
        │  팀 훈련 (매치 "사이" 레이어) │   주기: 경기 간 / 자원: 컨디션·부상
        │  · 훈련 강도                  │   대상: 스쿼드 전체 (실선수 포함)
        │  · (선택) 코치·시설 계수      │   산출: 컨디션 배율 · 부상 · 성장 계수
        └───────────┬─────────────────┘
                    │  접점은 딱 3개 노브
                    ↓  ①growthMult ②conditionMult ③injuryRisk
        ┌─────────────────────────────┐
        │  유스 성장 (매치 "결과" 레이어)│   주기: 매치 정산 / 자원: 나이·PA
        │  · Δovr = f(나이·성격·출전…)  │   대상: 유스 카드만
        │  · 방향 = 경기 지령 프롬프트   │   산출: 능력치 상승 · 등급 승급
        └─────────────────────────────┘
```

| | 팀 훈련 | 유스 성장 |
|---|---|---|
| **시간 단위** | 경기 사이(단기, 반복) | 매치 정산 누적(장기, 시즌) |
| **대상** | 스쿼드 전체(실선수 포함) | 유스 카드만(안 2 기준) |
| **유저 입력** | 강도 다이얼 | **경기 지령 프롬프트**(방향) |
| **주된 산출** | 컨디션·부상 | 능력치·등급 |
| **없으면?** | 컨디션이 그냥 롤로 남음(현행) | 육성 서사 없음 |

**분업 정리 — 셋이 안 겹친다:**
- **방향(무엇이 자라나)** = 경기 지령 프롬프트 → `TacticalInput.behavior` (유스 문서 B1)
- **총량(얼마나 자라나)** = 나이·성격·출전·`execMatch` (유스 문서 B3)
- **계수(얼마나 빨리/안전하게)** = **훈련 강도·시설·코치** ← 이 문서

→ hero가 앞서 확정한 *"훈련 화면 말고 경기 지령이 성장을 만든다"* 와 **충돌하지 않는다.** 지령은 **방향**이고, 훈련은 **계수**다. 훈련 시스템은 "능력치를 어디에 붙일까"를 묻지 않으므로 입력이 중복되지 않는다.

## B3. 설계 옵션

### T안 1 — **미도입** (현행 유지)
컨디션은 P2-D5 롤 그대로, 훈련 개념 없음.
- 👍 비용 0. 👎 컨디션이 **유저가 못 만지는 랜덤**으로 남음 → "왜 오늘 애가 6시지" 무력감. 로테이션 의사결정 없음.

### T안 2 — **훈련 강도 1노브** ★ 권장 (최소 스펙)
경기 사이에 **강도 하나만** 고른다: `가볍게 / 보통 / 강하게`. (필요 시 선수별 오버라이드)

| 강도 | 다음 경기 컨디션 | 성장 계수 | 부상 위험 |
|---|---|---|---|
| 가볍게 | ↑ (회복) | ×0.6 | 최저 |
| 보통 | 유지 | ×1.0 | 기준 |
| 강하게 | ↓ (피로 누적) | **×1.8** | ↑ |

- FM A3의 **"컨디션 좋을 때 밟고 나쁠 때 보호"** 사이클을 노브 1개로 압축. FM 재미의 8할(A8-1)을 5% 비용으로 가져온다.
- 리그 18R = 연속 경기 → **컨디션 누적/회복 사이클**이 자연히 생기고 **로테이션·벤치 활용에 의미**가 붙는다(유스 문서 D-12 벤치 성장과 시너지).
- 👍 모바일 화면 1개(또는 브리핑 안의 다이얼 1개), 엔진 변경 0, 기존 컨디션 파이프 재사용. 👎 깊이는 얕다.

### T안 3 — **주간 스케줄 이식** (FM 정식)
세션 슬롯·카테고리·코치 배정·시설.
- 👍 최대 깊이, 시뮬 고증. 👎 **모바일에 과중**(P2-D2 390px 퍼스트와 정면충돌), 화면 3~4개 신설, 그리고 **FM의 코치 시스템은 실질적으로 "스태프 17명 수집·배치 게임"**(A6) 인데 HMB엔 스태프 엔티티가 아예 없다 → **선수 카드 수집과 경쟁하는 제2의 수집축**을 여는 셈. 게다가 **FM 자신도 이 부분의 성장 실효는 작다**(A0-①). **비용 대비 재미가 최악.**
- 판정: **Phase 2 비범위.** 도입한다면 코치·시설을 **레벨 다이얼 2개**로만 축약(T안 2에 흡수).

### T안 4 — **프리셋 숙련도** (전술 친숙도 번안)
같은 팀 프리셋(P2-D3 스냅샷)을 반복 사용하면 숙련도가 쌓여 보정.
- 👍 FM 친숙도의 HMB 번안, 프리셋 시스템에 무게를 실어줌. 👎 ⚠️ **HMB 차별점과 역행 위험** — "매 경기 프롬프트를 새로 쓰는 재미"를 페널티로 억누른다. AI 인풋 다양성이 죽으면 게임의 정체성이 흔들린다.
- 판정: **백로그.** 도입 시엔 "미숙 페널티"가 아니라 **"숙련 보너스만"**(하방 없음)으로.

### 권장: **T안 2 단독 착수 → T안 3의 계수(코치·시설)만 나중에 흡수**
`trainingIntensity` 를 매치 입력에 넣고, 컨디션 롤 함수와 유스 `Δovr` 계수에 곱하는 것으로 끝. 신규 엔티티 0.

## B4. 결정론 정합

```
[web]  브리핑에서 훈련 강도 선택 (다음 경기용)
   ↓  matches.trainingIntensity 로 저장 = 매치 입력의 일부
[server-java]  ★ 권위
   - 컨디션 롤: seed = hash(matchId, playerId, trainingIntensity) → SelectData 배율 (P2-D5 파이프 그대로)
   - 부상 롤: 같은 시드 계열, 매치 정산 시 결정론 적용·멱등
   - 유스 Δovr 에 growthMult[intensity] 곱
   ↓
[engine]  ★ 무변경. 강도는 SelectData 배율로만 도달 → match-log 재생 bit-identical
```

- **AI 호출 증분 0** (강도는 UI 다이얼, 프롬프트 아님) → P2-D8 무부하.
- `matches` 스냅샷에 강도가 남으므로 **과거 매치 재현 100% 유지**.
- 부상은 **매치 후 정산에서만** 발생시켜 매치 시뮬 내부를 오염시키지 않는다(엔진 계약 불변).

## B5. 최소 스펙 (T안 2)

| # | 스코프 | 모듈 | 필수도 |
|---|---|---|---|
| **T1** | `trainingIntensity` 3단계 — 매치 입력 필드 + 브리핑 다이얼 | web + server-java | ★필수 |
| **T2** | 컨디션 롤에 강도 반영(회복/피로 누적) — P2-D5 함수 확장, config | server-java | ★필수 |
| **T3** | 부상 롤 — 강도·`physical`·출전부하 기반, 결정론·멱등. 부상 시 N경기 결장 | server-java | ★필수 |
| **T4** | 유스 `Δovr` 에 `growthMult[intensity]` 결합 (유스 문서 B3 수식의 `facilityMult` 자리) | server-java | ○ 유스 착수 시 |
| **T5** | 스쿼드 컨디션/부하 표시 — 시계 UI(기존) + 부하 경고 | web | ○ |
| **T6** | 시설·코치 레벨 다이얼(포인트 sink) — T안 3의 계수만 흡수 | server-java + web | △ 후속 |
| **—** | **엔진** | `packages/engine/**` | **변경 0** |

**AC 초안**
- AC-T1: 같은 매치를 같은 강도로 재정산 시 컨디션·부상 결과 **바이트 동일**(결정론).
- AC-T2: 강도 3단계가 **컨디션·성장·부상에 단조적으로** 다른 결과를 낸다(트레이드오프 존재 증명).
- AC-T3: 강도 도입 후에도 **과거 match-log 재생 bit-identical**.
- AC-T4: `강하게` 연속 운용 시 **부상·컨디션 저하가 누적**되어 순이득이 사라지는 지점이 존재(액셀만 밟기 불가 — A8-5 이식).
- AC-T5: AI 호출·토큰 증분 **0**.

## B6. 리스크

| 리스크 | 완화 |
|---|---|
| 최적해가 1개면 다이얼이 무의미("항상 강하게") | AC-T4 — 누적 페널티로 **상황 의존 최적해**를 강제. 리그 18R 연전이 자연스러운 압박 |
| 부상이 카드 게임에서 스트레스 유발(내 LEGEND가 결장) | 경미한 결장(1~2경기)부터, 장기부상 확률 극소. 부상 자체를 config로 끌 수 있게(`injury.enabled`) |
| 컨디션 랜덤성이 이미 있는데 강도까지 얹으면 인과가 흐려짐 | 브리핑에 **"지난 경기 강도 → 이번 컨디션" 인과를 명시 표시**(성장 리포트와 같은 철학) |
| T안 3으로 스코프 크립 | 코치·시설은 **레벨 다이얼**로만. 세션 스케줄 UI는 명시적 비범위 |
| 유스 성장안과 입력 중복 | B2 분업(방향=프롬프트 / 총량=출전 / 계수=강도) — 겹치지 않음을 설계 원칙으로 박제 |

---

# 파트 C. 두 시스템의 관계 — 결론

| 질문 | 답 |
|---|---|
| **FM에서 둘은 별개인가?** | **별개다.** 유스 성장(CA/PA·인테이크·나이곡선)과 훈련(주간 스케줄·강도·세션·코치)은 다른 화면·다른 주기·다른 산출. 접점은 훈련이 성장의 **계수·배분**에 개입하는 지점뿐이고, 그 실효는 작다(시즌 +2~5%). |
| **HMB에서도 분리해야 하나?** | **분리한다.** 훈련 = 경기 사이 자원관리(컨디션·부상), 성장 = 매치 결과 누적(능력치·등급). 화면·주기·데이터가 다르다. |
| **어디서 맞물리나?** | **노브 3개뿐** — ①`growthMult`(강도가 성장 속도에 곱) ②`conditionMult`(강도가 다음 경기 컨디션) ③`injuryRisk`. 그 외 결합 없음. |
| **입력이 중복되나?** | **아니다.** 방향=경기 지령 프롬프트 / 총량=출전·나이·성격 / 계수=훈련 강도. 3분업. |
| **HMB에 훈련을 넣는 진짜 이유는?** | 성장 가속이 아니라 **컨디션(P2-D5)을 랜덤 롤에서 유저 의사결정으로 승격**시키는 것. 파이프가 이미 깔려 있어 비용이 낮다. |
| **착수 순서 권장** | 유스 성장(M1~M4) **먼저**, 훈련 강도(T1~T3)는 **독립적으로 언제든** 착수 가능(유스 없이도 단독 가치가 있음 — 컨디션 통제). 둘 다 엔진 변경 0. |

## hero 결정 필요사항 (훈련 축)

| # | 결정 | 옵션 | 리서치 권장 |
|---|---|---|---|
| **T-D1** | 훈련 시스템 도입? | 미도입 / **강도 1노브** / 주간 스케줄 | **T안 2 강도 1노브** |
| **T-D2** | 주간 스케줄·세션·코치 배정 | 도입 / 비범위 | **Phase 2 비범위**(모바일 과중 + FM에서도 실효 작음) |
| **T-D3** | 부상 도입? | 예 / 아니오 / config 토글 | **config 토글로 도입**(경미 결장 위주) — 없으면 강도 트레이드오프가 성립 안 함 |
| **T-D4** | 전술 친숙도(프리셋 숙련도) | 도입 / 백로그 | **백로그** — HMB의 "매 경기 새 프롬프트" 재미와 역행 위험 |
| **T-D5** | 강도 적용 단위 | 팀 일괄 / 선수별 | **팀 일괄 우선**(모바일), 선수별은 후속 |
| **T-D6** | 시설·코치 계수 | 도입 / 후속 | **후속**(T6) — 포인트 sink가 더 필요해질 때 |
| **T-D7** | 착수 순서 | 훈련 먼저 / **유스 먼저** / 병렬 | **유스 먼저**(이슈 #172 본안), 훈련은 독립 착수 가능 |

**미해결·후속 조사거리**
- SI 공식 매뉴얼 직접 열람(403 지속) — 세션 카테고리 **정확 개수**와 강도 수치의 1차 출처는 여전히 미확보(복수 2차 출처가 "nine"이라 쓰며 10개를 나열하는 모순을 그대로 복제 중).
- **코치 별점 산식은 FM2013 기준**만 확보 — 최신 버전 가중치 미확인(fmcalc.com FM26 계산기는 본문 추출 실패).
- FM26 변경분은 **커뮤니티 블로그 1건 기반** — Automatic Intensity 기본값·out-of-possession 개인훈련 역할 외 추가 변경은 미검증.
- 강도 → 성장/부상의 **정량 관계**(예 Double이 정확히 몇 배)는 `[통설]` 수준. "Double = 세션 이득 2배" 이상의 수치 근거 없음.
- 부상 모델을 HMB 능력치 9종(특히 `physical`·`stamina`)에 어떻게 연결할지 — 별도 소조사 필요.

---

## 출처

**훈련 구조·세션·스케줄**
- [Sports Interactive 공식 매뉴얼 — Training (FM24)](https://community.sports-interactive.com/sigames-manual/football-manager-2024/training-r4961/) *(직접 열람 403 — 검색 스니펫 경유)*
- [Sports Interactive 공식 매뉴얼 — Training (FM23)](https://community.sports-interactive.com/sigames-manual/football-manager-2023/training-r4731/)
- [Neoseeker — FM22 Training Guide](https://www.neoseeker.com/football-manager-2022/guides/Training)
- [Passion4FM — The Ultimate Pre-Season Training Guide](https://www.passion4fm.com/football-manager-pre-season-training-guide/)
- [Passion4FM — Training Guides & Tips](https://www.passion4fm.com/guides/training/)

**강도·부하·부상**
- [sortitoutsi — FM24 Guide: How to Reduce Injuries](https://sortitoutsi.net/content/67669/guide-fm24-how-to-reduce-injuries)
- [Evidence Based Football Manager — How training intensity affects player growth / injury risk](https://www.youtube.com/watch?v=V7PmJP0DzTo)

**개인 훈련**
- [Guide to FM — Individual Training](https://www.guidetofm.com/training/individual/)
- [Guide to FM — Additional Focus](https://www.guidetofm.com/training/additional-focus/)
- [FM-Arena — Meta Attributes Weighted Training: Additional Focus](https://fm-arena.com/thread/9309-meta-attributes-weighted-training-part-4-additional-focus/)

**Match Preparation·전술 친숙도**
- [Guide to FM — Match Preparation Training](https://www.guidetofm.com/training/match-preparation/)
- [RealSport — FM17 Complete Training Guide (친숙도)](https://realsport101.com/football-manager/fm17-training-guide/)

**코치·시설**
- [FM Scout — Staff Attributes and Training Ratings Explained](https://www.fmscout.com/a-staff-attributes-and-training-ratings-explained.html) *(직접 열람 403 — 검색 스니펫 경유)*
- [FM Scout — FM2023 Coach Rating Calculator](https://www.fmscout.com/f-coach-rating-calculator.html) *(산식·가중치 출처)*
- [fmcalc.com — Football Manager 2026 Coach Calculator](https://fmcalc.com/) *(본문 추출 실패 — 최신 가중치 미확보)*
- [FMInside — How to create 5 star training](https://fminside.net/guides/training-guides/42-how-to-create-5-star-training)
- [Guide to FM — Assigning Coaches](https://www.guidetofm.com/training/assigning-coaches/) *(직접 열람 403 — 검색 스니펫 경유)*
- [Passion4FM — Best FM26 Coaches / 5-Star Coaching Team](https://www.passion4fm.com/football-manager-best-coaches/)
- [Passion4FM — How to Find the Best Coaches](https://www.passion4fm.com/find-best-coaches-in-football-manager/)
- [Passion4FM — Training Facilities & Its Levels](https://www.passion4fm.com/football-manager-training-facilities-levels/)
- [nO THROW — What You Need to Know About FM Facilities Levels](https://nothrow.com/football-manager-facilities-levels/)
- [SI Community — What's more important in training: star quality or coach workload?](https://community.sports-interactive.com/forums/topic/574532-whats-more-important-in-training-star-quality-or-coach-workload/)

**FM26 변경분**
- [CoffeehouseFM — FM26: My training regime](https://coffeehousefm.com/fmrensieblog/fm26-my-training-regime)
- [Football Manager 공식 — Set Pieces Refresh and Coaches Debut (FM26)](https://www.footballmanager.com/features/set-pieces-refresh-and-coaches-debut)
- [GiveMeSport — FM24 Training Guide](https://www.givemesport.com/football-manager-2024-training-guide/)
