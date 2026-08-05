# HMB 온라인

> **선수 한 명 한 명에게 자연어로 지시하는 축구 시뮬레이션.**
> 감독이 쓴 문장을 AI가 전술 파라미터로 바꾸고, 그 파라미터를 **결정론 매치 엔진**이 90분으로 돌린다.

축구 매니지먼트 게임(FM 계열)의 틀에 **선수별 자연어 프롬프트**를 얹은 것이 이 게임의 차별점이다.
"오늘은 뒷공간을 노려라", "저 10번을 전담 마크해" 같은 문장이 그 선수의 행동 파라미터가 되고,
경기는 그 입력만으로 **몇 번을 돌려도 똑같이 재생된다**(재현 계약 = 시드 + 로스터 + 전술 인풋 + 엔진 버전).

---

## 1. 바로 해보기 (두 줄)

```bash
npm install
npm run play        # → http://localhost:5180
```

**백엔드도 DB도 서버도 없다.** 목데이터(선수 182명·봇 팀 3종)가 리포에 같이 있고,
**매치 엔진이 브라우저 안에서 직접 돈다.** 설치·설정·로그인·계정 아무것도 필요 없다.

게스트로 시작 → 스타터 팩 지급 → 덱 구성 → 연습 경기 → 전반 → 감독시간(교체·후반 지시) → 후반 → 결과.
경기 도중 `⏩ 스킵`으로 하프를 건너뛸 수 있어 한 판을 1~2분에 끝까지 볼 수 있다.

**AI 는 이 모드에서 동작하지 않는다.** 프롬프트를 실제 AI 전술로 반영하려면 `npm run play:ai`(§2)가
필요하고, 그때도 화면 하단 배너로 현재 어느 경로인지 알려 준 뒤 **결정론 폴백**으로 경기를
진행한다(플레이는 어느 경우에도 막지 않는다).

> **호스팅된 링크는 제공하지 않는다.** 이 리포는 비공개이고, 공개 호스팅(GitHub Pages 등)은
> 곧 소스·에셋 공개를 뜻하므로 별도 결정 사항으로 분리했다. 심사·시연은 위 두 줄로 충분하다 —
> 정적 산출물이 필요하면 `npm run build:static` 이 어느 정적 호스팅에도 올릴 수 있는
> `apps/web/dist` 를 만든다(§5).

---

## 2. 로컬에서 실행

```bash
git clone https://github.com/dd0114/hmb-online.git
cd hmb-online
npm install

npm run play        # 백엔드 없이 바로 플레이 (http://localhost:5180)
npm run play:ai     # + Claude Code 로 프롬프트 → AI 전술 인풋 생성
```

### `npm run play` — 서버 0

§1 과 같은 것이다(**스태틱 모드**: 목데이터 + 브라우저 내 엔진).
`npm run build:static` 이 굽는 산출물과도 **같은 코드 경로**다.

### `npm run play:ai` — 프롬프트가 진짜 AI를 탄다

로컬 AI 브리지(`apps/web/scripts/ai-bridge.ts`)를 같이 띄운다. 브리지는 **Claude Code CLI**를
서브프로세스로 불러 프롬프트를 전술 인풋(`TacticalInput`)으로 바꾼다.

| 상태 | 동작 | 화면 안내 |
|---|---|---|
| `claude` 설치 + **로그인 됨** | 프롬프트 → AI 전술 인풋 | 「Claude Code 에 연결됐습니다」 |
| `claude` 는 있는데 **로그인 안 됨** | **스태틱 엔진 계산으로 폴백** | 「Claude Code 로그인이 확인되지 않아 스태틱 엔진 계산으로 진행합니다」 |
| `claude` 없음 / 브리지 없음 (= `npm run play`) | 스태틱 엔진 계산 | 「데모 빌드입니다 — 서버 없이 …」 |

**어느 경우에도 경기는 끝까지 진행된다.** 로그인은 게이트가 아니라 **품질 축**이다 —
AI 가 없으면 지시 문장이 키워드 규칙으로 해석되고, 있으면 문맥까지 읽는다.

Claude Code 로그인:

```bash
npm i -g @anthropic-ai/claude-code   # 없으면 설치
claude                               # 최초 1회 로그인
```

