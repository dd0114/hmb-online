# [에픽 #179] 성장 시스템 — 가챠×경기 이중 트랙 (구현 SoT)

- **세션**: hmb:research (자율) · **브랜치**: `growth/dual-track` (← release/next)
- **SoT**: GitHub 에픽 **#179** + 이 문서. 근거 = `docs/research/growth-monetization-plan.md`, #172.
- **owned(이번 작업)**: `packages/shared/**` `server-java/**` `packages/server/**` `apps/web/**` `data/**` `tools/**` — 웨이브별 module-implementer/verifier.
- **상태**: 🟢 자율 구현 진행중 (hero 위임 2026-07-26, 내일 아침 게임시작 테스트 목표).

---

## 0. 목표 / 완료조건 (E2E)

**E2E Goal**: 유저가 게임 시작 → 매치 플레이 → **결과 화면에서 기용 선수가 성장한 걸 본다** → 도감/덱에서 **카드 상세로 성장(완성도)·강화(돌파★) 확인** → **중복으로 강화·한계돌파 실행** → 강해진 스탯이 팀파워·다음 매치에 반영.

**Acceptance Criteria**
- [ ] AC1: 매치 정산 시 기용 선수 `match_xp` 적립·`growth_level`↑, 결정론·멱등(같은 매치 재정산 시 1회만). Evidence: 서버 테스트 + DB 확인.
- [ ] AC2: 카드 상세(시안3)에서 OVR 링·완성도%·돌파★·능력치 cap/fill 표시. Evidence: 브라우저 캡처.
- [ ] AC3: 강화 실행(동일선수 중복+포인트) → cap↑ + autoFill 소량, 원장 기록·멱등. Evidence: E2E.
- [ ] AC4: 한계돌파(중복 N장) → 밴드 상한 넘어 등급 승급 → 카드 프레임 색 변경. Evidence: E2E.
- [ ] AC5: 성장/강화가 팀파워·다음 매치 `SelectData`에 반영, 과거 match-log 재생 bit-identical. Evidence: 리플레이 테스트.
- [ ] AC6: 성장/강화 UX 전 시나리오(§6) 동작 — 매치 후 성장 리포트 + 카드 상세 진입점. Evidence: 브라우저.
- [ ] AC7: 로컬 실행 런북(§11)으로 hero가 게임시작→테스트 가능. Evidence: 실행 확인.

---

## 1. 데이터 모델 (Flyway V8__growth.sql)

`user_players` 확장 (기존 `count` 유지):
```sql
ALTER TABLE user_players ADD COLUMN enhance_level  INTEGER NOT NULL DEFAULT 0;  -- 강화 레벨(밴드 내)
ALTER TABLE user_players ADD COLUMN limit_break    INTEGER NOT NULL DEFAULT 0;  -- 한계돌파 단계(등급 개방, 0..4)
ALTER TABLE user_players ADD COLUMN match_xp       INTEGER NOT NULL DEFAULT 0;  -- 누적 경기 성장 xp
ALTER TABLE user_players ADD COLUMN growth_level   INTEGER NOT NULL DEFAULT 0;  -- xp→레벨 파생 캐시
ALTER TABLE user_players ADD COLUMN growth_vec_json TEXT;                        -- 최근 성장 방향 벡터(캐시)
ALTER TABLE user_players ADD COLUMN copies_used    INTEGER NOT NULL DEFAULT 0;  -- 강화/돌파에 쓴 중복 누적

-- 성장 정산 멱등 (matches 1건당 카드별 1회) — relations_applied 패턴
CREATE TABLE growth_applied (
  match_id  TEXT NOT NULL REFERENCES matches(id),
  user_id   TEXT NOT NULL REFERENCES users(id),
  player_id TEXT NOT NULL REFERENCES players(id),
  xp_delta  INTEGER NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (match_id, user_id, player_id)
);
```
- `grade`(현재 등급)는 `players.grade`(원본) + `limit_break`로 파생 상향 → **유저별 카드 등급은 `user_players`에서 계산**(원본 players 불변).

## 2. 유효스탯 · cap · fill (핵심 계산, server 권위)

