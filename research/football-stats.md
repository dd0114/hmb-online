# 실제 축구 데이터 벤치마크 — HMB 매치 엔진 재튜닝용

> 목적: HMB 온라인 매치 엔진(Tier B 공간 시뮬)의 `EngineConfig` 파라미터를 실제 프로 축구(주로 프리미어리그/Opta)의 수치에 맞추기 위한 벤치마크.
> 모든 수치는 90분 경기 기준, **팀 단위** 또는 **양팀 합**을 명시. 수치는 범위로 표기.
> 데이터 소스: Opta/StatsPerform(theanalyst.com), premierleague.com, FBref, CIES Football Observatory, FIFA. 조사일: 2026-07-08.
> ⚠️ 주의: FBref 는 봇 차단(403)으로 직접 fetch 불가 → 해당 수치는 검색 요약 및 교차 확인된 값으로 표기. FBref URL 은 참고용으로 병기.

---

## 1. 경기장·기본 규격

| 항목 | 값 | 출처 |
|------|-----|------|
| 표준 프로 규격 (가장 널리 사용) | **105 m (길이) × 68 m (폭)** | FIFA / PL 핸드북 |
| FIFA 국제경기 허용 범위 | 길이 100–110 m × 폭 64–75 m | FIFA Laws of the Game |
| PL 핸드북 표준 | 115 yds (105 m) × 74 yds (68 m) | 2022/23 PL Handbook |
| 실제 편차 예 | Craven Cottage 100×65, Tottenham 105×68 | (구단별 선택 가능) |

- 총 면적 ≈ **7,140 m²** (105×68). 하프코트 52.5×68.
- 출처: https://diamondfootball.com/news/4115/football-pitch-sizes-explained , https://www.harrodsport.com/advice-and-guides/football-pitch-dimensions-guide

---

## 2. 패스·점유·턴오버

**엔진 pass 성공확률·인터셉트 튜닝의 근거.**

| 지표 | 실제 벤치마크 | 비고 / 출처 |
|------|--------------|------------|
| 팀당 경기 패스 시도 | 대략 **350–650**, 점유형 상위팀 **600–700** | Man City 2023/24 ≈ **644/경기** (최상위) |
| 전체 패스 성공률 (팀 평균) | **~78–85%** (하위 다이렉트팀 70대, 점유형 상위 85%+) | Opta 통용 벤치마크 |
| 파이널서드/전진(forward)·프로그레시브 패스 성공률 | **~55–70%** (전체보다 뚜렷이 낮음, 압박·좁은 공간) | 통용 벤치마크 |
| 롱패스 비율 | 전체 패스의 **~12–15%** (다이렉트 팀은 더 높음) | Opta 롱볼 트렌드 기사 |
| 평균 점유율 분포 | 30% ~ 65% (상위 점유팀 Arsenal 56.4% 등, 대칭 분포) | StatMuse/Opta |
| 볼 소유(possession) 연속 길이 | 평균 **≈27초 / 소유당 ≈10.9 이벤트** | Opta 시퀀스 정의 |
| 오픈플레이 시퀀스 시간 | 평균 ~**10–16초** (Man City 15.7초로 최장, 2024/25) | Opta playing styles |
| 오픈플레이 시퀀스당 전진거리 | **~14 m/시퀀스** (Man City 14.4, Arsenal/Liverpool 14.2) | Opta 2024/25 |

- **턴오버(볼 뺏김) 빈도**: 패스 성공률의 역수로 근사. 팀 패스 400–600 × 실패율 15–22% → **경기당 ~60–130건의 패스 미스**(양팀). 여기에 드리블·컨트롤 실패 포함 시 소유권 전환은 더 잦음.
- **오픈플레이 전환(possession 교체)**: 소유 평균 27초 × 인플레이 ~55분 → 양팀 합쳐 **경기당 대략 100–130회 소유권 전환** 수준(개략 추정).
- 출처: https://theanalyst.com/articles/analysing-premier-league-playing-styles-2024-25 , https://theanalyst.com/articles/opta-football-stats-definitions , FBref 참고 https://fbref.com/en/comps/9/passing/Premier-League-Stats

