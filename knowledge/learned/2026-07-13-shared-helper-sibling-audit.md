# Lesson: 공유 헬퍼 버그픽스는 형제(미경유) 경로를 전부 감사하라

출처 이슈: [issues/2026-07-13-penalty-spot-drift.md](../../issues/2026-07-13-penalty-spot-drift.md) (#48)

## 상황
세트피스 정지 중 taker(공 소유자)가 스팟에서 걸어나가 공이 드리프트하는 버그. 코너/스로인은 #31에서 `restartSetPiece` 헬퍼에 `taker.targetFx = spot` 핀을 넣어 고쳤으나, **페널티(`restartPenalty`)와 프리킥(`restartFreeKick`)은 그 헬퍼를 안 거쳐서 같은 버그가 남아 있었다.** hero가 PK에서 육안 발견(showcase 공 94,34→96,37.7 드리프트, free_kick 은 22m까지).

## 교훈 (재사용)
1. **공유 헬퍼에 버그픽스를 넣으면, 그 헬퍼를 *안 쓰는* 형제 경로를 전부 감사하라.** 같은 로직이 복붙돼 여러 함수에 흩어져 있으면(여기선 restartCorner/ThrowIn/GoalKick=헬퍼 경유, restartFreeKick/Penalty=직접 구현), 헬퍼만 고치면 나머지가 조용히 남는다. `grep`으로 동일 패턴(`taker.posFx.x = spot.x`)을 전부 찾아 대조.
2. **결정론-affecting 엔진 변경은 골든 스냅샷 + 패턴 의존 픽스처를 함께 깬다.** 동작이 바뀌면 (a) 골든 갱신, (b) 특정 이벤트 패턴에 의존하는 픽스처 테스트(예: #42 '세이브→라이브→빗나감')가 매치 캐스케이드로 깨지므로 **다중 제약 시드 재스캔**으로 재선정.
3. **인지 갭 버그는 데이터 트레이스 + 형제 코드 대조가 가장 빠르다.** 좌표 추론 대신 match-log 실측(스팟→드리프트 위치)으로 증상 확인 후, 잘 동작하는 형제 함수와 diff로 누락 라인 특정.

## 관련
- 선례: #31 (코너/스로인 taker 드리프트 → restartSetPiece targetFx 핀)
- 동일 세션 병행: #47 (뷰어 세트피스 아웃 비행 합성)
