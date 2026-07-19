# 스로인·코너킥 클로즈업 제거 — #90

- **GH 이슈**: #90 (에픽 #25 하위)
- **트랙**: QA 에픽 #25 (`epic:qa`) 하위 · **owned-glob**: `packages/engine/**`
- **발견**: hero 2026-07-19 — "스로인이랑 코너킥 때 클로즈업 필요 없어. 없애줘."
- **상태**: ✅ 완료 (2026-07-19) — 클로즈업 제거 + nearKey 억제, 독립 QA PASS.

---

## 1. 문제정의
- **현상**: 스로인·코너킥 재시작 시 카메라가 스팟으로 클로즈업(줌)됨. hero: 불필요.
- **근본**: #59에서 도입한 `spSpot`(SETPIECE_ZOOM=1.7) 세트피스 걷기-구간 줌 — taker 워크인/박스 배치를 보여주려 스팟에 고정 줌. hero 는 세트피스를 클로즈업 없이 일반(와이드) 재생 원함.
- **영향 범위**: 뷰어 `index.html` 카메라(spSpot). 엔진 무변경. 파울/페널티 접촉 줌(contactPos #74)은 별개 — 유지.

## 2. 계획 (뷰어 전용)
- `index.html` 카메라에서 `spSpot`(setPiece/pauseOnly 줌) 제거 → 세트피스는 `useFollow`/와이드 일반 카메라. `SETPIECE_ZOOM` 상수 제거. contactPos(파울/페널티 접촉 줌)는 유지.
- **(독립 QA 발견 보강)** spSpot 제거만으론 부족 — 코너가 다음 하이라이트와 인접하면 `nearKey`(HL_PRE 사전 줌)가 대기 구간을 다시 침범해 2.6 클로즈업 재발. → `inSetpieceWait(tick)` 헬퍼로 **세트피스 대기 구간(공이 스팟 정지·taker 워크인)엔 nearKey 억제**(camera·speed 두 곳). 크로스 딜리버리(공이 스팟 떠남) 후엔 정상 하이라이트 복귀.

### Acceptance Criteria
- [x] **AC1** 스로인·코너킥 재시작에서 카메라 클로즈업(줌) 없음. Evidence: 실측 — 스로인@970 zoom 1.0(와이드) 전 구간, 코너@148 walk 프레임 zoom 1.0 전체피치 스크린샷(taker·박스 다 보임). SETPIECE_ZOOM(1.7) 고정 줌 소스 제거.
- [x] **AC2** wobble/급전환 회귀 없음. Evidence: spSpot 제거로 세트피스=일반 카메라(와이드 수렴, 반전 없음). playwright 32 green.
- [x] **AC3** 회귀 없음 — 파울 접촉 줌(#74)·골·데드볼 정상, playwright 33·npm test 202·qa-match·6/6, 엔진/골든 무변경(뷰어 전용).
- [x] **AC4** 독립 QA PASS(blocker 0). Evidence: independent-qa 재검 — 코너 8건+스로인 4건 전수 대기 구간 zoom 와이드(재상승 없음, `inSetpieceWait` 가드 확인), 딜리버리 후 골 하이라이트는 정상. 1차 blocker(nearKey 유출) 해소.

---

## 3. 진행 로그
| 일시 | Phase | 내용 |
|---|---|---|
| 2026-07-19 | 1~6 | spSpot 세트피스 줌 제거(index.html), SETPIECE_ZOOM 상수 제거. 세트피스=일반 카메라. |

## 5. Learned
(Phase 8)