---

## 3. 슛·찬스·xG

**엔진 슛 트리거 빈도 튜닝의 근거. (현재 데모는 팀당 147슛 → 실제의 ~10배 과함)**

| 지표 | 실제 벤치마크 | 비고 / 출처 |
|------|--------------|------------|
| **팀당 경기 슛 수** | **~12–14** (양팀 합 24–27) | 2023/24 = 27.2슛/경기(양팀, 기록적 고점) → 팀당 **13.6** |
| 팀당 유효슛(on target) | **~4.5–5.5** (양팀 합 ~9–11) | 유효슛 비율 45–50% (2023/24 = 49.96%, 20년 평균 45.1%) |
| **슛당 평균 xG** | **~0.10–0.12** | Arsenal 0.12, Brentford 0.15(최상위) 25/26; 리그평균 ~0.10 |
| 슛 → 골 전환율 | **~10–12%** (2023/24 기록 11.88%) | premierleague.com season trends |
| **팀당 경기 골 수** | **~1.4–1.65** | 2023/24 = 3.28골/경기(양팀, 기록) → 팀당 1.64; 통상 2.7–2.85 → 팀당 1.35–1.45 |
| **빅찬스(big chance) / 경기** | 팀당 **~1.0–3.5** (상위 공격팀 2.5–3.5, 약팀 1.0–1.5) | Opta 정의: 원온원·근거리 등 득점 기대 상황 |
| 빅찬스 전환율 | **~35–45%** (일반 슛 ~10%의 약 4배) | Opta |

- **핵심 시사점**: 데모의 팀당 147슛은 실제(12–14)의 약 **10배**. 슛 트리거 확률을 대폭 낮춰야 함. 슛당 xG 0.10을 목표로 하면 팀당 13슛 × 0.10 ≈ 1.3 xG → 골 ~1.4와 정합.
- 출처: https://theanalyst.com/eu/2024/03/numbers-behind-premier-league-goal-explosion , https://www.premierleague.com/en/news/4027257 , https://one-versus-one.com/en/league-stats/premier-league/ranking/xg-average-per-shot

---

## 4. 세트피스 빈도 (경기당, 명시 없으면 양팀 합)

**엔진에 추가할 이벤트(코너·스로인·프리킥·파울) 빈도 근거.**

| 세트피스 | 경기당 빈도 (양팀 합) | 팀당 근사 | 출처 |
|----------|---------------------|----------|------|
| **코너킥** | **~9.9–10.5** | ~5 | 2025/26 = 9.93/경기 |
| 스로인 | **~33–38** (증가 추세) | ~17–19 | 2024/25 32.9 → 2025/26 38.1 |
| 프리킥 | **~24** (≈ 파울 수) | ~12 | 24.1–24.5/경기 (2018–23 평균) |
| 파울 | **~22–24** | ~11–12 | 프리킥과 근사 |
| 옐로카드 | **~3.5–4.0** (총 카드) | ~1.8–2.0 | 2025/26 = 3.98카드/경기 |
| 레드카드 | **~0.1–0.2** | — | 드묾 |
| 페널티 | **~0.2–0.3** | — | 심판별 편차 큼(0.40까지) |

- **코너 → 득점 확률**: 코너당 **~2%(전통)에서 최근 급등**. 2025/26 코너 전환율 **15.8%**(리그 기록, 단 이는 "코너로 시작된 공격의 득점" 광의). 전체 골의 **~13.9%가 코너 유래**, 코너+스로인 세트피스 합쳐 **골의 ~23%**(최근, 세트피스 혁명).
- 인스윙 코너 5.3% vs 아웃스윙 3.6% 골 전환.
- 롱스로인 급증: 경기당 3.99회(2025/26, 전년比 +162%).
- 출처: https://www.apwin.com/league/england/premier-league/corners/ , https://theanalyst.com/articles/premier-league-corners-justifiable-excitement , https://www.premierleague.com/en/news/4450086 , https://www.espn.com/soccer/stats/_/league/ENG.1/view/discipline

