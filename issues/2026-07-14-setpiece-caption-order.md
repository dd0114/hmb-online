# 세트피스 자막 순서 꼬임 — "스로인/코너킥!" 판정이 공 나가기 전에 뜸

- **GH 이슈**: #49 (에픽 #25 하위)
- **트랙**: QA 에픽 #25 (`epic:qa`) 하위 서브이슈
- **owned-glob**: `packages/engine/dev-viewer/**` (순수 뷰어, 결정론 무관)
- **선행**: #47 (세트피스 아웃 비행 synth) — 아웃비행은 맞으나 자막 타이밍이 synth와 동시라 순서가 꼬임
- **상태**: Phase 4 문제정의 (hero gate)

---

## 1. 문제정의

- **현상**: hero 육안(2026-07-14, 뷰어 8:45 스로인). 세트피스에서 "🙌 스로인!"/"⛳ 코너킥!" 판정 자막이 **공이 라인 밖으로 나가기 전에** 뜬다. 기대: 공이 나가는 걸(좌표) 끝까지 보여주고 → **나간 뒤에** 판정 자막. 실측(throw_in@525): 자막 뜬 순간 공 `(26.6, 51.3)` = 필드 안(사이드라인 y=68) → 그 뒤 synth가 공을 `(26.5,50.8)→(29.6,68)` 사이드라인으로 보냄. (실화면 캡처로 배너+필드안 공 동시 확인.)
- **근본 원인**: #47 의 synth 아웃 비행은 freeze **도입부(SYNTH_MS=350ms) 동안** 그려지는데, `situationCaption(...)`(index.html:461)은 **freeze 시작과 동시에** 호출된다. → 자막과 "공이 나가는 연출"이 동시 발생해, 관객엔 "판정이 먼저, 공은 그 다음에 나감"으로 보임. 코너도 동일 구조.
- **영향 범위**: 순수 뷰어(index.html 정지 트리거). setPiece 정지(코너/스로인) 전부. 엔진/결정론/골든 무관. 관객 인지(사건→판정 인과) 저하.

### Phase 2 — 분석 (발견 사실)
- index.html tickLoop 정지 트리거(≈457-476): `st.done` 세팅 후 `if(!st.pauseOnly) situationCaption(st.big, st.bigCol)` 즉시 호출 → 그 다음 `hold` 세팅 → `if(st.setPiece)` 에서 `synthOutFlight` 계산해 `hold.synth` 세팅.
- draw()(≈209-219): `hold.synth` 있으면 freeze 경과 `sp=(now-hold.start)/SYNTH_MS < 1` 동안 공을 from→(via)→exit 로 애니. sp≥1 이면 스팟 고정.
- 실측 캡처(throw_in@525): 자막 등장 순간 render 공 (26.6,51.3) 필드 안 → 이후 55ms 간격 51.3→54.5→57.8→…→68.0 로 사이드라인 도달(≈350ms). 즉 자막이 synth 완료보다 350ms 앞섬.
- SYNTH_MS=350(index.html:138). throw_in hold=650, corner hold=900(playback.mjs).

### Phase 3 — 진단
- **채택(확정)**: 자막 트리거가 synth 아웃비행보다 먼저(동시) 발생. synth 있는 setPiece 정지에서 자막을 synth 완료 시점까지 지연하면 "공 나감 → 판정" 순서가 됨.
- 반증 검토: "엔진 데이터 문제?" → 아님(순수 뷰어 타이밍). "synth 방향 오류?" → 아님(공은 정확히 사이드라인 도달, 순서만 문제).
- 부수 관찰(비-blocker 후보): 진입 시 공이 파킹(23,33)→(26,51) 1틱 18m 슬라이드(하드 클리어) — "점프" 느낌 일부 기여. synth 자체는 그 뒤 연속. 순서 수정 후 재평가.

---

## 2. 계획

### 채택 방향 (순수 뷰어, index.html)
- 정지 트리거에서 **synth 가 있는 setPiece 정지**는 자막을 즉시 호출하지 않고 `hold.pendingCaption = {text, col}` 로 보류. draw()/tickLoop 에서 `(now - hold.start) >= SYNTH_MS` (=아웃비행 완료, 공이 스팟 도달) 시점에 `situationCaption` 호출 후 pendingCaption clear.
- **hold 연장**: 자막이 원래 hold(650/900ms)만큼 보이도록 `hold.until` 을 `SYNTH_MS` 만큼 연장(총 = SYNTH_MS + st.hold). restart(jumpTo)도 그만큼 뒤로.
- synth 없는 정지(선방/빗나감/파울/오프사이드/PK/free_kick pauseOnly, 또는 synth 합성 실패한 setPiece)는 **기존대로 즉시 자막**(회귀 없음).