각 능력치 `i` (9종):
```
band(grade)      = [lo, hi]   # BRONZE 40-55 … LEGEND 80-95
cap_grade        = band(effectiveGrade).hi            # effectiveGrade = baseGrade + limit_break 단계
base_i           = players.attributes[i]              # 뽑기 롤(원본)
성장fill_i        = growthPoints × w_i                 # 경기 성장(방향 w)
강화fill_i        = enhance_level × enhanceStep × autoFillRatio   # 강화 즉시 채움(소량)
유효_i           = clamp(base_i + 성장fill_i + 강화fill_i, band.lo, cap_grade)
ovr              = Σ(유효_i × posWeight_i) / Σ posWeight_i
완성도            = (ovr - ovrBase) / (cap_ovr - ovrBase)          # UI 링·%
```
- `effectiveGrade`: `limit_break` 1단계마다 다음 밴드로. 예 BRONZE + 돌파1 = SILVER 밴드 개방(cap 55→65).
- **불변식**: 강화(과금)는 cap을 올리고 소량만 채운다. 나머지 fill = 성장(플레이). → 과금만 = 미완성.

## 3. 강화 (가챠·과금 트랙) — API

- `POST /api/growth/enhance` `{playerId}` → **포인트만 소모(중복 미소모)** → `enhance_level++`. `enhance_level`이 `maxEnhance`(5) 도달 시 추가 강화는 한계돌파 필요. (hero 2026-07-26: 중복 의존도 완화 — 우마무스메 정합. 육성=재화/플레이, 중복=천장 전용.)
- `POST /api/growth/limitbreak` `{playerId}` → 동일선수 중복 `lbCopies`(3)장 소모 → `limit_break++` → `effectiveGrade`↑(등급 승급) + `enhance_level` 상한 재개방(→10). 원장 `point_ledger`/`copies_used` 기록, 멱등.
- 결정론: 계수만, RNG 없음. 재료 부족 시 4xx.

## 4. 성장 (경기·무과금 트랙) — 매치 정산

`MatchService` 결과 커밋 트랜잭션에서 (기용 선수별):
```
Δxp = xpBase × minutesMult(played) × execMatch × personaMult × conditionMult × gapDecay(cap-ovr)
      (미출전 = benchGrowthMult 0.2)
```
- **execMatch** (0~1) = 프롬프트 의도(`TacticalInput.behavior`) vs match-log 실제 이벤트 정합. **v1 구현**: match-log 이벤트 카운트 기반(슛/패스/돌파/태클/가로챔…) × behavior 가중 → servants가 계산해 job 결과에 실어줌(신규 AI 호출 0). 없으면 baseline=0.6.
- **방향** `w = normalize(baselineByPosition[pos] + promptBias(behavior))`.
- `match_xp += Δxp` → `growth_level = floor(xp/xpPerLevel)` → §2로 fill 반영. 멱등 = `growth_applied` PK.

## 5. 계약 (packages/shared, zod) — G0 프리즈

```ts
GrowthState = { playerId, enhanceLevel, limitBreak, matchXp, growthLevel, effectiveGrade, ovr, completion, growthVec? }
CardEffective = { playerId, baseGrade, effectiveGrade, attributes:{...}, caps:{...}, ovr, completion }
EnhanceResult = { playerId, enhanceLevel, limitBreak, effectiveGrade, ovr, spent:{copies,points} }
MatchGrowthReport = { entries: [{playerId, name, xpDelta, ovrBefore, ovrAfter, leveledUp, topAttrs:[...]}] }
```
- engine `SelectData`·match-log 계약 **무변경**. 성장은 server가 유효스탯을 계산해 다음 매치 `SelectData`에 주입.

## 6. UX — 탭 배치 + 언제 확인 (전 시나리오)

**탭 배치 결정**: 신규 nav 탭 추가 안 함(모바일 5탭 유지). 대신:
- **도감(Codex)을 "육성" 허브로** — 카드 탭 → **카드 상세 시트**(시안3: OVR 링·완성도·돌파★·능력치 cap/fill) → 여기서 **강화/한계돌파 실행**.
- **덱(Deck)** 카드에도 같은 상세 시트 진입점(선발 편성 중 성장 확인).
- **매치 결과(ResultPage)** 하단에 **성장 리포트 카드** — 이번 경기로 자란 선수 목록.

