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
5. **최종 판정 = 독립 QA**: `.claude/agents/independent-qa.md`(별도 컨텍스트). **자기검수 금지**(§2-2). blocker 0 이어야 통과.

### 정기 스윕 (코드 변경 없어도 주기적으로)
- **§8 백로그 소진**(코너 크로스 루틴 등), **E2E 계약 커버 확대**(계약 없는 연출 경로), **회귀 감시**(기계지표·골든).
- 스윕 결과·발견은 **QA 에픽 #25(서브 이슈) 에 append** → 고치면 계약 통과로 회귀 방지.

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
npm test                    # 전체 vitest (engine 결정론/규칙 + shared + playback)
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

**백로그(open 유지, 추후 wave 재편)**: S4 #10(밸런스 Go/No-Go) · S5 #11(세션 상태머신) · S6 #12(PixiJS 정식 렌더).

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

뷰어(연출): 데드볼 정지→상황자막→skip, 골(GOAL, 골문 줌)과 상황카드(선방/빗나감/파울/오프사이드/PK) 분리, 하이라이트 자동페이싱, 타임라인 멀티 이벤트 핀(골/PK/선방/유효슛/코너, 클릭점프)+시:초 시계, 유효슛 링 이펙트, 코너·프리킥 pause 비트, **골 인바운드 보간 유지(순간이동 제거, V3 #16)**, playback.mjs 순수화+테스트. **데드볼 정상 재생(트릭 제거, #59)**, **파울/카드 자막 파울러 앵커 + 동시 토스트 세로 스택(#69)**, **파울 접촉 카메라 줌(두 선수 충돌 가시화, #74)**, **페널티 2단계 배치(#75)**, 연출 줌 autoPace 게이트. 이벤트↔연출 E2E 계약(`e2e/*.spec.ts`)로 회귀 방지.

### 안정 릴리스 태그 (버전관리 — 메인 세션 소비용)
> 이 QA/렌더링 트랙은 **별도 모듈**로, 메인 세션이 **안정 태그**를 소비한다(재발명 금지, 버전으로만 소비 — memory `domain-split-consume-versioned-output`). 매 안정화 시 git 태그를 박는다.

| 릴리스 태그 | config.version | 내용 | 상태 |
|---|---|---|---|
| **v1** | engine@0.10.0 | 데드볼 엔진 네이티브(#59) + 페널티 2단계(#75) + 파울/카드 연출(#69/#74). 독립 QA PASS. | ✅ 안정 |
| **v2** | engine@0.10.0 | (뷰어 전용, v1 엔진 계약 불변) 하이라이트 창 비대칭화(세이브 후 늦은 릴리스 해소, #83) + **뷰어 소비 주입 계약 네이티브화**(postMessage viewerReady/loadMatchLog, web 임베드용, #65) + 손상입력 하드닝. 독립 QA PASS. | ✅ 안정 |
| **v3** | engine@0.14.0 | **v2.1 게임성 확장 + 코너 버그픽스 + 뷰 모드.** 엔진(α #99): 패스정확도 하향(0.11.0)·롱패스/롱킥(0.12.0). 세이브→코너 라이브아웃+키퍼 쳐냄(#91, 0.13.0). **세이브 후 반대편 스퓨리어스 코너 버그 픽스**(#110/#113 — `resolveOut` 코너 side 오배정, v0.2.0 잠복, 0.14.0). 뷰어(β #100): 전면 영어·소유팀 트레일색·패스/가로챔/돌파 이펙트·카드 선수표시·FM식 상세로그·실시간 통계 HUD(토글) + **Auto/Fix 뷰 모드 토글·줌 조정**(#114). 코너/스로인 클로즈업 제거(#90). 독립 QA PASS ×다수. | ✅ 안정 |

- **메인 세션 소비법**: `git checkout v3`(최신) 또는 해당 커밋 고정. 엔진 = `packages/engine/src`(무상태 simulate/resume), 뷰어 = `packages/engine/dev-viewer/viewer-standalone.html`(자립 재생) 또는 `index.html`+`playback.mjs`. **web 임베드**: iframe src=뷰어 → `{type:'viewerReady'}` 수신 후 `{type:'loadMatchLog', matchLog}` 주입(v2+, #65).
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
- 킥오프 직후 궤적 잔상선이 피치 가로질러 지그재그로 그려짐(시각 클러터).
- freeze→킥오프 렌더/자막 1프레임 desync(코스메틱).
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