---

## 5. 선수 활동범위·주행거리·팀 폭 ★ 가장 중요

**움직임 다이나믹 튜닝의 핵심. (데모는 팀 spread 가로 24m/세로 16m 로 실제보다 크게 좁음)**

### 5-1. 주행거리 (선수당 경기당)

| 포지션 | 주행거리 | 출처 |
|--------|---------|------|
| 아웃필드 평균 | **~10–12 km** | Opta / PL |
| 중앙 미드필더(최다) | **~11–13 km** (상위 Kulusevski 12.3 km/90) | Opta |
| 풀백 | **~9.9 km** | Opta |
| 센터백 | **~9.3 km** | Opta |
| 골키퍼 | **~4–6 km** | Opta |

- **스프린트**: 정의 = **25 km/h 이상** 질주. 최상위 선수(Son) 시즌 859회 → 약 38경기 기준 **경기당 ~20–22회**(리그 최상위). 일반 선수는 경기당 **~10–30회** 범위. 최고 속도 사례 37.38 km/h(van de Ven).

### 5-2. 팀 형태(shape) — length × width, 단위 m ★★

| 국면 | 팀 length(세로) | 팀 width(가로) | 출처 |
|------|----------------|---------------|------|
| **아웃오브포제션 (미드블록, 압축)** | **~22–27 m** | **~40 m** | 2022 WC: Croatia 27×40.1, Morocco 23.5×40.75, Saudi 22.5×39.6 |
| **인포제션 (강팀 상대, 벌림)** | **~38 m** | **~43 m** | Breaking The Lines 분석 |
| 일반적 인포제션 확장 | 30–45 m | 45–55 m (터치라인 활용) | 통용 |

- **핵심 시사점**:
  - 실제 팀은 폭(width)을 **압축 시 ~40 m, 확장 시 43–55 m** 로 벌림 → 데모의 **가로 24 m 는 실제의 절반 수준**. **약 2배 확대 필요.**
  - 세로(length)는 압축 ~22–27 m, 확장 ~38 m → 데모 **세로 16 m 도 좁음. 압축 시에도 22m+ 확장 시 35–40m.**
  - 즉 팀 spread 를 **가로 40–50 m / 세로 25–40 m** 로 국면(공격/수비)에 따라 동적으로 벌리고 좁혀야 함.
- 풀백·윙어 커버 범위: 풀백은 자기 진영 최후방부터 상대 진영 파이널서드까지 **세로 60–80 m** 를 커버(주행거리 9.9km가 이를 반영). 윙어는 터치라인 폭 ~15–20 m 채널을 세로로 오르내림.
- 출처: https://breakingthelines.com/tactical-analysis/tactical-analysis-compactness-and-coverage-in-possession/ , https://www.fifatrainingcentre.com/en/fwc2022/technical-and-tactical-analysis/controlling-the-game-without-the-ball--the-mid-block-and-compactness.php , https://theanalyst.com/articles/premier-league-players-distance-run-fastest-slowest-sprints-walking , https://premierleaguenow.co.uk/2025/10/16/how-much-does-a-premier-league-footballer-run-per-game/

---

## 6. 템포·전환

| 지표 | 값 | 출처 |
|------|-----|------|
| **볼 인플레이 시간(effective)** | **~55–58분** (2023/24 58:11, 2022/23 54:49, 2025/26 55:00, ≈전체의 54–58%) | Opta ball-in-play |
| 스토피지(볼 아웃) 시간 | ~35–40분 (스로인·파울·세트피스 준비 등) | — |
| 액션 밀도 | 소유당 ~10.9 이벤트, 소유 평균 ~27초 | Opta |
| 오픈플레이 전환 횟수 | 경기당 양팀 합 ~100–130 소유권 전환(개략) | 소유 27초 기반 추정 |

