# Lesson: 다운샘플 standalone 은 스냅샷 밀도 의존 뷰어 로직을 깨뜨린다 — 실 산출물로 검증

출처 이슈: [issues/2026-07-14-deadball-redesign.md](../../issues/2026-07-14-deadball-redesign.md) (#51). 동류 선례: #50.

## 상황
데드볼 재설계 R1 에서 스로인을 "라이브로 나감 → 판정" 으로 바꿨다. 풀해상도 e2e(viewer-test.html)는 9/9 통과했으나, 독립 QA 가 재빌드 **standalone**(`build-standalone.mjs` STEP=2 짝수틱 다운샘플)을 실재생하니 스로인 4/9 가 순수 순간이동(blocker)이었다. 원인: 연속 아웃 판별 `isContinuousOut`이 **거리 기반**(prev→spot ≤25m)인데, standalone 에선 prev 스냅이 causeTick-1(홀수)이 아니라 2틱 전으로 밀려 거리가 뻥튀기 → 오판 → 컷+synth null = 순간이동.

## 교훈 (재사용)
1. **스냅샷 밀도에 의존하는 뷰어 로직(보간·연속판별·속도)은 다운샘플 standalone 에서 풀해상도와 다르게 동작한다.** e2e 를 풀해상도 뷰어로만 돌리면 못 잡는다. → **사용자가 실제 보는 산출물(viewer-standalone.html)로 검증**하라(독립 QA 에 재빌드 standalone 명시).
2. **다운샘플은 렌더에 필요한 틱을 보존해야 한다.** 이벤트 틱뿐 아니라(#50) 그 **접근 궤적(causeTick-1/-2)**도(#51). `keep = i%step===0 || eventTick || preEventTick`.
3. **거리 임계는 다운샘플에 취약하다.** 가능하면 "직전이 움직였나(속도)" + 접근 틱 보존 조합으로, 임계값 하나에 의존하지 말 것.
4. **독립 QA(§2.2)의 실증**: 구현자 e2e 는 다 green 이었지만 독립 QA 가 실 산출물 재생으로 blocker 를 잡았다. 자기검수 금지 원칙이 실제로 버그를 걸러냄.

## 관련
- #50 (standalone 홀수틱 이벤트 드롭 → 자막 스킵) — 같은 다운샘플 함정의 첫 발현.
- [[deadball-ux-redesign]] (hero 의 데드볼 UX 모델).
