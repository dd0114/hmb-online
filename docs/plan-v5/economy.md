# 재화 경제 — 소스·싱크 지도 + 수입 곡선 (SoT)

> 확정 = **이슈 #212**(hero 2026-07-27). 이 문서는 그 결정을 코드 좌표와 함께 고정한 참조본이다.
> 수치의 SoT 는 문서가 아니라 **config** — `data/players/economy.v2.json` + `data/players/league.v1.json`
> (둘 다 `data/players/generate.ts` 에서 생성된다. **JSON 을 직접 고치지 말 것** — 바이트 동일성 게이트가 잡는다).
> 이전 상태와의 갭 분석·실측 근거는 #212 W1 리포트 코멘트.

---

## 1. 두 재화의 역할 (확정)

| | **골드(P, `wallets.points`)** | **젬(`wallets.gems`)** |
|---|---|---|
| 성격 | 게임 재화 — **리그를 돌면 번다** | 유료 재화 |
| 용처 | 트레이드(단축·FA 제안) · 무료강화(노말 다이스) | **뽑기** · 유료 다이스(캐시) |
| 수급 | 가입 지급 + 매치 보상 + 시즌 순위 보상 | **가입 지급 + 리그 우승** 둘뿐 |

> P2-D11 "신규 화폐 없음"은 폐기됐다(#179 V2.2 젬 신설 → #212 역할 확정).

---

## 2. 소스/싱크 전수

지갑을 바꾸는 코드 경로는 `WalletService.apply`(P) / `applyGems`(젬) **둘뿐**이고, 모든 변경은 원장
(`point_ledger` / `gem_ledger`)을 동반한다. 멱등은 `uq_(gem_)ledger_reason_ref(user_id, reason, ref_id)`.
**새 소스/싱크를 추가하면 이 표를 갱신한다.**

### 골드(P)

| 방향 | reason | 값 | 코드 |
|---|---|---|---|
| 소스 | `starter` | `initialPoints` 3,000 (가입 1회) | `UserOnboardingService` |
| 소스 | `reward_win/draw/loss` | **모드별** — 연습 500/200/100 · 리그 **5,000/2,000/1,000** | `MatchOrchestrator` (`rewards.byMode[mode]`) |
| 소스 | `league_reward` | 순위별 **100,000 → 500** (시즌 1회) | `LeagueService.awardSeasonRewards` |
| 소스 | `admin_grant` | 운영자 수동 | `AdminPointsService` |
| 소스 | `economy_rescale_v14` | 1회 마이그레이션(구 잔액 ×10) | Flyway `__economy_rescale.sql` |
| 싱크 | `trade_speedup` | `max(200, ceil(잔여h × 500))` | `TradeService` |
| 싱크 | `trade_fa` | 유저 제안 포인트 | `TradeService` |
| 싱크 | `dice` (NORMAL) | 5,000 / 개 | `GrowthService.buyDice` |

### 젬

| 방향 | reason | 값 | 코드 |
|---|---|---|---|
| 소스 | `initial_gems` | **6,000** (= `gacha.tenCost` × 2 → 가입 즉시 10연차 두 판) | `UserOnboardingService` + V14 백필 |
| 소스 | `league_gem_reward` | **우승(1위)만** 500~3,000 랜덤 | `LeagueService.awardSeasonGems` |
| 싱크 | `gacha_single` / `gacha_ten` | 300 / 3,000 | `GachaService` (`gacha.currency=GEM`) |
| 싱크 | `dice` (CASH) | 10 / 개 | `GrowthService.buyDice` |

**`gem_topup_mock` 은 잠겨 있다**(`gems.topupEnabled=false` → 403 `TOPUP_DISABLED`). 무제한 무료
충전이 살아있으면 뽑기가 젬 결제인 상태에서 경제가 붕괴한다. 실결제를 배선할 때 다시 연다.

---

## 3. 수입 곡선 — hero 목표와 실측

목표: **연습 적게 < 리그 매판 적당 < 리그 최종성적 가파르게**.

| 최종순위 | 전적(가정) | 매판 소계 | 시즌보상 | **합계 P** | 젬 |
|---|---|---|---|---|---|
| **1위** | 14-2-2 | 76,000 | **100,000** | **176,000** | 500~3,000 |
| 2위 | 12-3-3 | 69,000 | 20,000 | 89,000 | 0 |
| 3위 | 11-4-3 | 66,000 | 10,000 | 76,000 | 0 |
| 5위 | 9-4-5 | 58,000 | 4,000 | 62,000 | 0 |
| 8위 | 6-4-8 | 46,000 | 1,500 | 47,500 | 0 |
| 10위 | 3-3-12 | 33,000 | 500 | 33,500 | 0 |

- **1위 = 2위의 1.98배** (우승 클리프), 1위/10위 **5.25배**
- **연습 18판 전승 = 9,000 P** = 리그 5위 완주의 14.5%
- 실측(stub 시뮬, `SeasonIncomeProbeTest`): 9승9패·6위 → 매판 54,000 + 시즌 3,000 = **57,000 P**, 젬 0

**연습을 깎아도 육성은 안 깎인다** — 경기 성장 XP(`match_xp`)는 보상 원장과 완전히 분리된 경로
(`MatchOrchestrator.settleGrowth` → `GrowthService`)다. 연습 = 육성장, 리그 = 수입원으로 역할이 갈린다.

---

## 4. 회귀를 막는 계약

곡선은 "값이 이렇다"가 아니라 **관계식**으로 박제돼 있다 — 튜닝으로 값이 움직여도 의도는 안 무너진다.

| 계약 | 위치 |
|---|---|
| 연습 지급 < 리그 지급(승·무·패 전부) · 각 모드 승>무>패 | `data/players/data.test.ts` |
| 우승 ≥ 2위×4 · 우승 ≥ 10위×50 · **우승 1회 > 18R 전승 매판 합** | `data/players/data.test.ts` |
| `initialGems == gacha.tenCost × 2` · `gacha.currency=GEM` | `data/players/data.test.ts` |
| 시즌 완주 실측(매판=리그 티어, 연습 최대 < 리그 최소, 순위별 보상 일치) | `SeasonIncomeProbeTest` |
| 우승 젬 밴드·1위 외 0·재지급 멱등 | `LeagueApiTest` |
| 충전 수도꼭지가 잠겨 있다 | `GrowthApiTest` |
| 기존 지갑 마이그레이션(×10 + 젬 백필, 재적용 무해) | `FlywayV14EconomyRescaleTest` |

---

## 5. 기존 유저 마이그레이션 (Flyway `__economy_rescale.sql`)

골드 경제가 통째로 ×10 됐고 뽑기가 젬으로 옮겨갔으므로, 이미 가입한 테스터에게 1회 보정한다.

1. **P 잔액 ×10** — 증분(구 잔액×9)을 `economy_rescale_v14` 로 원장에 남기고 잔액을 올린다. 안 하면
   기존 테스터가 신 가격표(다이스 5,000)에서 아무것도 못 산다.
2. **젬 6,000 백필** — 가입 지급 시점을 지나친 유저에게 `initial_gems` 로 1회.

둘 다 `INSERT OR IGNORE` + 원장 유니크라 **재적용해도 이중 지급이 없다**(수동 복구 대비).

⚠️ **진행 중(ACTIVE) 시즌**은 정산 시점의 config 를 읽으므로 새 순위 곡선으로 지급된다. 테스터 규모라
수용하기로 했다 — 차단하려면 시즌 시작 시 곡선을 `league_seasons` 에 스냅샷해야 한다(추가 마이그레이션).

---

## 6. 소유 경계 (튜닝하기 전에 확인)

| 영역 | 소유 |
|---|---|
| `rewards.*` · `league.v1.json#rewards` · `league.gemReward` · `gacha.currency` · `initialGems` · `trade.speedup/value` · `dice.normalCost` | **#212**(이 문서) |
| `dice.cashGemCost` · `gems.topupPacks` · `growth.*` · `star.*` · `potential.*` | **#201** 밸런스 튜닝 트랙 |
| `initialPoints` · `starterPack` | **#209** 스타터/온보딩 |
| `gacha.rates` · `trade.value.byGrade`(등급 체계 의존) | 등급 개편 **#207** 확정 후 재점검 |
