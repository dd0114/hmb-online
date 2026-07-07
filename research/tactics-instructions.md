# HMB 온라인 — 전술/지시 시스템 → AI 프롬프트 매핑 조사

> **목적**: Football Manager(FM)의 정형화된 전술·지시 시스템(슬라이더/드롭다운)이 실제로 어떤 파라미터로 구성되는지 분석하고, HMB 온라인이 이를 **선수 개개인에게 자연어 AI 프롬프트로 주입**하는 방식으로 어떻게 대체/보완할지 매핑을 설계한다.
>
> **차별점 요약**: FM = 유저가 팀/개인 지시를 UI 위젯으로 세팅. HMB = 동일한 전술 의도를 **자연어 프롬프트**로 선수 에이전트에 주입 → LLM 이 상황 맥락과 결합해 행동을 해석.

---

## 1. FM 팀 인스트럭션 구조

FM 의 팀 지시는 크게 **멘탈리티(Mentality)** 라는 상위 프리셋 위에, **국면(phase)별 세부 지시**가 얹히는 2층 구조다.

### 1.1 멘탈리티 (최상위 리스크 다이얼)

- 멘탈리티는 "팀 전체의 리스크 성향(baseline attitude toward risk)"을 결정하는 **시작점**이며, 개인 지시가 적용되기 전에 이미 압박·수비 라인 높이·폭·템포·패스 직접성을 좌우한다. ([Operation Sports](https://www.operationsports.com/football-manager-26-how-team-mentality-shapes-everything-you-do/))
- 스펙트럼: **Very Defensive → Defensive → Cautious → Balanced → Positive → Attacking → Very Attacking** (7단계). Balanced 가 중립. ([Operation Sports](https://www.operationsports.com/football-manager-26-how-team-mentality-shapes-everything-you-do/))
- 멘탈리티가 높아질수록: 패스가 더 일찍·더 공격적으로 나가고, 오프 더 볼 움직임이 공격적으로 변하며, 수비 라인과 교전 라인(Line of Engagement)이 전진하고, 선수들이 포지션을 더 자주 이탈한다. FM26 에서 "긴박함(urgency)"은 **템포 + 패스 직접성 + 드리블 빈도의 조합**으로 정의된다. ([Operation Sports](https://www.operationsports.com/football-manager-26-how-team-mentality-shapes-everything-you-do/))

### 1.2 국면별 세부 지시 (In Possession / In Transition / Out of Possession)

| 국면 | 대표 지시 항목 | 표현 방식 |
|------|----------------|-----------|
| **In Possession (공격)** | Tempo(템포), Width(폭), Passing Directness(패스 직접성/짧게-길게), Play Out of Defence, Work Ball Into Box, Be More Expressive/Disciplined, Overlap/Underlap | 슬라이더(높음/낮음/보통) + on/off 토글 |
| **In Transition (전환)** | Counter(역습), Counter-Press(즉시 재압박), Hold Shape, Distribution(GK 배급: 짧게/길게/특정 선수) | 토글 + 드롭다운 |
| **Out of Possession (수비)** | Pressing / Line of Engagement(교전 라인), Defensive Line(수비 라인 높이), Pressing Urgency(압박 강도), Trigger Press(압박 트리거), Offside Trap(오프사이드 트랩), Prevent Short GK Distribution, Tighter/Standard Marking | 슬라이더(Low/Mid/High Block) + on/off 토글 |

- **Pressing**은 볼 소유팀에 대한 조직적 압박으로, 높은 위치(High Press)에서 걸거나 깊은 블록(Low Block)에서 걸 수 있으며, High Press 시스템은 스쿼드 전체 스태미나 14+·근성 13+·자연 체력 14+ 같은 물리 조건을 요구한다. ([Guide to FM](https://www.guidetofm.com/tactics/team-instructions/))
- **Defensive Line & Line of Engagement**: 멘탈리티가 이 두 라인을 함께 밀어 올린다. Mid Block 은 수비 라인이 하프라인 근처에 서고 선택적으로 압박하는 균형형. ([Guide to FM](https://www.guidetofm.com/tactics/team-instructions/), [Operation Sports](https://www.operationsports.com/football-manager-26-how-team-mentality-shapes-everything-you-do/))
- **Width & Tempo 상호작용**: 폭을 넓혀 상대 블록을 벌리고, 상대가 정비하기 전에 높은 템포로 볼을 빠르게 이동시킨다. ([Guide to FM](https://www.guidetofm.com/tactics/team-instructions/))

**팀 지시 vs 개인 지시**: 팀 지시는 특정 선택에 대해 **팀 전체를 가감(boost/negate)**하고, 개인 지시는 그 선택에 대해 **개별 선수/역할만 가감**한다. ([FM Scout](https://www.fmscout.com/q-22748-Team-instructions-Vs-player-instructions.html))

---

## 2. 역할·임무(Roles & Duties) + 개인 인스트럭션

### 2.1 임무(Duty) — Defend / Support / Attack

임무는 선수가 **필드의 어느 구역에서 활동하고 얼마나 전진/모험하는지**를 정의한다. ([Passion4FM](https://www.passion4fm.com/football-manager-player-role-combinations-duty-pairs/))

| Duty | 행동 정의 |
|------|-----------|
| **Defend** | 뒤로 물러서 수비를 커버, 깊은 위치에서 크로스. 보수적으로 위치 유지. |
| **Support** | 미드필드 플레이를 더 지원, 스루/대각 패스에 적극적, 적절 시 박스로 볼 투입. 수비 커버는 줄고 미드필드 라인에 맞춰 위치. |
| **Attack** | 더 전진, 파이널 서드에서 빠른 크로스·마무리. |

임무는 팀 전체에 **수직·수평으로 분산**해야 균형이 잡힌다(모든 attack 을 최전방/한쪽 측면에 몰지 말 것). ([FM Scout via search](https://www.fmscout.com/a-guide-to-player-roles-in-football-manager.html))

### 2.2 역할(Role) — 포지션별 전문화

FM26 기준 포지션별 대표 역할(임무 조합 가능): ([FRVR](https://frvr.com/blog/football-manager-26-all-player-positions-and-roles-explained/))

- **골키퍼**: Standard, Sweeper Keeper, Ball-Playing Goalkeeper, No-Nonsense GK
- **센터백**: Ball-Playing Centre-Back, Covering/Stopping CB, Overlapping CB, No-Nonsense CB
- **풀백**: Full-Back, Inverted Full-Back(인버티드), Pressing Full-Back, Holding Full-Back
- **수비형 MF**: Deep-Lying Playmaker(딥라잉 플레이메이커), Half-Back, Screening/Pressing DM
- **중앙 MF**: Box-to-Box Midfielder(박스투박스), Midfield Playmaker(구 Advanced Playmaker), Pressing Central Midfielder(구 Ball-Winning Midfielder 계열), Channel Midfielder
- **공격수**: Poacher(포처), False Nine(폴스 나인), Target Forward(구 Target Man), Deep-Lying Forward, Channel Forward
- **윙어**: Winger, Inside Forward, Inverting Outlet Winger, Wide Playmaker

> 각 역할은 고유한 사전 세팅된 개인 지시를 내장한다. 예: Deep-Lying Playmaker 는 볼을 잡고 템포를 조율하며 깊은 위치에서 배급, Poacher 는 최전방 고정 + 오프사이드 라인 침투에 집중. ([Medium — Understanding roles](https://v-maedhros.medium.com/understanding-roles-in-football-manager-and-real-life-part-1-73054cfbb303))

### 2.3 개인 인스트럭션(Individual Instructions)

역할 위에 추가로 얹는 개별 지시. 일부는 역할에 고정되어 변경 불가, 일부는 추가 가능. ([Passion4FM](https://www.passion4fm.com/football-manager-player-instructions/))

| 카테고리 | 대표 옵션 |
|----------|-----------|
| **공격 성향** | Take More Risks(모험적 패스), Shoot More Often, Dribble More, Get Further Forward, Roam From Position(포지션 이탈 로밍) |
| **움직임/위치** | Stay Wider, Sit Narrower, Move Into Channels, Hold Position |
| **패스** | Pass It Shorter, Cross More Often, Cross Less Often, Cross From Deep |
| **수비** | Close Down More(강한 압박), Mark Tighter(밀착 마킹), Tackle Harder, Mark Specific Player/Position(특정 선수·포지션 마킹), Ease Off Tackles |

- 예: "Take More Risks"는 창의성/공격 위협을 높이지만 패스 정확도를 약간 낮추는 트레이드오프가 있다. ([VideoGamer](https://www.videogamer.com/features/uncovering-the-best-individual-instructions-in-all-of-football-manager/))
- "Mark Specific Player/Position"은 특정 상대(예: 상대 플레이메이커)를 경기에서 지워버리도록 밀착 추적시킨다. ([Passion4FM](https://www.passion4fm.com/football-manager-player-instructions/))

---

## 3. 멘탈리티·심리 요소

FM 은 전술 지시 외에 **선수 심리(사기/모멘텀/맨 매니지먼트)**를 별도 레이어로 다룬다. HMB 에서는 이 부분이 특히 자연어 프롬프트와 궁합이 좋다.

- **팀 톡(Team Talk)**: 경기 전/하프타임/경기 후 감독 발언이 사기에 영향. 경기 후 톡이 가장 중요(장기 사기), 하프타임·경기 전 톡은 주로 경기 중 사기(모멘텀)에 작용. 무슨 말을 하느냐 + **바디 랭기지**가 전달 효과를 좌우. ([Passion4FM — Morale](https://www.passion4fm.com/how-to-improve-players-morale-happiness-in-football-manager/))
- **개인차 적응**: 어떤 선수는 동기부여형 톡을 선호, 어떤 선수는 기대와 안 맞으면 반발. 성공적 감독은 시나리오별로 톡을 **적응(adapt)**시킨다. ([Passion4FM — Morale](https://www.passion4fm.com/how-to-improve-players-morale-happiness-in-football-manager/))
- **사기(Morale) 관리**: 최근 폼·직전 경기·훈련·클럽 내 처신에 대한 칭찬으로 사기 상승. 패배에 부정적으로 반응하면 오히려 선수가 위축됨. ([Guide to FM — Morale](https://www.guidetofm.com/squad/morale-relationships/), [VideoGamer — Morale](https://www.videogamer.com/features/how-to-improve-morale-quickly-on-football-manager-and-keep-morale-high/))
- **팀 리더/주장**: 리스펙트 높은 선수를 주장으로 → 최대 동기부여자, 팀 리더를 우군으로 두면 나머지 신뢰 획득. ([Passion4FM — Morale](https://www.passion4fm.com/how-to-improve-players-morale-happiness-in-football-manager/))
- **모멘텀 = 멘탈리티 반영**: 멘탈리티가 오를수록 팀 포커스가 "통제"에서 "전진 모멘텀"으로 이동. 심리 상태가 전술 실행 강도에 직접 반영. ([Operation Sports](https://www.operationsports.com/football-manager-26-how-team-mentality-shapes-everything-you-do/))

> **HMB 함의**: 팀 톡/사기는 정형 UI(감정 선택 드롭다운)보다 자연어 프롬프트로 표현할 때 훨씬 풍부해진다. 예: "지고 있어도 침착하게, 후반 15분에 승부를 건다는 마인드로 뛰어라" 같은 서술형 지시를 선수별 성향(멘탈 속성)에 맞춰 LLM 이 해석.

---

## 4. 지시 → AI 프롬프트 매핑

FM 의 정형 지시를 HMB 자연어 프롬프트로 변환하는 핵심 매핑. "대체"=자연어가 UI 위젯을 완전히 갈음, "보완"=수치 파라미터를 유지하되 자연어로 뉘앙스 추가.

| # | FM 지시 항목 | 기존 표현 (슬라이더/옵션) | HMB 자연어 프롬프트 예시 | 대체 / 보완 |
|---|--------------|---------------------------|--------------------------|-------------|
| 1 | Mentality (팀 리스크) | 7단계 슬라이더 (Very Defensive~Very Attacking) | "오늘은 무리하지 말고 안정적으로, 실점 안 하는 걸 최우선으로 뛰어라" | 대체 |
| 2 | Tempo (템포) | 슬라이더 Low/Standard/High | "볼을 빠르게 순환시키고 상대가 정비하기 전에 공격을 전개해라" | 대체 |
| 3 | Passing Directness | 슬라이더 Short↔Direct | "짧은 패스로 점유율을 유지하되, 앞 공간 열리면 과감히 찔러라" | 대체 |
| 4 | Defensive Line / Line of Engagement | 슬라이더 Low/Mid/High Block | "수비 라인을 높게 올려 상대를 하프라인 위에서 가둬라" | 대체 |
| 5 | Pressing Urgency + Trigger Press | 슬라이더 + 토글 | "상대 센터백이 볼 잡으면 즉시 두 명이 달려들어 압박해라" | 대체 |
| 6 | Offside Trap | on/off 토글 | "라인을 맞춰 올려 상대 침투를 오프사이드로 걸어라" | 보완 (안전을 위해 on/off 플래그 병행) |
| 7 | Player Role (예: Deep-Lying Playmaker) | 드롭다운 선택 | "너는 후방에서 볼을 잡고 경기 템포를 조율하는 조율자다. 깊은 위치에서 전방으로 배급해라" | 보완 (역할 프리셋 + 서술로 뉘앙스) |
| 8 | Duty (Defend/Support/Attack) | 3단 드롭다운 | "수비를 커버하되 기회가 오면 미드필드 지원까지만 올라가라 (support)" | 대체 |
| 9 | Individual: Roam From Position | 토글 | "정해진 자리에 얽매이지 말고 빈 공간을 찾아 자유롭게 움직여라" | 대체 |
| 10 | Individual: Take More Risks | 토글 | "정확도가 좀 떨어져도 좋으니 상대 수비 뒷공간을 노리는 모험적인 패스를 시도해라" | 대체 |
| 11 | Mark Specific Player | 드롭다운(대상 선택) | "상대 10번 플레이메이커를 밀착 마크해서 경기에서 지워버려라" | 대체 |
| 12 | Cross More / Work Ball Into Box | 토글 | "측면에서 일찍 크로스 올리지 말고, 박스 안까지 볼을 몰고 들어가 확실한 기회를 만들어라" | 대체 |
| 13 | Counter / Counter-Press (전환) | 토글 | "볼 뺏기면 5초 안에 즉시 재압박, 되찾으면 빠르게 역습으로 전환해라" | 대체 |
| 14 | Team Talk / Morale | 감정·문구 드롭다운 | "지고 있어도 흔들리지 마라. 침착하게 후반에 뒤집는다는 각오로 집중해라" | 보완 (선수 멘탈 속성과 결합) |

---

## 5. 프롬프트 프리셋 후보

유저가 원클릭으로 불러 쓸 수 있는 **팀 단위 자연어 프롬프트 프리셋** (선수별로 자동 개인화 주입):

- **역습 위주(Counter-Attack)** — 깊게 물러서 블록을 유지하다, 볼을 뺏는 즉시 최전방으로 빠르게 전환. (Low Block + 높은 전환 템포)
- **높은 압박 유지(High Press)** — 상대 빌드업을 하프라인 위에서 질식시키고, 볼 잃으면 즉시 재압박. (High Line + Counter-Press)
- **상대 약점 측면 집중 공략(Overload Weak Flank)** — 상대 약한 풀백 쪽으로 폭을 넓혀 오버랩·크로스로 반복 침투.
- **수비 안정 우선(Defensive Solidity)** — 리스크 최소화, 라인 컴팩트 유지, 실점 0 을 최우선으로 안전한 선택.
- **볼 점유 극대화(Possession Control)** — 짧은 패스로 점유율 지배, 낮은 템포로 상대를 끌어내고 인내심 있게 기회 창출.
- **상대 플레이메이커 봉쇄(Playmaker Lockdown)** — 지정 미드필더가 상대 핵심 창조자를 밀착 마크해 배급 라인을 끊음.
- **측면 폭 활용 스위칭(Wide Switching)** — 넓은 폭 + 빠른 사이드 체인지로 상대 블록을 좌우로 흔들어 벌림.
- **후반 총공세(Late-Game Push)** — 리드/추격 상황에서 멘탈리티를 끌어올려 라인 전진·공격 임무 가중, 모험적 마무리.

---

## 부록: 출처 URL

- https://www.guidetofm.com/tactics/team-instructions/
- https://www.operationsports.com/football-manager-26-how-team-mentality-shapes-everything-you-do/
- https://frvr.com/blog/football-manager-26-all-player-positions-and-roles-explained/
- https://www.passion4fm.com/football-manager-player-instructions/
- https://www.passion4fm.com/how-to-improve-players-morale-happiness-in-football-manager/
- https://www.passion4fm.com/football-manager-player-role-combinations-duty-pairs/
- https://www.fmscout.com/q-22748-Team-instructions-Vs-player-instructions.html
- https://www.fmscout.com/a-guide-to-player-roles-in-football-manager.html
- https://www.videogamer.com/features/uncovering-the-best-individual-instructions-in-all-of-football-manager/
- https://www.videogamer.com/features/how-to-improve-morale-quickly-on-football-manager-and-keep-morale-high/
- https://www.guidetofm.com/squad/morale-relationships/
- https://v-maedhros.medium.com/understanding-roles-in-football-manager-and-real-life-part-1-73054cfbb303