**언제 유저가 성장/강화를 확인하나 — 시나리오 전부**
| # | 트리거 | 화면 | 무엇을 본다 |
|---|---|---|---|
| S1 | 매치 종료 | ResultPage | "성장 리포트": 기용 선수별 +xp·OVR 변화·레벨업 뱃지 |
| S2 | 도감에서 카드 탭 | 카드 상세 시트 | OVR 링·완성도%·돌파★·능력치(현재/천장/기본) |
| S3 | 상세에서 "강화" | 강화 다이얼로그 | 보유 중복·포인트 → 강화 후 스탯 +Δ 애니메이션 |
| S4 | 강화가 밴드 상한 도달 | 상세 | "한계돌파 가능" 배지 → 실행 → **등급 승급**(프레임 색 전환) |
| S5 | 덱 편성/브리핑 | DeckEditor·Briefing | 카드에 성장 뱃지, **팀파워에 성장 반영** |
| S6 | 로비/도감 목록 | 카드 그리드 | 카드마다 OVR·완성도 링·돌파★ 요약 |
| S7 | 다음 매치 | 엔진 결과 | 자란 스탯이 실제 경기력에 반영(SelectData) |

## 7. Config (economy.v2.json 확장, 하드코딩 금지)

```json
"growth": {
  "xpBase": 100, "xpPerLevel": 300, "completeMatches": 36,
  "benchGrowthMult": 0.2, "execMatchDefault": 0.6, "speedMaxMult": 3.0,
  "baselineByPosition": { "FW": {...}, "MF": {...}, "DF": {...}, "GK": {...} }
},
"enhance": {
  "maxEnhance": 5, "enhanceStep": 2.0, "autoFillRatio": 0.25,
  "limitBreakCopies": 3, "maxLimitBreak": 4, "pointCost": 200
}
```
(C1~C6 hero 확정값 반영: autoFill 0.25 · 강화5/돌파10 · 돌파 3장 · 완성 36경기 · 속도 ≤3× · 미출전 0.2)

## 8. 결정론 (§2-5 불변)
- 성장·강화 = server-java 권위, 매치 정산 트랜잭션, 시드 없음(계수만) 또는 `hash(matchId,userId,playerId)`, 멱등 `growth_applied`.
- 엔진 무변경. `matches.selectData` 스냅샷 = 매치 시점 고정 → **과거 리플레이 bit-identical**.
- servants execMatch = match-log 결정론 파생, 신규 AI 호출 0.

## 9. E2E 계획
- server: 성장 적립 멱등·강화·돌파 승급 단위 테스트(`--rerun-tasks`).
- web(playwright, 목킹): 카드 상세 시안3 렌더 + 강화 클릭→스탯↑ + 돌파→프레임색. 스펙 지정·대체포트·전면 목킹(데모 :8080 안 붙게).
- 통합: stub 매치→성장 리포트→강화→다음 매치 반영 리플레이 동일.

## 10. 웨이브 분해 · 실행 순서
- **G0 계약**(shared): §5 zod 프리즈. → **G1 data**(economy config §7) ∥ **G2 server**(V8·계산·API·정산) → **G3 servants**(execMatch) → **G4 web**(카드 상세·강화·성장리포트·시안3) → **G6 E2E/밸런스** → 통합·런북.
- 각 웨이브 module-implementer → module-verifier PASS → 커밋. STATE는 #179에 갱신.

## 11. 로컬 실행/테스트 런북 (AC7 — 아침 테스트) ✅ 스택 기동 상태로 남김

> **격리 원칙**: 라이브 배포(hmb-online.pages.dev 백엔드 = docker `hmb-java`/`hmb-runner` on 18080/18790)는 **절대 무접촉**. 이 테스트 스택은 별도 이름(`hmb-growth-*`)·별도 볼륨(`hmb-growth-db`)·별도 포트(19080/19790/web5301)로 완전 격리.

### 이미 떠 있음 (아침에 바로 열기)
- **웹: http://localhost:5301** ← 여기 열고 테스트
- 백엔드 docker: `hmb-growth-java`(19080) · `hmb-growth-runner`(19790) · `hmb-growth-executor`(stub AI)

