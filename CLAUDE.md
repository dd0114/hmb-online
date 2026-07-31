# HMB 온라인 — 프로젝트 가이드 (CLAUDE.md)

> 새 세션이 **이 파일만 읽고 이어서 작업**할 수 있도록 정리한 문서. 아래 "작업 방식"은 규칙이며 반드시 준수한다.

---

## 1. 무엇을 만드나

**HMB 온라인** = FM(Football Manager) 틀 + **선수 개개인에게 자연어 AI 프롬프트 주입**이 차별점인 웹 축구 시뮬 게임. 웹(폰+데스크탑) → 추후 Capacitor 앱.

- **핵심 컨셉**: 셋팅 → 선수별 프롬프트 → **AI가 인풋(전술 행동 파라미터) 사전 생성** → **결정론 시뮬** → 결과. (방식1 확정: AI는 인풋만, 시뮬은 스태틱)
- **로드맵**: Phase 1 싱글(vs AI) PoC → Phase 2 매니지먼트 메타(덱 수집+프리셋·스카우팅·이적·재정·훈련) → Phase 3 실시간 PvP. (Tier C 물리·3D·리그는 Backlog)
- 상세: `docs/PRD.md`(v1.1), `docs/PLAN-phase1.md`(v1.1), 조사 `research/*.md`.

---

## 2. ⚠️ 작업 방식 (규칙 — 반드시 준수)

이 규칙들은 실제 시행착오로 확립됐다. 어기면 같은 실수를 반복한다.

1. **SoT = GitHub 이슈** (`github.com/dd0114/hmb-online`). epic-flow 로 진행. 대화에만 있는 합의는 무효 — 이슈 STATE/progress log 에 기록.
2. **판정은 독립 QA 전용 — 자기검수 금지.**
   - 내가 만든 걸 내가 "정상"이라 판정하면 편향된다(실제로 골 연출을 자기검수는 통과시켰지만 독립 QA가 FAIL 잡음).
   - 시각/동작 판정은 **별도 컨텍스트 서브에이전트 + Playwright 실제 재생**으로만. → `.claude/agents/independent-qa.md` 참조.
   - **인지 갭 버그("보이는 것 vs 데이터")는 좌표 추론 금지 — 실화면 캡처로 확인.** 방법 = `/visual-capture-qa` 스킬(`.claude/skills/visual-capture-qa/`): Playwright 로 캔버스 스크린샷 → Read 로 직접 보기 → E2E 계약 박제(test.fail) → 수정 → before/after 재캡처. (실제로 좌표만 보고 "중앙 맞다" 오판한 적 있음.)
3. **버그픽스·피처 = 테스트 먼저(E2E-TDD) → 검증 → 적용.** 변경 전에 기대동작을 테스트로 박제하고, 통과 확인 후 구현.
4. **모든 튜닝값 = `EngineConfig` (하드코딩 금지).** 틱해상도·좌표모드·범위·확률·계수·포메이션 전부 config. "코드 수정 없이 config로 튜닝"이 원칙.
5. **결정론 불변 (절대 깨지 말 것):** `Math.random`·`Date.now`·`new Date` **금지**, 위치/속도는 **고정소수(fixedmath)**, **시드 RNG 인스턴스 관통**(전역 상태 X). 동작 바뀌면 **골든 스냅샷 갱신** + 재현 N회 desync 0 + resume(하프타임 분할=통짜) 동일성 + hygiene 유지.
6. **리얼 config vs 쇼케이스 config 분리.** `defaultEngineConfig`=실제 축구 벤치마크(`research/football-stats.md`) 정합용. `generate-demo.ts`의 `showcaseConfig`=관전 재미용(짧게·골↑). 뷰어 데모(match-log.json)는 쇼케이스, 스탯 증빙은 리얼.
7. **자기 기계검증 → 그 다음 독립 QA 판정.** 기계적 지표(`tools/perceptibility.mjs` 6/6, `tools/qa-match.mjs` 정합성)로 1차 거른 뒤, 최종 판정은 반드시 독립 QA.
8. **커밋/이슈:** 커밋은 hero 요청 시. gh 계정은 `dd0114` (평소 active 는 `peter-park_trueb` → 작업 전 `gh auth switch --hostname github.com --user dd0114`). 커밋 메시지 `[Spider] type: ...` + Co-Authored-By.

---

## 2.5 엔진 QA — 상시 트랙 (지속 규율, 1회성 아님)