- **시사점**: 90분 중 실제 플레이는 **~55분**뿐. 엔진 시뮬 tick 예산을 90분이 아닌 **인플레이 55분**에 맞춰 이벤트(슛/패스/세트피스) 밀도를 계산해야 실제와 정합.
- 출처: https://theanalyst.com/articles/premier-league-ball-in-play-are-we-seeing-less-football-2025-26 , https://www.premierleague.com/en/news/3860720

---

## 7. FM 데이터 모델 참고

- **데이터 기반**: Football Manager 는 실제 **Opta/StatsPerform 데이터를 벤치마크**로 사용. 개발자가 게임 내 통계를 실제 Opta 수치와 직접 비교해 매치엔진을 캘리브레이션(슛/골/패스 분포가 실제와 맞도록).
- **속성(attribute) 모델**: 선수 능력치를 Physical / Mental / Technical 3영역으로 분해. 속성값이 높을수록 **"결과의 일관성·품질"이 확률적으로 상승** — 패스가 목표에 도달할 확률↑, 슛이 유효슛일 확률↑, 태클 성공률↑. 즉 **속성 → 확률 파라미터 매핑**(결정론이 아닌 확률 가중).
- **민감 속성**: Acceleration/Pace 가 결과에 매우 큰 영향(테스트에서 이 값을 낮추면 성적 급락).
- **HMB 적용 힌트**: HMB 도 선수 능력치를 "이벤트 성공 확률의 가중치"로 쓰되, 실제 Opta 벤치마크(§2–§5)를 **리그 평균이 재현되도록** 하는 앵커로 사용. 예: 리그 평균 패스성공 80%를 능력치 중앙값 선수의 기본 확률로 두고 능력치로 ±.
- **트래킹 데이터**: Opta Vision 은 22명 전원의 X/Y 위치를 경기당 200만+ 데이터포인트로 제공 → 팀 shape(length/width) 수치(§5-2)가 여기서 산출됨. HMB 의 공간 시뮬도 이 X/Y 프레임 관점과 정합.
- 출처: https://community.sports-interactive.com/sigames-manual/football-manager-2024/players-r4958/ , https://www.passion4fm.com/football-manager-player-attributes/ , https://www.statsperform.com/products/opta-vision/

---

## 8. HMB EngineConfig 권장값 표 ★ 핵심