### 꺼졌으면 재기동 (2커맨드)
```bash
# 0) 격리 override 재작성 (라이브 이름/볼륨 충돌 회피 — infra 커밋 안 함)
cat > /tmp/dc.growth.yml <<'YAML'
services:
  java: { container_name: hmb-growth-java }
  runner: { container_name: hmb-growth-runner }
  executor: { container_name: hmb-growth-executor }
volumes:
  hmb-db: { name: hmb-growth-db }
YAML
# 1) 백엔드 (이미지 빌드됨 — 빠름). infra/.env 에 JAVA_HOST_PORT=19080·RUNNER_HOST_PORT=19790·AI_EXECUTOR=stub·SERVANT_TOKEN=<rand>
#    + ★CORS: WEB_ORIGINS=http://localhost:5301  (없으면 브라우저 로그인 403 "Invalid CORS request")
cd /Users/peter.park/spider8/hmb-growth/infra && \
  docker compose -p hmb-growth -f docker-compose.yml -f /tmp/dc.growth.yml up -d java runner executor
# 2) 웹 (프록시로 19080에 붙음 — CORS 없음)
cd /Users/peter.park/spider8/hmb-growth/apps/web && \
  VITE_API_TARGET=http://localhost:19080 npm run dev -- --port 5301 --strictPort
```

### 테스트 시나리오 (게임시작→성장→강화)
1. http://localhost:5301 → **로그인(게스트)** — 신규 유저 = 스타터팩 14명 + 3000P.
2. **덱 편성**(신규 유저 필수): 덱 탭 → 선발 11 구성·저장.
3. **게임시작** → 매치(전반→하프타임→후반→결과).
4. **결과 화면 = 성장 리포트**(S1): 기용 선수 +xp·OVR↑·레벨업 뱃지.
5. **도감** → 그 선수 카드 탭 → **시안3 상세**(OVR 링·완성도%·돌파★·능력치 현재/천장/기본). 완성도가 0→증가 확인.
6. **강화 테스트**: 강화엔 **중복**이 필요 → 상점 가챠(10연 3000P)로 같은 선수 중복 확보 → 도감 카드 상세 "강화"(중복1+200P) → 스탯↑ → 밴드상한 도달 시 "한계돌파"(중복3) → **등급 승급**(프레임색 전환).

### 확인된 것 (2026-07-26 자율구현 스모크)
- 스택 healthy, V8 마이그레이션 적용, `GET /api/growth/card/P074` 200(ovr 61.12·completion 0·caps=밴드상한).
- web:5301 → `/api` 프록시 → 19080 도달(401 정상).
- 매치→성장·강화·돌파 라이브 검증 = module-verifier 진행(결과는 진행 로그/§AC).

---

---

# V2 스펙 — 메이플 피벗 (hero 확정 2026-07-26, 안 ㄴ) ★현행 SoT

> §1~§5 의 강화(enhance)/한계돌파(limit_break→등급승급) 모델은 **폐기**. 이 섹션이 대체한다. 근거·조사 = `docs/research/maple-growth-model.md`. 아래 수치는 **밸런스 초안**(hero: "초안은 리서치가, 조절은 hero가") — 전부 config.

## V2-1. 모델 (3축)
- **① 스탯 성장(경기)**: 매 경기 스탯별 XP 적립 → 스탯별 Lv(지수 비용) → 스탯 +1/Lv. **미출전 XP=0**(벤치 성장 폐지). 등급 승급 없음 — 성장은 자기 등급 밴드 안.
- **② 성★(중복)**: 1★~4★ 전 등급. 성 = **밴드 내 성장 천장 개방** + 잠재 게이트. 등급 변화 없음(프레임색 유지, ★ 별도 표시).
- **③ 잠재능력(안 ㄴ)**: 2★ 해금. **줄 수 = 등급**(브/실 1줄 · 골 2줄 · 다/레 3줄), **티어 캡 = min(등급 캡, 성 캡)** — 등급 캡: 브/실=레어·골=에픽·다/레=유니크 / 성 캡: 2★=레어·3★=에픽·4★=유니크. 다이스로 리롤·승급.

