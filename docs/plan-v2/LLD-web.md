# LLD — web (apps/web React SPA)

> 에픽: web · owned-glob `apps/web/**`. 서버 계약 = `docs/plan-v2/api/openapi.yaml`(SoT — 임의 확장 금지).
> 매치 재생은 **QA 뷰어 소비**(R1 이슈) — 자체 경기 렌더러 재발명 금지(#57 원칙, 실패 사례 있음).

## 1. 스택·구조

- React 18 + TypeScript + Vite + react-router v6 + TanStack Query(서버 상태) — 전역 상태 라이브러리 없이 Query+Context(토큰)로 충분. 스타일: CSS modules(디자인 시스템 없음, 모바일 우선 반응형 — 폰 세로 기준, 데스크탑은 max-width 컨테이너).
- `openapi.yaml` → `openapi-typescript`로 타입 생성(`src/api/schema.d.ts`, 생성물 커밋). fetch 래퍼 1개(`src/api/client.ts` — Bearer 주입, ApiError 규약 파싱).
- dev proxy: vite `/api → localhost:8080`. 빌드 산출물은 PoC에선 vite dev로만 서빙(배포 비범위).

```
apps/web/src/
  api/ client.ts schema.d.ts hooks.ts(Query 훅: useMe useDeck useMatch...)
  auth/ LoginPage.tsx TokenContext.tsx
  lobby/ LobbyPage.tsx(모드선택 모달 — 멀티='준비중' 뱃지)
  deck/ DeckPage.tsx SlotGrid.tsx PlayerPicker.tsx PromptEditor.tsx PresetPanel.tsx
  shop/ ShopPage.tsx GachaReveal.tsx(11장 카드 공개 연출 — CSS로 충분)
  codex/ CodexPage.tsx PlayerCard.tsx(등급 색상: 브론즈/실버/골드/다이아/레전드)
  match/ MatchPage.tsx(상태 라우팅) BriefingPanel.tsx(상대분석+프롬프트+타이머 표시)
         GenWaitPanel.tsx(단계 문구+스피너) HalftimePanel.tsx(교체+추가 프롬프트)
         MatchViewer.tsx(§3) ResultPage.tsx(스코어·스탯·보상)
  common/ Layout.tsx PointsBadge.tsx ErrorToast.tsx
```

## 2. 화면별 스펙 (AC는 PRD §3.7)

- **/login**: 닉네임 입력 → 로그인 → 토큰 localStorage. isNew면 "스타터 팩 지급" 안내 모달.
- **/lobby**: 포인트·전적 헤더 + 4버튼(게임 시작/덱/상점/도감). 게임 시작 → 모드 선택(싱글 활성, 멀티 disabled '준비중') → `POST /api/matches` → `/match/:id`.
- **/deck**: 포메이션 슬롯 그리드(선발 11) + 벤치 줄(≤7) + 보유 풀 리스트(포지션 필터). 선수 탭 → 슬롯 배치. 선수 카드 클릭 → PromptEditor(사전 프롬프트, 500자 카운터, 프리셋 드롭다운 적용=본문 복사). PresetPanel: 프리셋 CRUD + **다중 선수 선택 → 일괄 적용**(AC-W2). 저장 = `PUT /api/deck` 전체 교체, 서버 400 detail을 슬롯별 인라인 표시.
- **/shop**: 단뽑/10연뽑 버튼(비용 표시, 잔액 부족 disabled+안내). 결과 GachaReveal: 카드 뒤집기 순차 공개, 골드↑ 하이라이트, isNew 뱃지.
- **/codex**: 110명 그리드(등급·포지션 필터), 미보유는 흑백 처리 + 보유 수.
- **/match/:id**: `useMatch` 3s 폴링(GEN* 상태에서만). state별 패널:
  - BRIEFING: 상대 분석(덱 11명 테이블+성향 문구) / 팀 프롬프트 textarea / 선수별 프롬프트(덱 사전값 프리필, 수정 가능) / 타이머 카운트다운 **표시**(만료돼도 진행 가능, D5) / [킥오프].
  - GEN1·GEN2: "AI 감독이 작전 반영 중…" + 경과 시간(라이브 모드 ~70s×2 안내). FAILED면 사유+[재시도].
  - H1_BREAK: 전반 스코어 + MatchViewer(half1) + HalftimePanel(교체: 선발↔벤치 선택 스왑 ≤3, 초과 시 비활성 / 추가 프롬프트) + [후반 시작].
  - FINISHED: MatchViewer(half2) → ResultPage(최종 스코어, 팀 비교 스탯, 선수 스탯 테이블, 보상 +N pt, 전적 갱신) → [로비로].

## 3. MatchViewer — 뷰어 소비 계약 (R1 의존)

- **목표(R1 이후)**: QA가 발행한 뷰어 번들(`viewer-standalone.html` 계열)을 iframe으로 임베드, `postMessage({type:'loadMatchLog', matchLog})` 주입 → 재생. 구체 인터페이스는 R1 이슈에서 QA가 확정(우리는 소비만).
- **R1 전 임시(W2)**: MatchLog로 스코어보드 + 이벤트 타임라인(분:초, 골/슛/카드 아이콘) + 텍스트 하이라이트만 표시. **캔버스 재생 자체 구현 금지.**
- MatchLog 취득: `GET /api/matches/:id/halves/:n/log` (수 MB 가능 — Query 캐시, staleTime ∞).

## 4. 웨이브

- **W0**: 스캐폴드+타입생성+로그인+로비(+모드 모달) — mock 서버 없이 실제 server-java W1에 붙는다(순서: server-java W0의 openapi.yaml만 있으면 병렬 착수, 통합은 W1 이후).
- **W1**: 덱·상점·도감 (AC-W2·W3).
- **W2**: 매치플로우 UI + 임시 MatchViewer + 결과 (AC-W1·W4 — stub AI로 Playwright E2E).
- **W3**: 뷰어 통합 (R1 완료 의존, AC-W5).

## 5. 테스트

- Playwright E2E가 주력(AC-W1 풀 시나리오 — server-java+ts-servants(stub) 실행 후). `apps/web/e2e/`. 단위 테스트는 검증 로직(덱 규칙 프리체크)만 vitest.
- 시각 판정(연출·레이아웃)은 §2 규칙대로 **독립 QA 서브에이전트**로 — 자기검수 금지.