| 파라미터 (개념) | 실제 벤치마크 | HMB 권장 설정 방향 |
|-----------------|--------------|-------------------|
| **경기장 크기** | 105 × 68 m | 좌표계를 105×68 m 로 고정(또는 스케일 기준). 하프 52.5. |
| **팀당 슛 수** | 12–14 / 경기 | **슛 트리거 확률 대폭 하향** (현재 147 → ~13, ≈1/10). 인플레이 55분 기준 슛 간격 ~4분/팀. |
| 슛당 xG | 0.10–0.12 | 슛→골 판정 확률을 슛 위치 기반 xG 0.10 앵커로. 팀 13슛×0.10≈1.3xG→~1.4골. |
| 팀당 골 | 1.4–1.65 | 위 슛·xG 조합이 자동 충족하도록 캘리브레이션(별도 강제 X). |
| 유효슛 비율 | 45–50% | 슛의 절반만 on target 판정. |
| **전체 패스 성공률** | 78–85% | 능력치 중앙값 선수 기본 ~80%. **인터셉트/미스 확률 상향** 여지. |
| **파이널서드/전진 패스 성공률** | 55–70% | 전진·좁은 공간 패스는 성공확률 페널티(-15~25%p) → 인터셉트 확률 위치 가중. |
| 롱패스 비율 | 12–15% | 롱패스 선택 빈도 이 수준으로, 성공률 별도(더 낮게). |
| **팀 width(가로 spread)** | 압축 40 m / 확장 43–55 m | **현재 24 m → ~2배 확대(40–50 m).** 포메이션 슬롯 가로 간격·윙어 터치라인 진출 확대. |
| **팀 length(세로 spread)** | 압축 22–27 m / 확장 35–40 m | **현재 16 m → 25–40 m.** 공수 국면에 따라 동적 압축/확장. |
| 국면 전환(compact↔expand) | 인/아웃 포제션 폭 변동 | 소유 시 벌리고(width↑ length↑), 미수비 시 좁히는(미드블록) 동적 로직 추가. |
| 선수 주행거리 | 10–12 km (CM 최다, GK 4–6) | 포지션별 활동량 가중치(중미>풀백>센터백>GK)로 움직임 진폭 차등. |
| 스프린트 | 25 km/h+ 정의, 경기당 ~10–22회 | 고속 이동 이벤트 빈도·역치(25km/h) 반영. |
| **코너킥** | ~5 / 팀·경기 (양팀 ~10) | **코너 이벤트 추가.** 슛/클리어 후 아웃 판정 시 코너 부여. |
| 코너 득점 기여 | 골의 ~14% (코너), 세트피스 합 ~23% | 코너 시퀀스에 xG 부여(전환 ~2–5%/코너). |
| 스로인 | ~17–19 / 팀·경기 | 사이드라인 아웃 시 스로인 재개 이벤트. |
| 프리킥/파울 | ~12 / 팀·경기 | 파울 판정 → 프리킥 재개. 파울 확률 태클 실패에 연동. |
| 카드 | 옐로 ~2/팀, 레드 ~0.1 | 파울 누적/심각도 → 카드 확률(낮게). |
| 페널티 | ~0.2–0.3 / 경기 | 박스 내 파울 시 드물게 부여, xG≈0.76. |
| **볼 인플레이 시간** | 55–58분 | **시뮬 이벤트 예산을 90분이 아닌 ~55분 인플레이에 배분.** 나머지는 세트피스/스토피지. |
| 소유 시퀀스 길이 | ~27초 / ~10.9 이벤트 / ~14 m 전진 | 소유 지속·전진 로직 앵커. 소유권 전환 경기당 양팀 ~100–130. |
| 능력치→확률 매핑 | FM 방식(속성↑→성공확률·일관성↑) | 리그평균이 재현되도록 능력치 중앙값=벤치마크 확률, ±로 분산. |

---

## 부록: 핵심 출처 URL

- Opta / StatsPerform (theanalyst.com) — 플레이스타일·시퀀스·볼인플레이·코너·주행: https://theanalyst.com/competition/premier-league/stats
- premierleague.com season trends (골·전환·카드·롱스로인): https://www.premierleague.com/en/news/4027257 , https://www.premierleague.com/en/news/4450086
- 슛·xG per shot: https://one-versus-one.com/en/league-stats/premier-league/ranking/xg-average-per-shot , https://theanalyst.com/eu/2024/03/numbers-behind-premier-league-goal-explosion
- 팀 shape compactness (length/width m): https://breakingthelines.com/tactical-analysis/tactical-analysis-compactness-and-coverage-in-possession/ , https://www.fifatrainingcentre.com/en/fwc2022/technical-and-tactical-analysis/controlling-the-game-without-the-ball--the-mid-block-and-compactness.php
- 주행거리·스프린트: https://theanalyst.com/articles/premier-league-players-distance-run-fastest-slowest-sprints-walking , https://premierleaguenow.co.uk/2025/10/16/how-much-does-a-premier-league-footballer-run-per-game/
- 코너: https://www.apwin.com/league/england/premier-league/corners/ , https://theanalyst.com/articles/premier-league-corners-justifiable-excitement
- 볼 인플레이: https://theanalyst.com/articles/premier-league-ball-in-play-are-we-seeing-less-football-2025-26
- 경기장 규격: https://diamondfootball.com/news/4115/football-pitch-sizes-explained
- FM 데이터 모델: https://community.sports-interactive.com/sigames-manual/football-manager-2024/players-r4958/ , https://www.statsperform.com/products/opta-vision/
- FBref (봇 차단, 참고): https://fbref.com/en/comps/9/passing/Premier-League-Stats , https://fbref.com/en/comps/9/shooting/Premier-League-Stats