## V2-2. 계산 (server 권위, RNG는 다이스만·시드 저장)
```
스탯 XP:   xp_i = xpBase × (baselineByPosition[pos]_i + eventBonus_i(match-log)) × minutesMult × gradeXpMult[grade]
           minutesMult: 선발 1.0 / 부분출전 0.5 / 미출전 0
           eventBonus = eventStatMap(이벤트→스탯 가중, config) — "헤딩 노림→heading류" 세분화. promptBias(behavior) 가산
레벨 임계: xpToNext(lv) = xpLvBase × xpLvGrowth^lv   (초안 100 × 1.7^lv) → 자동 레벨업, 스탯 +1/Lv
성 천장:   cap_i(star) = base_i + starFrac[star] × (band.hi − base_i)   (starFrac 초안 1★.25/2★.5/3★.75/4★1.0)
유효 스탯: eff_i = clamp(base_i + statLv_i, band.lo, cap_i(star)) → +Σ잠재flat_i → ×(1+Σ잠재pct_i)
ovr:      Σ(eff_i × baselineByPosition[pos]_i)  /  완성도 = 성장 진행률(Σ statLv / Σ (cap−base))
```
- **다이스 롤**: `POST dice` → (노말이면) 티어업 판정(레어→에픽 6% · 에픽→유니크 1.8%, **천장** `ceil(1.5/p)`회 미승급 시 다음 확정) → 3줄 리롤: 1줄=현재 티어, 2·3줄=한 단계 아래 + 이탈확률(노말 8% / 캐시 20%)로 동일 티어. **캐시 다이스 = 티어업 없음, 옵션 테이블 상위 가중**. 시드 SecureRandom→`dice_rolls` 저장(가챠 패턴).
- 잠재 옵션 풀(티어별 테이블, config): `STAT_PCT`(레어1~2%/에픽3~4%/유니크6~8%) · `STAT_FLAT`(1~2/3~4/6~8) · `CONDITION_RECOVERY`(P2-D5 훅) · `TEAM_MORALE`(P2-D7 훅). 동일 옵션 3줄 독점 금지(같은 (type,stat) 최대 2줄).

## V2-3. 스키마 V9__maple_growth.sql
```sql
ALTER TABLE user_players ADD COLUMN stat_levels_json TEXT;                    -- {"shooting":{"lv":3,"xp":120},...} 9종
ALTER TABLE user_players ADD COLUMN star INTEGER NOT NULL DEFAULT 1;          -- 1~4
-- (구 enhance_level·limit_break·match_xp·growth_level·growth_vec_json 은 사용 중단 — 컬럼 유지, 코드 참조 제거)
CREATE TABLE card_potentials (
  user_id TEXT NOT NULL, player_id TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'RARE' CHECK (tier IN ('RARE','EPIC','UNIQUE')),
  lines_json TEXT,                       -- [{slot,tier,type,stat?,value}]
  rolls_since_tierup INTEGER NOT NULL DEFAULT 0,   -- 천장 카운터(노말 다이스만 증가)
  updated_at TEXT NOT NULL, PRIMARY KEY (user_id, player_id));
CREATE TABLE user_dice (user_id TEXT PRIMARY KEY, normal INTEGER NOT NULL DEFAULT 0, cash INTEGER NOT NULL DEFAULT 0);
CREATE TABLE dice_rolls (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, player_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('NORMAL','CASH')), seed TEXT NOT NULL,
  tier_before TEXT, tier_after TEXT, lines_json TEXT, created_at TEXT NOT NULL);
-- growth_applied(멱등)는 그대로 재사용
```

## V2-4. API (GM2)
| 메서드 | 경로 | 동작 |
|---|---|---|
| GET | `/api/growth/card/{pid}` | 개정 CardEffective(스탯Lv/XP·★·잠재 lines·caps·ovr·완성도) |
| POST | `/api/growth/star` | ★승급: 중복 소모 2★=2 / 3★=3 / 4★=5장. CAS·멱등 |
| POST | `/api/growth/dice` | `{playerId, kind}` 다이스 1개 소모→롤 결과(tierUp?·lines·ceiling 카운터) |
| POST | `/api/shop/dice` | `{kind, count}` 노말=500P·캐시=5,000P(목업) — point_ledger 멱등. **응답 = `DiceBuyResult {kind, count, dice:{normal,cash}, wallet:{points}}`** (shared 계약) |
| **GET** | **`/api/growth/dice`** | **다이스 잔액 `DiceBalance {normal, cash}`** — web 페이지 로드 시 조회(새로고침 리셋 방지, GM3 발견 공백) |
| GET | `/api/growth/report/{matchId}` | 스탯별 XP·레벨업 리포트(개정) |
| ~~POST~~ | ~~enhance·limitbreak~~ | **제거** |