### E2E Goal
뷰어 재생 중 세트피스(스로인/코너)에서 공이 경계선을 넘어 스팟에 도달한 **뒤** "스로인!/코너킥!" 자막이 뜬다 — hero 가 "공 나감 → 판정" 순서를 확인.

### Acceptance Criteria
- [x] **AC1** 세트피스 자막이 처음 뜨는 순간, 합성 아웃비행이 완료돼 공이 스팟(경계선)에 있다(필드 안 아님). Evidence: e2e `caption-order.spec.ts` — throw_in 자막 순간 공 사이드라인 ±3m / corner 골라인 ±3m green(수정 전 throw_in red: y≈51 필드 안).
- [x] **AC2** 자막 가독성 유지: hold 가 SYNTH_MS 연장돼 자막이 원래 hold 시간만큼 표시된다. Evidence: 코드 `hold.until = ts + st.hold + captionDelay`(captionDelay=SYNTH_MS). 자막은 SYNTH_MS 후 발화 → 이후 st.hold 동안 표시.
- [x] **AC3** synth 없는 정지(선방/파울/PK/free_kick)는 자막 타이밍 불변(즉시). Evidence: captionDelay=0 분기(synth 없음) → 즉시 situationCaption. 기존 e2e captions/save/fouls/whistles green(playwright 31).
- [x] **AC4** 회귀 0: #47 아웃비행·#42·기타 연출 계약 유지. Evidence: `npx playwright test` **31 green**(29 기존+2 신규) + vitest **74 green**.
- [x] **AC5** 결정론/골든 불변(뷰어 전용, 엔진 미변경). Evidence: #49 변경 = `index.html`(M) + `caption-order.spec.ts`(신규)만(git status 확인). engine/src 의 contest.ts/snapshot diff 는 #48 미커밋 변경으로 본 이슈 무관.
- [x] **AC6** 실화면 재확인: throw_in@525 "공 나감 → 자막" 순서 캔버스 캡처 육안(§2.5). Evidence: `ti525_fixed_crossing.png`(공 27,56 크로싱 중 배너 없음) → `ti525_fixed_caption.png`(공 29,68 사이드라인 도달 후 "🙌 스로인!" 배너) Read 확인.
- [~] **AC7** 독립 QA — **FAIL (blocker 1건)**, 단 블로커는 #49 범위 밖 별개 버그.
  - #49 자막 순서 수정 자체는 검증 6/6 정상(스로인 525/542/559, 코너 148/644/978/1314): 자막 순간 공이 스팟 도달, hold 연장으로 표시시간 유지, synth 없는 정지(PK/save) 즉시 발화 회귀 없음.
  - **블로커(별개, 기존 구조 버그)**: 코너@765(홀수틱)의 "코너킥!" 자막이 **standalone 뷰어에서 아예 안 뜸**. 원인 = `build-standalone.mjs` STEP=2 짝수틱 서브샘플로 홀수 causeTick 스냅샷 부재 → `idxOfTick(765)`→766 → 선행 세이브 정지 jump 가 765 건너뜀 → 코너 정지 스킵. 풀해상도 viewer-test.html(e2e)엔 없음 = **standalone 다운샘플 전용**. #49(자막 타이밍)와 root cause 다름 → **신규 서브이슈 후보**(hero 판단 대기).

### Sub-goals
- SG1: E2E-TDD — "setPiece 자막은 synth 완료 후(공이 스팟)에 뜬다" 계약을 먼저 박제(현재 코드로 실패).
- SG2: index.html 정지 트리거에 pendingCaption 지연 + hold 연장 구현.
- SG3: 실화면 캡처(순서 확인) + 회귀 게이트.
- SG4: 독립 QA.

---

## 3. 진행 로그

| 일시 | Phase | 내용 |
|---|---|---|
| 2026-07-14 | 1~3 | 발견·분석·진단 완료. 자막이 synth 아웃비행보다 350ms 앞섬 실측 확정(throw_in@525 캡처). |
| 2026-07-14 | 4~6 | 문제정의·계획+AC hero 승인. GH 서브이슈 #49 등록. → Phase 7 /sk-goal 진입. |
| 1 | 2026-07-14 | AC1~AC6 [x] | E2E-TDD(caption-order red) → index.html 정지 트리거 재구성: synth 먼저 계산 → 있으면 자막 `hold.pendingCaption` 보류 후 SYNTH_MS 뒤 발화 + hold 연장. green. 게이트 playwright31·vitest74·6/6. 실화면 "공 나감→자막" 순서 캡처 확인. AC7 독립QA 진행. |
| 2 | 2026-07-14 | AC7 FAIL(범위밖 블로커) | 독립 QA: #49 순서수정 6/6 정상이나 코너@765 자막 누락 블로커 발견 = standalone STEP=2 다운샘플 + 홀수 causeTick 스킵(별개 기존 버그). #49 순서 로직 무관. hero 판단 대기 → 루프 중단. |

---

## 5. Learned  <!-- Phase 8 -->
