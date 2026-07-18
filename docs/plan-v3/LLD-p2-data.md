# LLD — Phase 2 data (에픽 p2-data)

> 스코프: `data/**`. 산출은 버전 파일 발행(기존 규율: 결정론·검증 테스트·디스크싱크).

1. **players.v2.1.json**: v2(172명)에 `personality` 필드 추가 — FIERY/CALM/GLASS/AMBITIOUS 큐레이션(실선수 이미지에 맞게, 분포 대략 25/40/15/20%, 기준 문서화). 스키마 확장은 additive.
2. **league.v1.json**: 봇 팀명 풀(가상 클럽명 20+, 실클럽명 금지)·팀 성향 프리셋(공격/수비/압박/역습…)·리그 보상표(순위별 포인트).
3. **economy.v2.json**: 트레이드 수치(레어도별 대기시간 h, 단축 비용 곡선 계수, FA 확률 곡선 base/k, TRADE 수락 확률, 재제안 쿨타임) + 리그 보상 참조 — 서버는 이 파일만 읽음(하드코딩 금지 유지).
4. 검증 테스트 확장: personality 분포·enum, 팀명 실클럽 denylist, 확률 합·범위. 소비자(server-java) 경로 스위치는 p2-server W0에서.