에러코드 확정: 중복 부족 `INSUFFICIENT_MATERIALS` · 포인트 부족 `INSUFFICIENT_POINTS` · **다이스 부족 `INSUFFICIENT_DICE`** · 잠재 미해금(1★) `POTENTIAL_LOCKED`.

## V2-5. economy config (GM1 — additive 개정, `enhance` 블록 제거)
`growth{xpBase100, xpLvBase100, xpLvGrowth1.7, gradeXpMult{B:0.4,S:0.4,G:1.0,D:1.5,L:3.0}, minutesMult{starter:1,partial:0.5,bench:0}, baselineByPosition(유지), eventStatMap{...}}` · `star{copies{2:2,3:3,4:5}, starFrac{1:0.25,2:0.5,3:0.75,4:1.0}}` · `potential{linesByGrade{B:1,S:1,G:2,D:3,L:3}, gradeTierCap{B:RARE,S:RARE,G:EPIC,D:UNIQUE,L:UNIQUE}, starTierCap{2:RARE,3:EPIC,4:UNIQUE}, tierUp{rareToEpic:0.06, epicToUnique:0.018}, ceilingMult:1.5, breakout{normal:0.08, cash:0.20}, tables{RARE:[...],EPIC:[...],UNIQUE:[...]}}` · `dice{normalCost:500, cashCost:5000}`

## V2-6. UX (GM3)
- 카드 상세 개정: 스탯 9종 **Lv·XP바**(레벨업=이산 체감) · **★1~4**(성 승급 버튼+중복 비용칩) · **잠재 패널 3줄**(티어 색: 레어=흰/에픽=보라/유니크=금) · **다이스 롤 버튼 2종**(비용칩: 노말 다이스1 / 캐시 다이스1) + 리롤 연출(줄 셔플→확정) · 티어업 시 축하 연출.
- 상점: 다이스 구매 섹션(노말 500P/캐시 5,000P 목업). 성장 리포트: 스탯별 +XP·레벨업 뱃지.
- 이전 hero 피드백 반영: 재화 비용칩 명시·지갑 플래시·레벨업 이산 핍·델타 표시.

## V2-7. AC (개정)
- AC-V1: 매치 정산 스탯별 XP 결정론·멱등(growth_applied), 미출전 XP=0.
- AC-V2: 성★ 승급이 천장(starFrac)·잠재 티어 캡을 정확히 개방. 중복 부족 4xx.
- AC-V3: 다이스 — 티어 랙칫(하락 없음)·천장 보장(1.5배)·시드 저장 재현·노말만 티어업. 캐시=테이블 가중만.
- AC-V4: 잠재 유효스탯 반영(flat→pct 순) + SelectData 주입, 과거 리플레이 bit-identical.
- AC-V5: 등급×성 캡 매트릭스(안 ㄴ) 전 조합 테스트(골드 4★=에픽 상한·2줄 등).
- AC-V6: web — 롤 연출·비용칩·레벨업 체감(E2E 목킹) + 라이브 스모크.

## V2.1 피드백 개정 (hero 실플레이 2026-07-26)

> hero: "승급이 맛없다·잘 안 보인다 / 굴려도 편차가 적어 재미없다 / 능력치 축약 or 총/보너스 레이어 토글 / **에픽 승급 = 3줄 전부 에픽**(줄별 개별 티어는 복잡해서 기각) / 잠재·승급을 더 특별한 레이어로."

### V2.1-1 티어 의미 변경 — **전줄 동일 티어** (서버·GM6)
- 메이플식 "1줄=티어, 2·3줄=한 단계 아래+이탈" **폐기** → **모든 줄 = 카드 잠재 티어**. `breakout` config 제거. 에픽 승급 = 즉시 전줄 에픽 리롤(승급의 맛).
- shared 계약 무변경(PotentialLine.tier 필드 유지 — 값이 전부 동일해질 뿐).

