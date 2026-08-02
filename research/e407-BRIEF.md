# E407 Phase 1 — 분석 공통 브리핑 (구현 금지)

이 파일은 에픽 #407 Phase 1 분석 서브에이전트 4명이 공유하는 컨텍스트다.
**Phase 1 은 분석만 한다. 프로덕션 코드(packages/engine/src/**, dev-viewer/**) 를 수정하지 않는다.**

## 기준
- 워크트리: `/Users/peter.park/spider14/hmb-online` · 브랜치 `engine/e407-analysis` (= origin/main 80e25a8)
- 엔진: `packages/engine/src/config.ts` `config.version = "engine@0.40.0"`
- SoT: GitHub 이슈 **#407** (`gh issue view 407`) · QA 상시 트랙 = #25
- 프로젝트 규칙: 루트 `CLAUDE.md` §2 / §2.5 필독

## 리소스 규율 (hero 강조 — 어기면 fleet 이 죽는다)
- 무거운 실행(vitest / playwright / 다경기 시뮬)은 **반드시 run-gate 경유**:
  `node tools/run-gate.mjs --label e407-<주제> -- npx vitest run <경로>`
  (`npx vitest` 직접 실행 금지. run-gate 가 슬롯 1개로 세션 간 동시성을 막는다 — 대기하면 그냥 기다린다.)
- 임시 분석 스크립트도 **N경기 시뮬이면 run-gate 경유**. 스크립트는 `research/e407-probe/` 또는
  스크래치패드에만 쓴다(프로덕션 트리 오염 금지).
- 장기 프로세스 금지. 프로세스 종료는 **PID only** (`pkill -f` 절대 금지).
- Artifact / 외부 호스팅 절대 금지. 목업·캡처는 로컬 파일만.
- `gh auth switch` 금지(전역 상태).

## 측정 표준 경로
- 다시드 밸런스 집계: `packages/engine/src/realism/harness.ts`
  - `REALISM_SEEDS`(20) · `GUARD_SEEDS`(60) · `runRealismBatch` 류 유틸
  - 벤치 밴드 단일 출처 = `packages/engine/src/realism/bench.ts` (`BENCH`)
  - 갭 리포트 = `packages/engine/src/realism/gap-report.test.ts`, 문서 = `research/engine-realism-gap.md`
- 임시 계측은 **vitest 테스트 파일로 짜서 run-gate 로 1회 실행**하는 것이 가장 싸고 재현 가능하다.
  (파일명 `packages/engine/src/realism/e407-<주제>-probe.test.ts` — **분석 종료 후 커밋할지는 세션이 판단**,
  프로덕션 로직은 건드리지 않는다.)
- 실화면 검증은 `/visual-capture-qa` 스킬 절차(Playwright 캔버스 캡처 → Read 로 눈으로 확인).
  **좌표만 보고 추론 금지** — 과거에 좌표만 보고 오판한 실적이 있다.

## 산출물 형식 (공통)
파일: `research/e407-<슬러그>.md`. **처음 보는 사람이 이 파일만 읽고 판단할 수 있어야 한다.**

1. **TL;DR** — 3~5줄. 결론과 권장 옵션.
2. **현상 / hero 원문 인용** — 무엇이 문제로 보고됐나.
3. **코드 구조 팩트** — 관련 파일·함수·config 노브를 `file:line` 로 정확히. 추측과 사실을 구분 표기.
4. **정량 증거** — 다시드 실측 수치(시드 수·표본 수·측정 방법 명시). 재현 커맨드 첨부.
   숫자 없이 "그런 것 같다" 금지. 못 쟀으면 "미측정"이라고 쓴다.
5. **원인 귀속** — 엔진 몫 vs 뷰어 몫 vs 튜닝 몫으로 분해. 각각 신뢰도(확정/유력/가설) 표기.
6. **개편 옵션 A/B/C** — 각각: 변경 범위 · 예상 효과 · 리스크(결정론/골든/밸런스 회귀) · 구현 규모(S/M/L)
7. **권장 + 근거** — 하나를 고르고 왜인지. 트레이드오프 명시.
8. **미해결 질문 / hero 결정 필요 항목** — 게임 내용·재미에 관한 것만(엔지니어링 방법은 묻지 않는다).

## 하지 말 것
- 프로덕션 코드 수정 · 커밋 · push
- 다른 주제 영역 침범(4/7/8/9 는 각자 담당) — 겹치면 리포트에 "타 리포트 소관" 으로 표기
- 자기검수로 "정상" 판정(§2-2) — Phase 1 은 판정이 아니라 증거 수집이다
