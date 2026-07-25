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

- `POST /api/growth/enhance` `{playerId}` → 동일선수 중복 1 + 포인트 소모 → `enhance_level++`. `enhance_level`이 `maxEnhance`(5) 도달 시 추가 강화는 한계돌파 필요.
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

## 11. 로컬 실행/테스트 런북 (morning — 이 섹션 완성이 AC7)
> hero가 아침에 게임시작으로 테스트하는 방법. 웨이브 완료 시 실제 커맨드로 채운다.
- (예정) `docker compose -f infra/docker-compose.yml up -d java runner` + servants + `cd apps/web && npm run dev` → 브라우저 → 로그인(목) → 게임시작 → 매치 → 성장 확인 → 도감 강화.

---

## 진행 로그
| 시각 | 이벤트 |
|---|---|
| 2026-07-26 | 설계 SoT 작성, worktree growth/dual-track 생성, npm install green. G0 착수. |