### 전체 스택(서버 포함)으로 돌리기

실제 운영 구성은 Java(Spring) 권위 서버 + TS 서번트 2개(엔진 러너 · AI 실행기) + React SPA 다.
그 구성의 기동 절차는 [`docs/plan-v4/deploy-playbook.md`](docs/plan-v4/deploy-playbook.md) 에 있다.
**제출용 플레이에는 필요 없다** — 위 두 커맨드로 충분하다.

---

## 3. 어떻게 만들어졌나

```
프롬프트 ──▶ AI(Claude) ──▶ TacticalInput ──▶ 결정론 엔진 ──▶ MatchLog ──▶ 2D 재생
 (자연어)      경기 전·                (JSON 계약)      (1초 틱,        (틱 스냅샷    (Canvas)
               하프타임 2회만                            고정소수)        + 이벤트)
```

**AI 는 인풋만 만들고 시뮬레이션에는 개입하지 않는다.** 이게 설계의 중심 결정이다 —
그래야 같은 입력이 항상 같은 경기가 되고(재현·검증·PvP 가능), AI 호출 비용이 경기 길이와 무관해진다.

| 패키지 | 역할 |
|---|---|
| [`packages/engine`](packages/engine) | 결정론 매치 엔진. 22명이 1초 틱마다 인지→판단→실행→경합. `Math.random`·`Date.now` 금지, 고정소수 좌표, 시드 RNG 관통 |
| [`packages/shared`](packages/shared) | 직렬화 계약(zod) — `TacticalInput` · `SelectData` · `MatchLog` |
| [`packages/viewer-core`](packages/viewer-core) | 경기 재생·투영 코어(2D 캔버스) |
| [`packages/server`](packages/server) | TS 서번트 — 엔진 러너 RPC · AI 실행기(Claude CLI) |
| [`server-java`](server-java) | 권위 서버(게임 흐름·상태·잡 큐·정산) |
| [`apps/web`](apps/web) | React SPA. [`src/static/`](apps/web/src/static) = **백엔드 없이 도는 데모 모드** |
| [`data`](data) | 선수·봇·경제 시드 발행물 |

### 데모 모드(`apps/web/src/static/`)가 하는 일

화면 코드는 **한 줄도 바뀌지 않았다.** `apiFetch` 한 곳에서 네트워크 대신 브라우저 안의 목 백엔드로
분기한다 — 경기 상태머신도, 서버 권위 시계 계약도 실서버와 같은 모양이라 뷰어·흐름·라이브 게이트가
그대로 돈다. 엔진은 `runFirstHalf`/`resumeSecondHalf` 를 직접 부르고(하프당 0.2~0.6초),
새로고침하면 저장해 둔 **입력으로 다시 시뮬레이션해서** 복구한다(결정론이라 같은 경기가 나온다).

---

## 4. 문서

- [`docs/PRD.md`](docs/PRD.md) — 제품 요구
- [`docs/plan-v2/`](docs/plan-v2) · [`plan-v3/`](docs/plan-v3) · [`plan-v4/`](docs/plan-v4) · [`plan-v5/`](docs/plan-v5) — 단계별 설계 SoT
- [`research/`](research) — [매치엔진](research/match-engine.md) · [전술/지시](research/tactics-instructions.md) · [렌더링](research/rendering.md) · [축구 통계](research/football-stats.md)
- [`CLAUDE.md`](CLAUDE.md) — 작업 규율 + 엔진 버전 이력(무엇을 왜 바꿨는가)

## 5. 개발 커맨드

```bash
npm test              # 엔진 결정론·계약 + shared + web 유닛
npm run typecheck
npm run build:static  # 데모 빌드 → apps/web/dist (백엔드 0, 어느 정적 호스팅에도 그대로 올라간다)
```

`build:static` 산출물은 `npm run play` 와 **같은 코드 경로**다. 서브패스로 서빙할 경우
`HMB_BASE_PATH=/하위경로/ npm run build:static` 으로 굽고, 로컬 확인은
`cd apps/web && npx vite preview` 로 한다(딥링크용 `404.html` 도 같이 생성된다).