> 엔진·뷰어는 계속 바뀐다. QA 는 **매 변경마다 게이트로 + 정기 스윕으로 반복**하는 **상시 트랙**이다(끝나는 작업 아님).
> SoT = **QA 에픽 #25**(epic:qa, append-only — 발견을 계속 쌓고, 닫지 않는다. 구 #22 포함). owned-glob = `packages/engine/**`.
> 서버 트랙(에픽 #32 AI 워커, `packages/server/**`)과 **병렬 안전** — `packages/shared/**`(계약)만 프리즈·조율.

### QA 루프 (엔진/뷰어를 건드릴 때마다 = 게이트)
1. **기계검증 1차**: `node tools/qa-match.mjs`(상황-데이터 정합성) + `node tools/perceptibility.mjs`(6/6). 여기서 1차로 거른다.
2. **E2E 계약**: `npx playwright test`(이벤트↔연출 계약, `packages/engine/dev-viewer/e2e/`). 새 연출/버그는 **계약 먼저 박제**(`test.fail`, E2E-TDD) → 고치며 해제.
3. **실화면 검증**: `/visual-capture-qa` 스킬 — Playwright 캔버스 캡처 → **Read 로 눈으로 확인** → before/after 재캡처. **좌표 추론 금지**(좌표만 보고 오판한 실적 있음).
4. **결정론 가드**: 동작 바뀌면 `npm test`(골든 갱신 + desync 0 + resume 동일 + hygiene grep 0). §2-5 불변.
   **config 노브를 만졌으면 `npm run test:ladder` 도**(사다리는 기본 스킵 — 바로 아래 §참조, #371).
5. **최종 판정 = 독립 QA**: `.claude/agents/independent-qa.md`(별도 컨텍스트). **자기검수 금지**(§2-2). blocker 0 이어야 통과.

### ⚠️ config 노브를 만졌으면 `npm run test:ladder` 도 돌린다 (#371)
`npm test` 는 **항상 필요한 것**만 돈다 — 결정론(desync·resume·hygiene) · 골든 · 관계식 계약 ·
밴드 **1점 확인**(60시드 집계 1회). **사다리(단조성) 계약은 기본 스킵**이다: 60시드 집계를 10회
돌려 혼자 4.8분을 썼고(=`npm test` 4.3분의 대부분), 그건 "이 노브가 정말 레버인가"를 보는 것이라
**노브를 만지는 웨이브에서** 필요하지 매 커밋마다 필요한 것이 아니다.

```bash
npm test              # 항상 도는 계약 (사다리 제외)
npm run test:ladder   # 사다리·단조성 — engine config 노브를 만졌으면 필수
npm run test:full     # 전량 (항상 + 사다리)
```

**⚠️ 사다리를 없앤 것이 아니다.** `decisionWeights.shoot` 이 사슬 코어에서 완전 무효가 된 것을 잡은
게 정확히 그 사다리다(#338) — 없애면 죽은 노브를 놓친다. 삭제가 아니라 **게이트**이고, 게이트된
스위트가 조용히 사라지지 않게 `realism/gate.test.ts`(커버리지 손실 가드)가 **항상** 검증한다.
근거·레지스트리 = `packages/engine/src/realism/gate.ts`.

### 정기 스윕 (코드 변경 없어도 주기적으로)
- **§8 백로그 소진**(코너 크로스 루틴 등), **E2E 계약 커버 확대**(계약 없는 연출 경로), **회귀 감시**(기계지표·골든).
- 스윕 결과·발견은 **QA 에픽 #25(서브 이슈) 에 append** → 고치면 계약 통과로 회귀 방지.

### hero 컨펌 채널 = QA 콘솔 (#191)
hero 의 눈 판정이 필요하면 **tmux 창을 오가지 말고 QA 콘솔에 탭을 올린다**. 세션은 탭을 등록해 "무엇을 고쳤나 ·
봐줄 것 · 확인 포인트(초)"를 붙이고 `wait` 로 잠들었다가, hero 가 남긴 문장을 **지시 그대로** 받아 이어간다.

```bash
node tools/qa-console.mjs start                       # 콘솔 기동(1회) → http://127.0.0.1:8300/qa/console
node tools/qa-tab.mjs register --id <이슈>-<슬러그> …    # ⚠️ hero 요청·컨펌 후에만(자율 생성 금지)
node tools/qa-tab.mjs wait --id … --timeout 900        # 백그라운드로 — 도착 = 종료 = 세션 재진입
```

레시피·문제해결 = **`docs/plan-v5/qa-console-playbook.md`**, 설계·결정표 = `docs/plan-v5/qa-console.md`.
피드백은 `~/hmb-qa-console/`(자체 git 리포)에 변경마다 커밋돼 이력이 남는다. 독립 QA 판정(§2-2)을 대체하지 않는다 —
콘솔은 **hero 와의 비동기 컨펌 창구**다.

### 요약 원칙
기계검증 → E2E-TDD → 실화면 캡처 → 결정론 가드 → **독립 QA 판정**. 이걸 매번·반복해서 돈다.

---

## 3. 아키텍처 (모노레포, npm workspaces)

```
packages/engine/   순수 결정론 공간 시뮬(Tier B). 프레임워크·IO·전역난수 의존 0.
  src/  config·rng·fixedmath·pitch·ball·perception·decision·contest·hash·simstate·match·fixtures
        + *.test.ts (determinism/resume/hygiene/kickoff)
  dev-viewer/  index.html(뷰어) · playback.mjs(순수 재생로직,테스트됨) · playback.test.ts
               generate-demo.ts(showcaseConfig) · match-stats.ts · build-standalone.mjs
packages/shared/   직렬화 계약(zod): TacticalInput·SelectData·MatchLog(+MatchEventType) · clamp
packages/server/   (미착수) 권위: Claude 호출 + engine 실행
apps/web/          (미착수) React + PixiJS 정식 UI
tools/             perceptibility.mjs · qa-match.mjs · shoot.mjs (+ qa_*.mjs 는 QA 임시스크립트)
docs/ research/    PRD·PLAN·조사문서
```

- 의존 방향: `web → server → engine`, 모두 `→ shared`. engine 은 shared 타입만 안다.
- **엔진 = Tier B 축소 공간 에이전트**: 선수가 피치 좌표를 갖고 1초 틱마다 인식→판단→실행(perceive→decide→act→contest). FM식 0.25초 물리(Tier C)는 Backlog.
- 재현 계약: `(seed + selectData + inputLog + EngineConfig 버전)` 만으로 headless 100% 동일 재생.

---

## 4. 명령어 (자주 쓰는 것)

```bash
cd ~/spider/hmb-online
npm test                    # 전체 vitest (engine 결정론/규칙 + shared + playback). ⚠️ 사다리는 기본 스킵(#371)
npm run test:ladder         # 사다리·단조성 (engine config 노브를 만졌으면 필수 — §2.5)
npm run test:full           # 전량 = npm test + 사다리
npm run typecheck           # tsc --noEmit
npx vitest run packages/engine                         # 엔진만
# 데모(match-log.json) 재생성 = generate-demo.test.ts 실행:
npx vitest run packages/engine/dev-viewer/generate-demo.test.ts
# 뷰어 단일파일 빌드 + 열기(서버 불필요):
cd packages/engine/dev-viewer && node build-standalone.mjs && open viewer-standalone.html
# 기계 검증:
node tools/perceptibility.mjs   # 관전 가독성 6/6 (공속도·spread·골빈도)
node tools/qa-match.mjs          # 상황-데이터 정합성(골=네트, 선방=키퍼 등)
# 이벤트↔연출 계약 E2E (V1, Playwright): 타입별 자막·공위치 계약 + 버그2건 test.fail 박제.
npx playwright test              # globalSetup 이 풀해상도 테스트뷰어(showcase+real) 조립 후 실행
HMB_PROVE_BUG=1 npx playwright test save.spec.ts goal-flight.spec.ts  # 버그 raw 실패 재현(증빙)
# 독립 시각 QA(Playwright): .claude/agents/independent-qa.md 서브에이전트로 (자기검수 금지)
```

- 뷰어 테스트 훅: 페이지의 `window.__viewer` — `ready() events() seek(tick) play() pause() cur() captions() render() renderAt(tp) idxOfTick(t) showSituationAt(t) autoPace(on)`. Playwright 로 임의 틱 검수 가능. (`render()/renderAt` = 보간 후 렌더 공 = 순간이동 검출용, `cur()` 는 원시 스냅샷.)
- E2E 계약: `packages/engine/dev-viewer/e2e/*.spec.ts` (captions·save·goal-flight·restarts·fouls·shot-outcomes·whistles). 입력로그(match-log.json=showcase, fixture-real.json=offside/card 커버)는 gitignore 생성물 — globalSetup 이 없으면 vitest 로 생성.
- Playwright chromium 설치돼 있음(`~/Library/Caches/ms-playwright`). 없으면 `npx playwright install chromium`.
- pnpm은 이 환경에서 corepack 이슈로 깨짐 → **npm 사용**.

---

## 5. 현재 상태 (epic-flow)

**완료(닫힘)**: #13 Phase 1 PoC 에픽 — Wave 1(S1·S2 엔진+스키마, Gate G1 PASS) + Wave 1.5(V1~V3 이벤트↔연출 신뢰성, PR #18) + S3 PoC(#19 프롬프트→움직임 증명) + E0 병렬 환경(PR #20). #21/#9/#23/PR#27 은 대체·종결. **#32 AI 워커 W1~W3 완료** — 자산(executor·resilience·metrics·claude CLI)은 #63 이 승계, 파일 큐는 퇴역 예정.

**게임 시스템 v2 초기 개발 완료(2026-07-18, PR #70 머지)**: 에픽 #61 data·#62 server-java·#63 ts-servants **완료(닫힘)**, #64 web은 W3(뷰어 통합, R1 #65 의존)만 잔여. 통합 게이트 G-A(3프로세스 stub·리플레이 bit-identical)·G-B(브라우저 AC-W1)·G-C(라이브 AI — 프롬프트→전술 파라미터 방향성 3/3 분리) 전부 PASS. **데모 실행법 = #60 마지막 코멘트.**

| 활성 트랙 | SoT | owned-glob | 내용 |
|---|---|---|---|
| **모듈별 QA·피처 심화** (병렬 세션) | 트래킹 **#60** + 모듈별 에픽/이슈 | 각 모듈 CLAUDE.md | v2 초기 개발 위에서 모듈별 별도 세션으로 QA·심화. `server-java/` `apps/web/` `packages/server/` `data/` 의 CLAUDE.md가 위임 가이드 |
| **엔진/뷰어 QA** (QA 세션, 상시) | **에픽 #25** (epic:qa) | `packages/engine/**` | §2.5 상시 루프. G1.5 판정 #17 포함. v2 요청 이슈 #65·#66 수신측 |

**상대 밸런스 + 리그 승급 곡선 완료(2026-07-29, PR #264·#275 머지)**: 에픽 **#252** — 라이브 실데이터로
"오버 밸런싱"을 계량 확인(연습 승률 38.1%·실점 3.19 = 엔진 리얼리즘 밴드의 2배)하고 구조 결함 5개를
고쳤다. **엔진 무접촉**(강도는 SelectData 입력 계층) — 연습 승률 **31.8%→64.3%**, 봇전 ppg 산포
2.75/0.19→2.19/0.63, 디비전 10단계 사다리(D10 승급 확률 85.9% → 최고속 유저도 5시즌째가 D6).
가장 큰 원인은 봇 로스터가 아니라 **봇전 간이결과 모델**(`power-divisor`)이었다 — 유저가 승률 65% 를
찍어도 우승 확률 14.6% 라 리그 우승이 구조적으로 막혀 있었다.
파생 #262(화면 표시)·#268(시즌 밖 표시) 완료. 상세 = `docs/plan-v5/opponent-balance.md`,
모듈 지식 = `server-java/CLAUDE.md`·`apps/web/CLAUDE.md` 의 디비전 섹션.
검증 하네스 = `tools/league-difficulty-sweep.ts`(로스터를 **서버 덤프에서 읽는다** — TS 로 재구현하면
구현과 검증이 같은 실수를 공유한다).

**백로그(open 유지, 추후 wave 재편)**: S4 #10(밸런스 Go/No-Go) · S5 #11(세션 상태머신) · S6 #12(PixiJS 정식 렌더) ·
**#261**(연습 난이도 선택 UI — `GET /api/bots` 부재. #252 로 "너무 강하다"는 해소돼 우선순위 낮음).

---

## 6. 엔진 버전 이력 (packages/engine, config.version)

| ver | 변경 |
|---|---|
| 0.1.0 | Tier B 공간 결정론 엔진 + config 격리 + 디버그 뷰어 |
| 0.2.0 | 실제 축구 데이터 재튜닝(슛/패스성공/spread/세트피스 벤치마크) |
| 0.3.0 | 슛→공이 골대로 비행·네트 안착 |
| 0.4.0 | 행동 변주(롱드리블/수비오버랩/flair/로밍) — 단조로움 해소 |
| 0.5.0 | 슛 결정 버그수정 + 오프사이드·파울·카드·페널티·프리킥 |
| 0.6.0 | 빗맞은슛 코너 순간이동 버그 수정 |
| 0.7.0 | 빗맞은슛 골라인 밖으로 벗어나 보이게 |
| 0.8.0 | 골 후 킥오프 포메이션 리셋(t0 슬롯 일치) + kickoff 이벤트 + 실점팀 소유 |
| 0.9.0 | **선방 공을 골라인 앞 캐치 지점으로**(`saveCatchDepthM`=2.5m) — "선방인데 골처럼" 해소(V2 #15). 기하로 골(네트)/선방(골문 앞) 분리. |
| 0.10.0 | **데드볼 엔진 네이티브**(#59): 재시작 taker 를 스팟에 순간배치하지 않고 **평소 속도로 걸어가 픽업**(`assignWalkingTaker`) + 정지 시간을 도달까지 동적 연장(`walkStoppage`), 공은 스팟 정지. 뷰어 트릭(synth/freeze-play/워크인/pacing) 제거. **페널티 2단계**(#75): 박스 파울 시 공을 접촉 지점에 파킹(파울 비트) → 정지 종료 시 스팟 배치+런업(코너 shot_out→restart 패턴, `penalty.foulBeatTicks`) — 오픈플레이 공 순간이동을 "페널티킥!" 캡션 뒤로 가림. |
| 0.11.0 | **E1 패스 정확도 하향**(#99 Track α): `resolveArrival` 이 계획된 `passOutcome` 존중(`contest.passOutcomeAuthoritative`) — 기존엔 순수 기하로 실패 패스도 의도 리시버가 되찾아 "완성"으로 집계돼 성공률 과다(86%). 패스 압박은 근접만(`passPressureRangeM` 6m, 22m 아님). `computePassProb` 순수 추출. 리얼 20시드 패스성공 **86%→79%**(벤치 78-85), 전진/롱 ≪ 숏, 스로인 15→20. E3 갭분석 = `research/engine-realism-gap.md`. |
| 0.13.0 | **v2.1 통합**(setpiece #91/#91b + α): 세이브 굴절 코너를 키퍼 라인앞 freeze 가 아니라 **공이 포스트 밖(`saveCornerWideMarginM` 1.5m)으로 라이브아웃 + 키퍼가 그 궤적 위에서 다이빙해 쳐냄**(contest.ts) — "선방인데 멈춤/골 오인" 해소. α의 패스정확도(0.11.0)·롱패스(0.12.0)와 결합되어 새 골든 스냅샷. (뷰어: #90 코너/스로인 클로즈업 제거.) |
| 0.12.0 | **E2 롱패스/롱킥**(#99 Track α): `passOptions` 가 인식반경 밖(`longPass.minM~maxM` 30~55m) 전진 동료를 롱볼 후보로 추가(`PassOption.long`), `scoreOption` 롱 분기(fwdCap+distPenalty+selectBias)로 시도율 튜닝, `computePassProb` 거리페널티로 롱 성공<숏. `MatchEvent detail="long"`(pass/interception) 관통(shared 스키마 무변경). 리얼 20시드 **의도적 롱 시도 14.6%**(벤치 12-15), 패스성공 79.8% 유지(passBase 0.94→0.97 재보정). 잔여 최상위 갭 = 슛 과다(G-A). |
| 0.15.0 | **슛 과다 하향 — G-A**(#99 Track α): E2 롱볼 전진이 남긴 슛 과다(팀당 **23.85→13.58**, 벤치 12-14)를 config-only 로 정합. 5개 노브: `decisionWeights.shoot` 0.5→0.35, `shootInBox` 1.38→**0.6**(파이널서드 슛 "지배" 완화 — 후진 리사이클은 `backwardPassPenalty`·`shootCentralBonus` 로 계속 억제), `contest.xgBase` 0.225→0.19, `shootRange` 20→19(원거리 speculative 억제), `oneOnOneShootBias` 3.2→1.8. 리얼 20시드: **골 2.98→1.63**(벤치 1.4-1.65)·**슛당 xG 0.13→0.12**(벤치 0.10-0.12)·전환 13.6→11.9%·코너 8.3→5.4(G-B 동반 해소)·스로인 16.6→17.6. **E1/E2 무회귀**(패스 79.9%·롱 14.5%). 회귀가드=`realism/shot-frequency.test.ts`(단조성+다시드 12-14 밴드). 새 골든. |
| 0.16.0 | **좌우(y) 대칭 버그 픽스 — 코너 반복**(#25/#99 Track α): `decision.ts:decideOffBall` 폭확장 tie-break 가 정확히 중앙(y=center)에 선 4-3-3 ST·CM 을 항상 +y 로 밀어 공격이 피치 아래로 쏠림 → **코너 side top/bottom 3:213(98.6% 편중)**="같은 장면 반복" 인상의 실체(스퓨리어스 #110/#113 과 별개 축). 중앙 선수 `idHash` 패리티로 좌/우 분배(결정론 유지, `Math.random` 無). 균형화로 늘어난 저xG 와이드슛은 `shoot` 0.35→0.34·`shootAngleFactor` 0.7→0.85 재보정. 리얼 20시드: 코너 top/bottom **108:107**(균형)·슛14.0·골1.65·xG0.11·패스79.5% 전부 밴드. 회귀가드=`realism/lateral-balance.test.ts`. 새 골든. **리얼리즘 회귀 스윕(#139)**: 0.16.0 전지표 밴드(6/6 회귀0)·`research/engine-realism-gap.md` 갱신 + 하이진 게이트 주석 오탐 복구(코멘트 온리). |
| 0.17.0 | **시야 기반 인지·판단**(#147 W3, 후보 E — hero 실관전 채택): 오프더볼 선수가 상대를 아예 안 보던 상태에 **인지 + 판단** 두 계층을 넣는다. ①인지 — 1틱에 정밀 추적하는 상대 수가 유한(`vision.attentionBase` 3 ± `attentionAttrSwing` by positioning·mental), 나머지는 **마지막 본 위치**로 판단하고 `memoryTicks`(3) 넘으면 잊는다(librcsc pos_count 방식, `SimPlayer.seen` — **JSON 안전한 Record**). ②판단 — 아는 상대 전원에게 끌리지 않고 `markValueBaseM − 내골거리 − 도달비용·markCostWeight + markTargetBias` 가 최대인 **한 명만** 마킹, 가치 ≤0 이면 자리를 지킨다. `markTarget` 은 하드 오버라이드 → **가중치**로 재해석(계약 변경 0, 롤백 시엔 레거시 오버라이드 복원). 실측(4시드 골든): 한덩어리 **63.8→57.6%** · 완전동조 **32.2→9.0%** · 전환후 피크 0.95→0.88 · 큰움직임 정렬 0.844→0.805. 밸런스(20시드): 슛→골 전환·주행거리가 **벤치 안으로 진입**, 유효슛 개선(여전히 초과), 슛당 xG 는 2차 튜닝으로 **밴드 유지**(0.12), 팀 폭만 **+0.42 근소 이탈**, 파울·옐로 감소는 후속 과제 — 상세·수용근거는 `issues/2026-07-22-engine-vision-perception.md` AC2. 재튜닝 `shoot` 0.34→0.30 · `xgBase` 0.19→0.185 · `attackWidthReach` 0.13→0.10. 계약=`vision.test.ts`(변이체 킬 검증). 새 골든. |
| 0.18.0 | **마크 당김 오버슛(제자리 진동) 픽스**(#178, hero 실관전 제보): 시야 마킹(#147 W3)의 당김 `w` 가 **위치가 아니라 고정 길이 스텝**이라 이미 마크에 붙어 있으면 마크를 지나쳐 **반대편**을 목표로 잡았다 → 다음 틱 방향 반전 → **매 틱 ±3~5m 제자리 왕복**. 압박 지정 수비수는 목표가 공 위치라 마크와 겹쳐 최악(= hero 가 본 장면). `w` 를 **`movement.markGap` 스탠드오프까지만 클램프**(이미 안이면 당기지 않음, `decision.ts` 1줄). 실측(4시드): 볼 옆 수비수 **큰 왕복 43.1→6.35/100**(시야off 대조군 7.05 **보다 낮음**) · 평균이동 3.00→1.64 m/tick. 계약=`realism/mark-jitter.test.ts`(+측정유틸 `realism/jitter.ts`) — **절대 임계가 아니라 시야off 대조군 대비 관계식**으로 걸어 자기 임계 설정을 배제, 변이체 킬 검증(픽스 되돌리면 5/6 깨짐). 재튜닝: 진동하던 수비수가 자리를 비우던 것이 슛 기회였어서 슛 13.95→11.65 이탈 + 마크 옆 상주로 파울 11.93→14.10(3.7σ) → `foul.base` 0.0185→**0.016** · `shootInBox` 0.6→**0.9**. 20시드 전 지표 밴드(슛 13.28 · 골 1.65 · 파울 11.90 · **전환 12.27→11.70 밴드 진입** · xG 0.11). 동반: **하프 경계 미해결 슛** 해소(`settleInFlightShot` — 하프 마지막 틱 슛이 킥오프 리셋에 버려져 `onTarget+offTarget≠shots` 였던 선행 결함, 계약=`shot-settle.test.ts` 재개 동일성 포함) + `tools/qa-match.mjs` **import 경로 복구**(ad1b778 이후 실행 자체가 안 되던 §2.5 필수 게이트). 새 골든. |
| 0.19.0 | **공이 빈 공간에서 스스로 휘는 현상 제거 — #181**(hero 실관전 1'33"). 원인은 렌더가 아니라 **엔진 데이터**: ①`advanceBall` 이 `arrived = remaining <= f.speed`(=passSpeed 18m)로 판정해 공이 목표 한참 앞에서 도착 처리되고 ②`giveBallTo` 가 공을 컨트롤러 위치로 **거리 무제한 대입** → 마지막 한 틱이 임의 방향 점프(90분 1156회: p50 5.9m·p90 13.7m·**max 33.7m**). 뷰어는 선형보간만 하므로 이 점프를 "휘는 궤적"으로 그렸다. 파생 버그 동시 수정: **사이드라인 위에서 찬 공의 아웃 미검출**(`boundaryCross` 의 `t > 0` — 스로인 taker 는 라인 위에 서므로 크로싱 t=0 이 걸러졌다 → 공이 피치 밖을 날아갔다). 픽스: **정확 도착**(`ball.arriveToleranceM` 0) · **리드패스 조준**(`movement.passLeadWeight` — 리시버의 *미래* 위치로 찬다) · **소유 이전은 `controlRange` 안에서만**, 못 닿으면 공은 낙하점에 정지하고 claimant/최근접이 주우러 온다(`ball.settleSpeed` 0, `contest.arrivalWaitMaxTicks` 2). 계약=`realism/ball-continuity.test.ts` 4건(20시드 빈공간 꺾임 **161→0** · 정지→워프 **0**). ⚠️ 두 버그가 **패스 성공률·스로인 측정을 부풀리고 있었다**(계획 확률은 0.16.0 에서도 ~0.70, 측정만 79%) → config 8개 재보정(`controlRange` 2.5→3.5·`shoot` 0.30→0.55·`passForwardPenalty`·`passDistancePenalty`·`passFailOutProb`·`foul.base`·`yellowProb`)으로 전 지표 밴드 복귀. 기각한 대안(굴러가기·되돌아 달리기)과 전 수치 = `research/engine-realism-gap.md` §5. 독립 QA PASS(2R). 새 골든. |
| 0.22.0 | **데드볼 중 골키퍼가 자기 골문을 버리고 전진 — #230**(hero 오픈베타 실관전 제보, 라이브 유저 '별희' 3경기 재현 해시 일치). 원인은 #176/#185 가 넣은 **정지 중 규칙기반 배치**(`deadBallShapeTarget`)에 **골키퍼 예외가 없던 것**: 목표 = 기본위치 + (스팟−기본위치)×`shapeReachX`(0.35) 인데 골키퍼만 기본위치(자기 골라인)에서 상대 진영 스팟까지가 90m 를 넘어 **0.35 × 95m = 33m** 가 그대로 전진량이 됐다(예측 66.76 vs 라이브 실측 66.0~66.8 — 오차 1m 미만). 필드 플레이어에게 35% 는 몇 미터라 정상. **골킥만의 문제가 아니었다** — 같은 함수라 골킥 36.7m · 페널티 36.3m(공격팀 GK 가 하프라인으로 산책) · 스로인 22.1m(빈도 최다 444회) · 프리킥 22.3m 전부 해당. 픽스: ①`rules.deadBall.gkShapeReach` 신규(기본 0)로 골키퍼 당김을 필드와 **분리** ②`deadBallExcluded` 의 골키퍼 면제를 **"그 구역이 자기 박스일 때만"** 으로 좁힘(잠복 결함 — Law 13/14 골라인 예외를 "모든 GK 무조건"으로 적용해, 골킥처럼 구역이 **남의 박스**여도 상대 GK 가 면제돼 걸어 들어가도 막을 게 없었다. 페널티 수비 GK 예외는 보존). 실측 전 종류 **p50 5.2~5.7m**(자기 자리 유지). 계약=`gk-deadball.test.ts`(임계는 config 가 아니라 IFAB 박스 깊이 16.5m). ⚠️ #176 계약이 못 잡던 이유 = 그 스캔이 구현과 **같은 이유로** 상대 GK 를 제외(`p.playerId === oppGk`)해 "너무 많이 나가는" 방향이 사각지대였다. 밸런스 60시드 무회귀(골 1.53→1.52 · 슛 12.98→13.12 · **shotConvPct 12.18 밴드밖→11.56 밴드안**). 동반: 뷰어가 골킥에도 코너/스로인과 같은 상황자막+freeze(hold 650ms — 골킥만 유일하게 무정지라 관객이 상황을 인지할 신호가 없었다) + e2e 픽스처 시드 재선정(#186 스캐너, …137→…031 — 정지 중 배치가 바뀌며 ④체인 소멸). 독립 QA PASS(blocker 0). 새 골든 + ROLLBACK_HASH 갱신. |

| 0.23.0 | **같은 `playerId` 가 양 팀에 있으면 데드볼 재시작이 영구 정지 — #231**(오픈베타 실제보). 유저 덱과 봇 로스터가 **같은 선수 카탈로그를 공유**하므로 같은 선수가 양 팀에 동시에 출전할 수 있는데(라이브 51하프 중 20하프), 엔진이 `state.byId` 를 **`playerId` 단독 키**로 잡아 두 인스턴스 중 하나가 덮였다. 그래서 `byId.get(ball.owner)` 가 **반대 팀 인스턴스**를 돌려주고 → `takerWalkingIn`(taker 가 스팟에 도달했나) 이 **영구 참** → `decideBallOwner` 가 한 번도 호출되지 않는다 = **공을 차는 코드에 도달할 수 없다**. 스로인 하나로 하프가 통째로 죽었다(라이브 실측 **1384틱=23게임분** 공 정지·이벤트 0건). 픽스: 엔진 내부 조회를 **`(side, playerId)` 고유키**로 (`simstate.ts` 의 `playerKey`·`buildById`·`playerAt`·`ballOwnerOf`·`isBallOwner`·`claimantSideOf` 가 SoT). 같은 뿌리의 잠복 버그 동시 해소: **퇴장 시 `byId.delete(id)` 가 반대 팀 동명 선수를 삭제**(`sendOff`) · **마킹 대상이 우리 팀 선수로 해석**(`markTarget`) · claimant/슈터 오인. **shared 계약 무변경**(`ballOwner`·이벤트 `playerId` 는 계속 순수 id, `resumeState` 스키마 그대로 — claimant 의 팀은 `passOutcome` 에서 파생). 중복 없는 경기엔 **bit-identical no-op** 이라 **골든 무변경**(예외: `vision.enabled=false` + `markTarget` 이 같은 팀 id 인 레거시 롤백 경로만 달라진다 — 그쪽이 더 옳다). 계약=`deadball-duplicate-id.test.ts`(절대 임계 대신 **중복 없는 대조군 대비 관계식**, 변이체 킬 검증). 라이브 51하프 전수 재시뮬: 데드락 **7건 해소**(1384→25틱 등)·정상 42하프 **무회귀**. 잔여 정지 1건은 원인이 달라 **#239** 로 분리(루즈볼 미회수). 독립 검증 PASS(blocker 0). ⚠️ 배포: 버전 범프라 구 `resumeState` 가 거부된다(진행 중 매치 재개 실패) → **#241**. |
| 0.24.0 | **볼 소유자 결정 코어를 사슬 탐색으로 교체 — #279**(A/B 실관전 후 hero 채택). `chain.mode` 기본값 `"weighted" → "chain"`. 기존 코어는 **행동별 즉시 점수를 가중 추첨**해 "이 패스 다음에 뭐가 되는가"를 볼 자리가 없었다(그래서 백패스·슛위치·다이렉트함을 노브로 따로 눌러야 했고 하나를 누르면 다른 게 튐 — 0.15.0~0.19.0 매번 5~8개 재보정). 사슬 코어는 **도달 상태의 EV**(`EV = p×V(성공상태,깊이−1) + (1−p)×V(턴오버)`)를 비교한다. 20시드 대조(같은 시드, 코어만 교체): 시퀀스당 패스 **2.48→3.85** · 인플레이 시퀀스 8.35→**10.17초** · 전진 후보 0개 **23.55→18.15%** · 패스 성공률 78.35→**83.76%** · 태클 **74.8→41.6** · 롱볼이동 26.5→**19.7**. ⚠️ **밸런스는 내려간다**: 골 **1.70→1.40** · 파울 **12.63→6.43** · 옐로 **2.10→0.70** · 슛 13.38→11.68. hero 방침("밸런스는 config 로 마지막에")대로 **S8 에서 1회 재보정**하며 지금은 통과시킨다. 백패스%는 11.0→**24.2** 로 올라간다(사슬이 리사이클을 EV 로 인정 — S4 국면별 가중치의 수리 대상). ⚠️ **와이어 포맷 파괴적 변경**(S1 이 `possessionSince`·`lastTurnover`·`plan`·`phase`·`intents` 를 필수로 추가) → 구 `resumeState` 는 형태 오류 400 이 아니라 **version mismatch** 로 거부돼야 한다(그래서 범프 필수). **`"weighted"` 는 지우지 않았다 = 롤백 스위치**(그 경로는 한 줄도 안 바뀜, `chain-search.test.ts` 가 `chain.search` 노브 면역을 계약으로 박제). 회귀 주의 3건: ①`decisionWeights.shoot` 이 **chain 에서 무효**(EV 는 `chain.goalValue` 가 레버 — 8→1.20 · 12→12.31 · 26→17.50 슛/팀, `shot-frequency.test.ts` 가 사다리로 박제) ②쇼케이스 config 가 그 죽은 노브에 의존해 **24분 데모 골 8→0** 이 됨 → `contest.shootRange` 19→**24**(쇼케이스만)로 대체해 골6·선방12·코너8·카드2·PK1 복구 ③`shot:one_on_one` 이 **0건**(판정이 `decision.ts` 에만 있고 `chain.ts` 엔 없다) → `shot-outcomes.spec.ts` 를 `test.fail` 로 박제, S5 에서 복구. 골든 이동: 데모 골든(events 1214→1577·score 2:3→1:4, 골 5 유지) · vision 롤백 해시 · mark-jitter/movement-synchrony 스냅샷. desync 0(80회) · resume 통짜 동일 · hygiene 0 · playwright 62/62 유지. **안정 태그는 박지 않는다**(제보 4건 수정 + S8 밸런스 후). |
| 0.25.0 | **프리킥 벽·백업 + 데드볼 "전원 정지" 해소 — #307**(hero 실관전 제보 H4·H3). ①**벽 로직이 코드에 아예 없었다** — `restartFreeKick` 은 taker 만 세우고 나머지는 규칙기반 배치(`deadBallShapeTarget`)만 받았다. 새 `setpiece.ts` 가 **틱당 1회, decide 루프 앞**(§5-1)에서 팀 단위 역할을 배정한다: 벽 = 스팟→수비골 선상 **9.15m + `wallStandoffM`** 지점에 좌우 정렬, 인원은 상수가 아니라 **위협거리 매핑**(골까지 거리 + `wallWideWeight`×횡오프셋 → `wallCountNear`~`wallCountFar`, `wallRangeM` 밖이면 0), 선정은 **기본 위치(baseFx) 기준 전순서**(점수→`idHash`→`id`); 백업 = 공격팀 3명을 스팟 기준 (u,v) 정수 슬롯표에 배치(숏 옵션·리바운드). 접근 금지(#176)와 정합 — 벽 좌표가 구역 안이면 그 슬롯을 버린다. 20시드 **차는 틱** 실측: 벽(사거리 안) **1.70→2.70명**(벽 0명 11→2건) · 백업 **1.12→3.01명** · 9.15m 침범 **0건**. ②정지 중 **전원 굳음**은 목표가 고정이라 초반 수렴 후 창이 끝날 때까지 안 움직여서였다 → **재시작 시각에 맞춘 도착 페이싱**(`rules.deadBall.pacedArrival`: 목표는 그대로 두고 속도를 `남은거리/남은틱` 으로 조임) + **대기 오프셋 선형 보간**(`idleDriftSmooth`). 20시드 데드볼 "거의 정지"(팀평균<0.3m) **21.4→8.3%** · p10 **0.166→0.487** m/tick. ⚠️ **평균·중앙값은 오히려 내려간다**(1.548→1.497, 1.436→1.086) — 총 이동량을 늘린 게 아니라 **편 것**이라서다. 그래서 계약은 평균이 아니라 **아래 꼬리(p10·정지비율)** 로 박았다. ③#185/#174 **개선**: 왕복 0.17→**0.00**/100 · 단독질주 4.61→**0.06**/100 · 정지 중 최대변위 4.41→4.33 m/tick. ⚠️ 처음 시도한 **목표 램프**(기본배치→최종배치 단계 이동)는 정지비율은 잡았지만 왕복을 **0.00→1.17/100 으로 되살렸다**(선수가 뒤로 걸었다 앞으로 옴) → 기각, 아블레이션 근거는 `realism/h3-ablate.test.ts`. ④부수: 팀 계획(`state.plan`)을 **정지 중에도 갱신**(구 성질 = 정지 진입 직전 값으로 굳음, S3 선행조건 — 소비자가 없어 동작 변화 0, 해시만 이동). 밸런스(20시드 리얼): 골 1.40→**1.63** · 슛 11.68→**13.33** · 파울 6.43→**5.88** · 패스 성공률 83.76→**84.12%**(구조 지표 무회귀: 시퀀스당 패스 3.82 · 인플레이 10.3초 · 전진후보0 17.85% · 팀폭 48.0m). 골든 이동: determinism·mark-jitter·movement-synchrony 스냅샷 + vision 롤백 해시. desync 0(80회) · resume 통짜 동일 · hygiene 0 · playwright 62/62. **시드 재선정 2건**(전개가 바뀌어 사례 소멸): `penalty-spot.test.ts` 3→**4** · e2e `fixture-real` …099→**…001**. ⚠️ **잔여**: `tools/perceptibility.mjs` 5/6 — 쇼케이스 데모 골 6→3(91초/골, 목표 ≤75). 쇼케이스 전용 노브(`generate-demo.ts` 의 `contest.shootRange`) 재보정이 필요한데 그 파일은 뷰어 트랙 소유라 **미수정**. 리얼 config 는 밴드 안. |
| 0.26.0 | **공 물리 속도 벡터 재작성(#320) + 행동·의도 계층(#314) — 두 조 병렬 합류.** ①**A조 #320 공 물리**: 구 엔진의 공은 "목표점까지 등속으로 걸어간 뒤 `settle()` 이 속도를 25% 로 되올리고 `looseDecay` 로 깎는" **3단 인공물**이라 궤적이 `12.6 → 0.9 → 3.1 → 1.9` 로 **비단조 요동**했다(hero 실관전). 이제 `pos += v ; v *= friction` **한 줄**이다 — 목표점 보간 제거, 방향은 불변이고 **크기만** 준다(그래서 #181 "빈 공간 꺾임"이 구조적으로 0). 마찰은 종류별 3값(`ball.friction.{ground,lofted,shot}` = 0.62/0.92/0.96)이고 정지는 **자리가 아니라 조건**(`stopSpeedM` 1 m/tick). 구 `settleSpeed`(굴림 상한 노브) **제거** → `rollSpeedM`(4) 은 진단·계약이 "나는 중이냐 구르는 중이냐"를 가르는 **분류 전용**이고 물리에 관여하지 않는다. 실측(`HMB_MICRO=1 micro-probe` ②, 8시드): 비단조 요동 세그먼트 **19/2051 = 0.9%** · 마지막스텝/첫스텝 0.715(p50 0.846) · 궤적 예시 `10.6 → 9.7 → 9.0` · `5.6 → 3.5 → 2.1 → 1.3` (**단조 감속**). ②**B조 #314 행동·의도**: **걷어내기 신설**(`clearance` — 수비수가 압박 아래 자기 진영에서 **의도 수신자 없이** 위험지역 밖으로 차냄. `pass` 로 세면 패스 성공률 캘리브레이션이 오염되므로 **별도 이벤트 타입**이고 `passOutcome` 을 달지 않는다) + **차는 순간 따라 들어가기**(S1 이 만들어 두고 **아무도 안 쓰던** `intents`/`runOrder` 의 첫 소비 — 구 `match.ts` 는 패서를 그 틱에 **정지**시켰다) + **비소유팀 정지 해소**. 실측(`HMB_BEHAV=1 behaviour-probe`, 20시드): 걷어내기 **16.35/팀** · 패스발사시 전방러너 **4.28명** · 패서전진 **44.77%**(구동작 <1%) · 비소유 "거의 정지" **11.44%**(계약 ≤12.5, 수정 전 15.1) · 데드볼 taker/상대 비대칭 **0.022**(계약 ≤0.15). ③**합류 통합 수리 2건**(병렬의 당연한 비용): `match.ts` 의 clearance 가 `BallFlight` 를 **손으로 짜고 있어** A조의 `vxFx/vyFx` 권위 아래에서 **속도가 비어 공이 안 움직였다** → `kickBall` 로 교체 / `ball-physics.test.ts` 가 제거된 `ball.settleSpeed` 를 참조 → 굴림 판정을 `stopSpeedM ~ rollSpeedM` 구간으로 재정의. ④부수: `tools/perceptibility.mjs` **6/6 회복**(0.25.0 잔여였던 5/6 해소 — 40초/골) · `tools/qa-match.mjs` ✅ · tsc 클린. ⚠️ **계약 변경**: `packages/shared` 의 `MatchEventType` 에 `"clearance"` **순수 additive 추가**(프리즈 대상인데 사전승인 없이 들어감 → **#326**). 새 타입을 모르는 소비자는 폴백을 타므로 **apps/web 텍스트 타임라인에 경기당 ~32건 노출** → **#325**. ── **#327 lofted 착지 전이 — 합류를 닫은 수정** ───────────────── **증상**: 스로인/팀 18.09(0.25.0) → **30.05**(밴드 17–19, 구조 지표 이탈). **원인(실측으로 정정)**: 처음 진단은 "감속거리 188m 라 lofted 가 100% 필드 밖"이었으나 `loft-probe` 실측은 **max 84.8m · >125m 0건**이었다. 진짜 결손은 두 겹이다 — ⓐ 착지 판정이 **계획 낙하점 통과**에만 걸려 있어 조준이 피치 밖이거나 도달 불가인 공(오버힛·먼 걷어내기)은 **영영 착지하지 않고**(스텝 감쇠비가 10틱 내내 0.92) 라인까지 날아갔다 — 8시드 ≥3틱 구간 **600/990(61%)** 이 전 구간 공기저항만 받았다. ⓑ 착지해도 **속도를 하나도 잃지 않아** 계획 낙하점을 20m 지나쳐 굴렀다. 0.25.0(`stepToward`)은 목표에서 정확히 섰기 때문에 오버슛이 **구조적으로 0** 이었고, 속도 벡터로 바꾸며 그 0 이 사라진 것이 정체다. **수정**: `hangTicks` 를 **실제로 소비한다** — 그동안 이 필드는 물리도 판정도 읽지 않는 **장식값**이었다. `kick.loftHangTicks()` 가 발사 시 **감쇠를 누적해** 계획 낙하점에 닿는 틱을 정하고(등속 가정 `ceil(d/v)` 는 항상 10~30% 짧아 계획 창을 일찍 닫는다), `ball.loftMaxAirTicks`(5) 로 캡한다. `advanceBall` 이 매 틱 1 씩 깎고 0 에서 **착지** — `delivery` 를 `ground` 로 내리고(잔디 마찰) `ball.loftLandingKeep`(0.36) 로 **바운드 감쇠**를 건다. 착지 신호는 `AdvanceResult.landed` 로 나가고 `resolveArrival` 이 그 틱에만 헤딩 경합을 연다(물리가 착지를 정하고 판정은 신호를 받는다). ⚠️ `friction.lofted` 는 **안 건드렸다** — 0.81 로 낮추면 밴드엔 들어가지만 그건 "공중의 공이 틱당 19% 감속"이라 설계 의도(공기저항만)와 정면 충돌하고 볼륨이 같이 움직여 2노브 동시 재해가 된다. `hangTicks` 가 이제 동작을 정하므로 **`hashState` 에 흡수**했다. **60시드 스윕**(스로인/팀): air6/keep0.45 20.91 · air5/keep0.45 19.60 · air5/keep0.40 18.65 · **air5/keep0.36 18.54** · air4/keep0.45 16.04 · air3/keep0.35 4.83. **볼륨 재보정**: 착지 전이로 인플레이가 늘어 같은 `chain.goalValue` 11 에서 팀당 슛이 **16.79** 로 넘쳤다 — 노브가 아니라 표본이 바뀐 것이라 재보정. 60시드: gv 7.6→슛3.60 · 8.4→8.09 · 9.2→12.29 · **9.4→12.93** · 9.6→14.23 · 10→15.01 · 11→16.79. **확정 `chain.goalValue` = 9.4** — 경기당 골 **5.32**(hero 목표 5.0) · 팀당 슛 **12.93**(12–14) · 유효슛 **5.34**(4.5–5.5) · **스로인 18.54**(17–19) · 코너 **4.47**(4–6) · 패스 성공률 **82.57**(78–85) · 팀 폭 **47.90**(40–50) — **여섯 밴드 전부 통과**. (쇼케이스는 별개다(§2-6) — `generate-demo.ts` 에 `chain.goalValue: 11` 을 **쇼케이스 전용으로 고정**했다. 안 하면 리얼 재보정이 흘러들어 데모 골이 줄고 perceptibility 가 6/6 → 5/6 이 된다.) **미완 4건 처리**: ⓐ raw 급정지 래칫 **260 → 320** 재기준(실측 308) — raw 는 `데드볼+트래핑+무소유` 합산이고 증가분은 **트래핑**(소유 틱 25%→60.1% 의 정의상 귀결)이다. 이 웨이브가 책임지는 **무소유 급정지는 31.3 → 21.1** 로 이미 해소됐고 그 **상한 25 는 그대로 둔다**(그게 진짜 게이트다). A조 제안 360 은 여유가 과해 회귀를 놓친다. ⓒ `behaviour` 수비-러너 거리 방향 반전 → **#327 수정으로 해소**(13/13 green, 재측정 결과 정방향 복귀). ⓓ mark-jitter 백스톱 11.32 → **10.13**(임계 11) **해소** — 둘 다 궤적이 바뀌며 자연 해소됐다(밴드 안 넓혔다). ⓑ 롱패스 시도 11.18%(밴드 11.5–15.5 근소 미달)는 **잔여**. **새 계약 2건**(이 회귀가 11개 실패 어디에도 안 걸렸던 이유 = 스로인에 절대 게이트가 없었다): `ball-physics.test.ts` 에 ①**"한 번의 접촉으로 공이 피치 대각선(125m)보다 멀리 가지 않는다"**(구조 불변식 — 마찰·볼륨 노브와 무관하게 참이어야 하는 성질) ②**스로인/팀 절대 밴드**. 측정 함수는 진단(`loft-probe`)과 **공유**한다(`realism/loft.ts`). **골든·시드 재생성**: determinism·mark-jitter·movement-synchrony 스냅샷 3종 + vision 롤백 해시 2 (`81c322bb` / `b248b6d4`) + e2e `fixture-real` 시드 …501 → **…536**(스팬 8틱, 재스캔 후보 **46개** — 파울 회복으로 넉넉해졌다). `penalty-spot` PK 시드 8 은 **유지**(재스캔 불필요). **게이트**: tsc 0 · `npm test` **2183 passed / 1 failed**(`tools/qa-console` 5초 타임아웃 **기존 플래키** — 단독 16/16) · desync **0**(80회) · resume 통짜 동일 · hygiene 0 · qa-match ✅ · perceptibility **6/6** · playwright **62 passed**. **헤딩은 안 죽었다**(수정 전후 8시드): 헤딩 이벤트 15.0 → **14.6**/경기 · 20경기 헤더 슛 12 → 7 · 헤더 골 1 → 1 (슛 감소분은 `goalValue` 재보정의 전역 효과). **진단 하네스 추가**: `HMB_LOFT=1` loft-probe(비행 경로장 분포 · 마찰 지문 · 스로인 귀속). |


뷰어(연출): 데드볼 정지→상황자막→skip, 골(GOAL, 골문 줌)과 상황카드(선방/빗나감/파울/오프사이드/PK) 분리, 하이라이트 자동페이싱, 타임라인 멀티 이벤트 핀(골/PK/선방/유효슛/코너, 클릭점프)+시:초 시계, 유효슛 링 이펙트, 코너·프리킥 pause 비트, **골 인바운드 보간 유지(순간이동 제거, V3 #16)**, playback.mjs 순수화+테스트. **데드볼 정상 재생(트릭 제거, #59)**, **파울/카드 자막 파울러 앵커 + 동시 토스트 세로 스택(#69)**, **파울 접촉 카메라 줌(두 선수 충돌 가시화, #74)**, **페널티 2단계 배치(#75)**, 연출 줌 autoPace 게이트. 이벤트↔연출 E2E 계약(`e2e/*.spec.ts`)로 회귀 방지.

### 안정 릴리스 태그 (버전관리 — 메인 세션 소비용)
> 이 QA/렌더링 트랙은 **별도 모듈**로, 메인 세션이 **안정 태그**를 소비한다(재발명 금지, 버전으로만 소비 — memory `domain-split-consume-versioned-output`). 매 안정화 시 git 태그를 박는다.

| 릴리스 태그 | config.version | 내용 | 상태 |
|---|---|---|---|
| **v1** | engine@0.10.0 | 데드볼 엔진 네이티브(#59) + 페널티 2단계(#75) + 파울/카드 연출(#69/#74). 독립 QA PASS. | ✅ 안정 |
| **v2** | engine@0.10.0 | (뷰어 전용, v1 엔진 계약 불변) 하이라이트 창 비대칭화(세이브 후 늦은 릴리스 해소, #83) + **뷰어 소비 주입 계약 네이티브화**(postMessage viewerReady/loadMatchLog, web 임베드용, #65) + 손상입력 하드닝. 독립 QA PASS. | ✅ 안정 |
| **v3** | engine@0.14.0 | **v2.1 게임성 확장 + 코너 버그픽스 + 뷰 모드.** 엔진(α #99): 패스정확도 하향(0.11.0)·롱패스/롱킥(0.12.0). 세이브→코너 라이브아웃+키퍼 쳐냄(#91, 0.13.0). **세이브 후 반대편 스퓨리어스 코너 버그 픽스**(#110/#113 — `resolveOut` 코너 side 오배정, v0.2.0 잠복, 0.14.0). 뷰어(β #100): 전면 영어·소유팀 트레일색·패스/가로챔/돌파 이펙트·카드 선수표시·FM식 상세로그·실시간 통계 HUD(토글) + **Auto/Fix 뷰 모드 토글·줌 조정**(#114). 코너/스로인 클로즈업 제거(#90). 독립 QA PASS ×다수. | ✅ 안정 |
| **v4** | engine@0.16.0 | **v2.1 완료 — α 밸런스 마무리 + β 클러터.** 엔진(α #99): 슛 과다 하향 #131(0.15.0, 팀당 23→14 벤치정합)·**좌우(y) 대칭 버그 #135(0.16.0**, 코너 98.6% 편중→균형·공격 y-쏠림 해소)·리얼리즘 회귀 스윕 #139(0.16.0 전지표 밴드 6/6 회귀0 + main 하이진 오탐 복구). 뷰어(β #100): **킥오프 선수 잔상 클러터 제거 #142**(잔상 도트가 포메이션 재배치 경계 미컷 → `spansReposition` 클립, 뷰어 전용·골든 무변경). 게이트 engine+shared 106·desync0×80·playwright 58/58. 독립 QA PASS ×다수. α 리얼리즘=0.16.0 in-band 마일스톤. | ✅ 안정 |
| **v5** | engine@0.17.0 | **오프더볼 시야 기반 인지·판단**(#147 W3, QA #25 산하). 선수가 "장님 아니면 신"이던 상태에 **인지 + 판단** 두 계층 신설 — ①1틱에 정밀 추적하는 상대 수가 유한(`vision.attentionBase`, positioning·mental 로 가감), 나머지는 **마지막 본 위치**로 판단하고 `memoryTicks` 넘으면 잊음(`SimPlayer.seen`, JSON 안전 Record) ②아는 상대 전원이 아니라 **위협도−도달비용이 최대인 한 명만** 마킹, 가치 없으면 자리 지킴 ③공격 시 공간 탐색. `markTarget` 은 하드 오버라이드 → **가중치** 재해석(계약 변경 0). 실측: 완전동조 **32.2→9.0%**, 한덩어리 63.8→57.6%, 턴오버 직후 피크 0.95→0.88. 밸런스: 슛→골 전환·주행거리 **벤치 진입**, 팀 폭만 +0.42 근소 이탈. **후보 5안을 뷰어로 만들어 hero 실관전으로 채택**(지표로는 후보 간 동률이라 눈으로 고름). 롤백 스위치 `vision.enabled=false` 는 0.16.0 과 **bit-identical**(골든 해시로 박제). *(0.18.0 부터 이 등가는 성립하지 않는다 — #181 이 시야 계층 아래의 공 물리를 바꿨고, 아웃 미검출은 순수 버그라 재현 토글을 두지 않았다. 계약은 "롤백 경로가 조용히 드리프트하지 않는다"로 재정의.)* 독립 QA PASS + module-verifier PASS(2R). 서버 재개 정합(#154 한 줄) 포함 `npm test` 965/0. | ✅ 안정 |
| **v6** | engine@0.21.0 | **엔진 실관전 버그 일소 + 게임화면 개편 + 서버 라이브 시계 + 배포 자가복구.** 엔진(QA #25, hero 실관전 제보 6건 해결): 0.18.0 #178 마크 당김 진동(왕복 43.1→6.35) · 0.19.0 #181 공이 빈 공간에서 스스로 휨(꺾임 161→0, 파생 사이드라인 아웃 미검출·측정 부풀림 재보정) · 0.20.0 #182 코너 전원 전진(잔류 0.00→1~3명, 팀축/선수축/롤백 3층 + 잔류 지터) · 0.21.0 #176 데드볼 접근 금지 규칙 + 정지 중 규칙기반 배치(#174·#185 흡수). 계약 인프라: 픽스처 신선도 가드(#188 낡은 픽스처 검증=거짓green 구멍)·시드 비의존 승격·밸런스 스윕(#189). web(P4-E1 #169): S1 3영역 고정 셸(페이지 스크롤 0)·정보 토글·결과 흡수 + **S2/S3 뷰어 SoT 수렴**(packages/viewer-core 추출, iframe·문자열스킨·브리지 제거 → **QA뷰어 = 게임화면**) + QA 관전도구(#177 시계·스크럽·핀, #180 초/프레임 컨트롤). server(P4-E2 #170): 감독시간 60초 + **서버 권위 라이브 시계**(화면 안 봐도 진행·seek-to-now), 정산 후반종료 이동. infra(#183): **터널 자가복구**(런타임 config+launchd 워치독, MTTR 98s) + 배포기록 정책(#171). 게이트 npm test 1236·desync0·resume·독립QA PASS. | ✅ 안정 |
| **v5.01** | engine@0.17.0 | **파울/옐로 벤치 복원**(config-only, 동작 변경은 튜닝값 4개뿐이라 소수점 태그): `foul.base` 0.0115→0.0185 · `boxFoulMult` 3.0→**1.0**(파울 빈도와 페널티/골을 분리 — 이게 열쇠) · `yellowProb` 0.17→0.15 · `onTargetBase` 0.28→0.205. 0.16.0 대비 **파울·유효슛·주행거리 3개 밴드 진입**(9.68→11.93 · 6.08→4.85 · 9.90→10.76). ⚠️ 대가: 유효슛 **비율** 42.8→34.85%(벤치 45-50, 선행 갭이 확대 — S4 #10 소관), 전환 +0.27·폭 +0.37 이탈. 독립 QA PASS(PK 소실 우려 기각 — 0.85→0.50/경기, 40% 경기 등장). | ✅ 안정 |

- **메인 세션 소비법**: `git checkout v5.01`(최신) 또는 해당 커밋 고정. 엔진 = `packages/engine/src`(무상태 simulate/resume), 뷰어 = `packages/engine/dev-viewer/viewer-standalone.html`(자립 재생) 또는 `index.html`+`playback.mjs`. **web 임베드**: iframe src=뷰어 → `{type:'viewerReady'}` 수신 후 `{type:'loadMatchLog', matchLog}` 주입(v2+, #65).
- **태그 자릿수**: **정수 증가**(v5→v6) = 새 기능·구조 변경. **소수점**(v5→v5.01) = 그 위의 **작은 후속**(튜닝값만 바뀐 config-only 조정 등). 소수점 릴리스도 독립 판정·게이트는 동일하게 받는다.
- **태그 vs config.version(두 축)**: 릴리스 **태그**(v1,v2,…)는 안정 스냅샷마다 증가(엔진 OR 뷰어 변경 무관). **config.version**(engine@x.y.z)은 **엔진 동작/재현 계약**이 바뀔 때만 범프 — 뷰어 전용 릴리스는 태그만 올리고 config.version 은 유지(v2 가 v1 과 같은 0.10.0 인 이유).
- **다음 안정화**: 변경이 독립 QA PASS + 전 게이트 green 이면 새 태그. 엔진 동작이 바뀌면 config.version 도 범프. 불안정 중간 커밋은 태깅하지 않는다.

---

## 7. 확정 설계 결정 (PRD)

- **AI 아키텍처 = 방식1** (프롬프트→AI가 인풋 사전생성→서버 결정론 시뮬). AI 개입 2지점: 경기전 + 하프타임. 방식2(매 틱 개입) 기각.
- **매치엔진 = Tier B 공간 에이전트** (ESMS식 능력치→확률 참고 + 좌표/움직임). Tier C(0.25초 FM 물리) Backlog.
- **AI 인풋 = `TacticalInput`**: 팀(formation·라인·압박·템포…) + 선수별 `behavior`(forwardRunFreq·widthTendency·pressAggression·passRisk…) + `basePosition` + `seed`. LLM = Claude(Sonnet), tool-use JSON 강제.
- **렌더 = 2D 실좌표**(디버그=Canvas, 정식=PixiJS). 앱=Capacitor.
- **메타(Phase 2) = 선수 카드 수집 + 덱(스쿼드+전술+프롬프트) 프리셋** 둘 다.
- **PvP-ready 경계**: 싱글부터 서버권위·결정론·입력로그 재생·직렬화 스키마 유지 → Phase 3에서 네트워킹만 얹기.
- **서버 = Java(Spring) + TS 서번트 2개, 정액제 유지 (ADR-1, 에픽 #32 · 2026-07-10)**: 게임 흐름·상태·잡 큐(DB)·결과캐시 전부 Java 소유. TS 는 ①엔진 러너(무상태 simulate/resume RPC — 엔진 재작성 금지) ②AI 실행기(Java 잡 API 폴링, Claude Code 정액제 세션, 서브에이전트 sonnet). Java 도입 = **v2 에픽 #62 로 확정 실행(2026-07-18, §10)** — 구 "S5(#11) 도입점"과 W1 파일 큐 잠정안은 대체됨. 아키텍처 다이어그램: claude.ai/code/artifact/29dc7dbc-1647-4da9-8a01-61c2ef2976c1

---

## 8. 알려진 비-blocker (Backlog, 낮은 우선순위)

- ~~슛 접근 하드컷(순간이동)~~ → **해결(0.9.0/V3 #16)**: 골 인바운드 보간 유지. 잔여: 슛 비행이 1~3틱뿐(shotBallSpeed 높음)이라 아주 빠름 — 더 부드럽게 하려면 sub-tick 샘플/속도↓(엔진).
- ~~킥오프 직후 궤적 잔상선이 피치 가로질러 지그재그로 그려짐(시각 클러터).~~ → **해결(v4 #142)**: 선수 잔상 도트가 포메이션 재배치 경계를 미컷하던 것 → `spansReposition` 클립. (공 트레일은 이미 #51 컷됨.)
- freeze→킥오프 렌더/자막 1프레임 desync(코스메틱). *(#142 캡처에선 재현 안 됨 — 원인 미겹침, open 유지.)*
- 선방 슛은 keyTicks(하이라이트 슬로우) 대상이 아니라 빠르게 지나감 — 필요 시 keyTicks 에 포함.

---

## 9. 새 세션 재개 체크리스트

1. gh 활성 계정이 `dd0114`인지 확인(`gh auth status`). **fleet 환경에서는 `gh auth switch` 금지**(전역 상태 — 다른 세션 깨짐).
2. epic 읽기: **#60**(게임 시스템 v2 트래킹 → 자기 모듈 에픽 #61~#64) + **#25**(QA 상시, 엔진) STATE → 어디까지 됐는지 파악. (#13/#21/#32 는 종결 — 이력 참고용.)
3. `npm test` 통과 확인, `node tools/qa-match.mjs`·`node tools/perceptibility.mjs` 로 현 상태 스냅샷.
4. 작업 시 §2 규칙 준수 — 특히 **판정은 독립 QA로만**, **테스트 먼저**, **config로만 튜닝**, **결정론 불변**.
5. **엔진/뷰어 변경이면 §2.5 엔진 QA 상시 루프를 매번 돈다**(기계검증→E2E-TDD→실화면캡처→결정론가드→독립QA). 발견은 QA 에픽 #25 에 append.
6. 뷰어 확인: `cd packages/engine/dev-viewer && node build-standalone.mjs && open viewer-standalone.html`.
7. **모듈 작업이면 해당 디렉토리의 CLAUDE.md 먼저**(`server-java/` `apps/web/` `packages/server/` `data/`) — §10 운영 모델 준수.

---

## 10. 게임 시스템 v2 A-to-Z (2026-07-18 확정 — 트래킹 #60)

엔진+렌더링(QA 도메인)을 제외한 **전 게임 시스템**을 최소 스펙(목업 포함)으로 끝까지: 로그인(목업)→로비→덱 구성(선발11+벤치, 선수별 프롬프트, 프리셋)→싱글 매치(봇 매칭→상대 분석→프롬프트→AI 인풋 생성→전반→하프타임(교체≤3)→후반→결과/전적/보상)→상점(포인트 뽑기 10+1, 5등급)→도감. 멀티='준비중'만.

- **계획 SoT**: `docs/plan-v2/` — PRD-v2(확정 결정 D1~D10 + 모듈별 AC), ERD, LLD-{server-java,ts-servants,web,data}. **계획서만 보고 구현 가능해야 한다**가 기준.
- **확정 스택**: Java 21 + Spring Boot 3 + Gradle + SQLite(Flyway) 권위 서버(ADR-1 지금 실행) / TS 서번트 2개(엔진러너 RPC·AI실행기 라이브+stub 토글) / React+Vite SPA / 선수 110명·5등급 시드(가상, 전량 교체 가능).
- **운영 모델(중요)**: 모듈 = 에픽 = 세션 = owned-glob. #61 data(`data/**`) · #62 server-java(`server-java/**`) · #63 ts-servants(`packages/server/**`) · #64 web(`apps/web/**`). 각 모듈은 독립 개발·버전 발행, 소비는 발행물/계약로만. **경계 넘어 재발명 금지** — 안 되면 이슈 레이즈(#57 원칙). 각 모듈 디렉토리에 위임용 CLAUDE.md 있음.
- **계약 프리즈**: `packages/shared/**` + `docs/plan-v2/api/openapi.yaml`(server-java W0 산출, web·servants 입력).
- **역할 템플릿(에이전트)**: `.claude/agents/module-implementer.md`(구현 절차) + `module-verifier.md`(적대 검증 절차). **도메인별 에이전트 정의 만들지 말 것** — 도메인 지식은 모듈 CLAUDE.md·계획 문서가 SoT고 에이전트 정의는 역할 절차만 담는다(중복·드리프트 방지). 예외: 고유 절차·도구를 가진 도메인(예: `independent-qa`). 모든 웨이브 = 구현자 → **별도 컨텍스트 검증자 PASS** → 커밋.
- **세션 토폴로지(2026-07-19)**: **hmb-online 매니저 세션**이 상위 조율(크로스 모듈 계약·통합 게이트·PR 머지·#60 트래킹·git 커밋 직렬화). 모듈 세션들(server-java·web·servants·data·QA)은 **각자 체크아웃**에서 자기 모듈 CLAUDE.md 기반으로 독립 작업 — 경계 밖 필요는 이슈 레이즈(#57 원칙).
- **통합 게이트**(#60): G-A stub 풀 E2E(AC-M2) → G-B 브라우저 E2E(AC-W1) → G-C 라이브 AI 스모크(AC-T3) → hero 실플레이 데모 → 모듈별 세션 QA 트랙 전환.
- **Phase 2 (2026-07-19 착수)**: v1은 태그 `phase1-v1`로 보존. Phase 2 계획 SoT = **`docs/plan-v3/`**(PRD-v3 · ERD-v2 · LLD-p2-{server,servants,web,data}) — 프리셋 스냅샷 개편·전술보드 D&D·OAuth목·컨디션 실효·지시 카탈로그·감독 관계 3축·AI 예산 가드·트레이드·로그/랭킹·리그 모드(10팀 18R). 구현 = 매니저(hmb:main)가 module-implementer/verifier 서브에이전트로 오케스트레이션.

## 11. 배포 (Phase 3 — 테스터 오픈) 좌표

> 내부 테스터에게 실제 배포해 플레이시키는 상태. 계획 SoT = `docs/plan-v4/`(PRD-v4 §G·§H). 배포 세션 = hmb:p3dep(에픽 #122), owned-glob `infra/**` + `server-java/Dockerfile`.

- **테스터 접속**: **https://hmb-online.pages.dev** (web=Cloudflare Pages 정적)
- **구성**: web=CF Pages · 백엔드=hero 머신 도커(java 18080 + runner 18790, **데모 8080/8790 무접촉**) · 인터넷 노출=**Cloudflare quick tunnel**(ngrok 무료는 앱 로드 동시요청에서 커넥션 끊김 — 실측 CF 8/8 vs ngrok 0/8) · AI=호스트 구독 claude CLI(모드 A). CORS 결선: web `VITE_API_BASE`=터널URL(빌드 인라인) ↔ 백엔드 `WEB_ORIGINS`=Pages URL.
- **운영 플레이북 = `docs/plan-v4/deploy-playbook.md`** (상태확인·기동·URL변경·디버깅·정지 전부). 상세 근거·아키텍처 = `docs/plan-v4/deploy.md`. 오픈 갭 = `docs/plan-v4/open-checklist.md`.
- **핵심 커맨드** (전부 `infra/`):
  - `bash infra/status.sh` — 배포 상태 한눈에(전부 ✓면 정상)
  - `bash infra/start-tunnel.sh` — 터널 기동+URL캡처+web재배포 원클릭(재부팅/URL변경 후)
  - `bash infra/deploy-web.sh <터널URL>` — web 만 재배포(URL 바뀐 경우)
  - `cd infra && docker compose up -d java runner` — 백엔드 도커
- **시크릿**: `infra/.env`(gitignore, 커밋 금지). `SERVANT_TOKEN`=openssl rand, admin 자격 등. 리포엔 `.env.example`만.
  **CF 배포 토큰은 spider 전역** `~/.config/hmb/deploy.env`(리포 밖·gitignore·chmod 600, `CLOUDFLARE_API_TOKEN`+`CLOUDFLARE_ACCOUNT_ID`) — 모든 워크트리 공유, `deploy-pages.sh` 자동 source.
- **web 배포**: `bash infra/deploy-pages.sh <백엔드URL>` = CF Pages(고정 `hmb-online.pages.dev`, 토큰 배포·로그인X). 표준 = **백엔드 터널 배포 → 웹 그 주소로 재배포**. quick-tunnel web(`deploy-quicktunnel.sh`)은 폴백.
- **디버깅 순서**: `status.sh`(인프라 배제) → 터널 인스펙터(실 요청/응답) → 코드. `/api/deck 404`=새유저 빈덱(정상). `Failed to fetch`(응답 없음)=터널/네트워크.
- **상시 고정 URL 승격(선택)**: named tunnel(도메인 필요) 또는 ngrok 유료 — deploy.md §5.2·§6.
- **⚠️ 배포 기록 필수(P4-D5 / #171)**: **배포할 때마다 `docs/deploy-log.md` 맨 위에 항목 append + 커밋**한다(배포시각·git SHA·모듈별 버전 engine/server-java/web/servants·이미지 다이제스트·URL·결과). `infra/version-manifest.sh` 산출을 옮겨 적는다. "언제 뭐 배포됐나" 조회 = `docs/deploy-log.md`(SoT). #164(버전 매니페스트)는 이 정책으로 승계·종결.
