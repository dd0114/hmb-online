---
name: visual-capture-qa
description: >
  "화면에 보이는 것"과 "데이터/의도"가 어긋나는 인지 갭 버그(예: 선방인데 골처럼 보임, 공 순간이동,
  선수 순간이동, 트레일 클러터)를 다룰 때 쓰는 QA 루프. 좌표·로그로 추론하지 말고 Playwright 로 실제
  캔버스를 스크린샷해 눈으로 확인하고, 버그를 E2E 계약으로 박제(test.fail)한 뒤 고치고 before/after 로
  재캡처해 증명한다. HMB 뷰어(packages/engine/dev-viewer)처럼 canvas 렌더 결과를 검증할 때 사용.
---

# Visual-Capture QA — 실화면 캡처로 검증하는 루프

## 언제 쓰나
증상이 **"보이는 것 vs 데이터/의도"의 어긋남**일 때. 데이터 레이어 테스트(`npm test`)·정합성 툴(`qa-match`)이
전부 통과하는데도 관객이 이상함을 느끼는 종류. 예: 선방인데 골처럼 보임, 슛/공 순간이동, 킥오프 때 선수
순간이동, 궤적선 클러터, 자막이 상황과 불일치.

## 절대 규칙
1. **좌표로 추론하지 말고 실제로 봐라.** 코드/스냅샷 좌표만 보고 "중앙이 맞다"고 판단하면 틀린다(실제로
   그렇게 헛짚었다). `page.screenshot({path})` 로 캔버스를 찍고 **Read 로 그 이미지를 직접 봐라.**
2. **판정은 별도 컨텍스트(독립 QA)로.** 자기가 만든 걸 자기가 "정상"이라 판정 금지 → `.claude/agents/independent-qa.md`.
3. **버그는 먼저 실패로 박제.** 고치기 전에 현재 코드에서 FAIL 하는 E2E 계약을 만들고(`test.fail` +
   `HMB_PROVE_BUG` 게이트로 raw 실패 증빙), 그 다음 고친다(E2E-TDD).
4. **뷰어 버그 vs 엔진 버그 구분.** 렌더된 값이 어디서 오는지 추적: 뷰어 보간/카메라/트레일 문제인가,
   아니면 엔진이 내보낸 데이터(공/선수 위치) 자체가 틀렸나. 엔진 변경이면 **결정론 불변**(desync 0 + 골든
   갱신 + resume 동일 + hygiene) 재검증 필수. 뷰어 변경이면 엔진/골든 무관.
5. **before/after 재캡처로 증명.** 고친 뒤 같은 장면을 다시 찍어 "이렇게 바뀌었다"를 이미지로 남긴다.

## 루프 (6단계)
1. **재현 캡처 스크립트** 작성 (`references/capture-template.mjs` 복사). 뷰어를 `file://` 로드 →
   `window.__viewer.ready()` 대기 → 문제 장면으로 `seek(tick)`/`play()` → 특정 틱/시점에 `#pitch` 스크린샷.
   - 시각 판정: 스크린샷.  수치 판정: `__viewer.render()/renderAt(tp)/cur()/captions()` 훅.
   - 순간이동 검출은 `renderAt(tp)` 로 분수 tickPos 를 촘촘히 샘플해 인접 프레임 이동량을 잰다(cur() 는
     원시 스냅샷이라 보간컷을 못 봄).
2. **본다.** 저장된 PNG 를 Read 로 열어 실제로 확인. 좌표 추론으로 대체 금지.
3. **진단.** 뷰어 문제(보간/컷/카메라/트레일/자막)인지 엔진 데이터 문제(위치/이벤트 정렬)인지 코드로 추적.
4. **계약 박제.** `packages/engine/dev-viewer/e2e/*.spec.ts` 에 이벤트↔연출 계약 추가. 알려진 버그는
   `if (process.env.HMB_PROVE_BUG !== "1") test.fail(...)` 로 그린 유지 + `HMB_PROVE_BUG=1` 로 재현 로그 증빙(evidence/).
5. **고친다(test-first).** 뷰어면 index.html/playback.mjs(+playback.test.ts), 엔진이면 config 로만 튜닝 +
   결정론 재검증. `test.fail` 해제 → 정식 통과.
6. **재캡처 + 독립 QA.** before/after 스크린샷 + `independent-qa` 서브에이전트 최종 판정.

## HMB 뷰어 훅 (packages/engine/dev-viewer/index.html)
`window.__viewer` = `ready() events() seek(tick) play() pause() cur() captions() render() renderAt(tp)
idxOfTick(t) showSituationAt(t) autoPace(on)`.
- `cur()` = 원시 스냅샷 공.  `render()/renderAt()` = 보간 후 렌더 공(순간이동 검출용).
- `captions()` = 화면에 실제 표시중인 flash(골)/situation(상황카드)/banner(세트피스) 텍스트.
- e2e 대상 뷰어는 `e2e/build-test-viewer.mjs` 가 현재 index.html+playback.mjs 로 풀해상도 조립(globalSetup).

## 검증 게이트
`npx playwright test`(계약) + `npm test`(엔진 결정론/규칙 + playback) + (엔진 변경 시)
`node tools/qa-match.mjs`·`node tools/perceptibility.mjs` + 독립 QA CLEAN PASS.

## 실적 (이 방법으로 잡은 것)
선방↔골 혼동(엔진: 선방 공을 골문 안 파킹 → 골라인 앞 캐치, 0.9.0), 골 비행 순간이동(뷰어: goal 을 보간컷에서
제외), 킥오프 선수 순간이동(뷰어: 세리머니 중 포메이션 트윈), 코너 궤적선 지그재그(뷰어: 트레일 6틱 페이드).
모두 좌표 추론으론 "정상"으로 오판했다가 실캡처로 잡음.