### V2.1-2 롤 편차 확대 (data·GM5)
- 옵션 값 = **티어별 4스텝 + 가중**(잭팟 희소): STAT_PCT/FLAT — RARE 1/2/3/4 (w 40/30/20/10) · EPIC 4/5/6/8 (35/30/25/10) · UNIQUE 8/10/12/15 (35/30/25/10). RECOVERY/MORALE — RARE 2/4 (70/30) · EPIC 5/8 · UNIQUE 9/15.
- **티어 바닥 = 아래 티어 천장**(에픽 최소 4 = 레어 최대) → 승급이 곧 체감 상승. 한 롤 안에서 최대 ~4배 편차 = 굴리는 재미.
- `premium` = 상위 2스텝(캐시 가중 유지). 동일 (type,stat) ≤2줄 유지.

### V2.1-3 UI 레이어 개편 (web·GM7)
- 능력치 영역 **토글 2레이어**: `[총 능력치]`(유효 숫자 크게, 기본) ↔ `[+보너스]`(스탯별 base → +성장(초록) +잠재(티어색) 분해).
- **잠재 패널 승격**: 패널 배경·카드 프레임 글로우를 **잠재 티어색**으로(레어=흰/에픽=보라/유니크=금) — 승급이 카드 전체 인상을 바꿈. 티어 대형 뱃지.
- **승급 연출 강화**: 티어업 시 전체 오버레이(티어색 플래시→전줄 리롤 순차 공개→프레임 글로우 전환). "승급 보장까지 N회" 프로그레스 바(숫자만→바+숫자).

### V2.1-4 → **V2.2 재화 이원화 (hero 확정 2026-07-26 — "지금·최소로")**
무료 게임머니 **P**(포인트) vs 충전형 **젬** 분리. P2-D11(신규화폐 금지)은 hero 결정으로 개정. 실결제 = 백로그(실명 라이선스와 같은 층위) — 충전은 **목업**.

**스펙 (GM8s data · GM8 server · GM9 web)**
- **V10__gems.sql**: `ALTER TABLE wallets ADD COLUMN gems INTEGER NOT NULL DEFAULT 0 CHECK (gems >= 0);` + `gem_ledger`(point_ledger 와 동형: user_id·delta·reason·ref_id·created_at, 멱등 유니크).
- **가격 개정**: 노말 다이스 = 500P(유지) / **캐시 다이스 = 10젬**(`dice.cashGemCost`, 기존 cashCost 5000P 제거). 캐시 다이스 = 젬 전용.
- **충전 목업**: `gems.topupPacks` config = `[{id:"p1",gems:60,mockPrice:"₩1,200"},{id:"p2",gems:330,mockPrice:"₩5,900"},{id:"p3",gems:720,mockPrice:"₩11,900"}]`. `POST /api/shop/gems/topup {packId}` → 즉시 지급(reason='gem_topup_mock', 멱등), 실결제 없음 — UI에 "목업 충전" 명시.
- **API/계약**: `/api/me` 지갑에 `gems` additive. `POST /api/shop/dice` CASH → 젬 차감(gem_ledger). `DiceBuyResult.wallet = {points, gems}`. 신규 `GemTopupResult {packId, granted, wallet:{points,gems}}`. 부족 = `INSUFFICIENT_GEMS`.
- **web**: 지갑 표시 P·젬 병기(상단), 상점 다이스탭에 젬 가격·충전(목업) 버튼+팩 3종, 캐시 다이스 버튼 비용칩 "젬 −10".
- 규제 노트: 젬 = 유상 재화 → 다이스 확률·천장 공개 의무 대상(이미 구조 존재 — 확률 공개 UI는 후속 이슈).

## 진행 로그
| 시각 | 이벤트 |
|---|---|
| 2026-07-26 | 설계 SoT 작성, worktree growth/dual-track 생성, npm install green. G0 착수. |
| 2026-07-26 | G0~G4 완료(shared·data·server·web). 격리 라이브 스택 기동(19080/web5301). |
| 2026-07-26 | **AC 라이브 검증**: AC1 성장정산 멱등(verifier 구조확인 1행/선수)·AC3 강화 라이브 PASS(P140 ovr 50.88→51.7·+1 attrs·200P 차감·copy1)·AC5 서버 304테스트·카드상세 라이브 200. |
| 2026-07-26 | **버그수정: 브라우저 로그인 403(CORS)** — WEB_ORIGINS 에 5301 없음 → 추가+java 재생성. 브라우저 플로우 재검증: 게스트→/lobby, 도감14장, 카드상세 /api/growth/card 200. |
