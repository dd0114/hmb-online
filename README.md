# HMB 온라인

> AI 프롬프트 기반 축구 시뮬레이션 게임. FM 틀 + 선수 개개인에게 자연어 AI 프롬프트 주입.

## 산출물
- 📄 **[docs/PRD.md](docs/PRD.md)** — 기능 관점 PRD (v1)
- 🔬 조사: [매치엔진](research/match-engine.md) · [전술/지시](research/tactics-instructions.md) · [렌더링](research/rendering.md) · [라이브개입 UX](research/live-intervention-ux.md) · [합성노트](research/_synthesis.md)

## 핵심 결정
- **AI 아키텍처**: 방식1(프롬프트→AI가 시뮬 인풋 사전생성→서버 결정론 시뮬). AI 개입은 경기전 + 하프타임 2곳.
- **로드맵**: Phase 1 싱글(vs AI 감독) PoC → Phase 2 실시간 PvP. PoC부터 PvP-ready 경계 유지.
- **매치엔진**: Tier B 축소 공간 에이전트(선수가 좌표를 갖고 1초 틱마다 판단). 위치·침투·오버랩 지시가 실제 움직임으로. Tier C(0.25초 물리)는 Backlog.
- **렌더링**: 2D 실좌표 재생 PoC (PixiJS), 3D는 Backlog.
- **플랫폼**: 웹(폰+데스크탑) → Capacitor 앱 래핑.

## 다음 단계
구현 이전 단계 완료(조사→PRD). 구현은 별도 에픽.
