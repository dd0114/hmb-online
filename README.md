# HMB 온라인

> AI 프롬프트 기반 축구 시뮬레이션 게임. FM 틀 + 선수 개개인에게 자연어 AI 프롬프트 주입.

---

## 로컬 빌드 — 내 머신에서 게임하기

클론 → 전제 확인 → 한 줄 → 브라우저. 세 프로세스(권위 서버·엔진 러너·AI 실행기)와 웹을
`scripts/local-stack.sh` 하나가 띄운다.

```bash
git clone https://github.com/dd0114/hmb-online.git
cd hmb-online
npm ci

bash scripts/local-stack.sh doctor   # 전제만 점검하고 끝
bash scripts/local-stack.sh up       # 스택 기동 → http://localhost:31173
```

`up` 이 뜨면 브라우저에서 **http://localhost:31173** 을 연다. `Ctrl-C` 로 전부 정리된다.

### 전제

| 전제 | 버전 | 기계 SoT |
|---|---|---|
| Node.js | `20.19.6` | [`.nvmrc`](.nvmrc) |
| JDK | `21` | [`server-java/build.gradle.kts`](server-java/build.gradle.kts) |

JDK 는 설치만 돼 있으면 된다 — 스크립트가 `/usr/libexec/java_home -v 21` 로 찾아 쓰므로
`JAVA_HOME` 을 21 로 맞춰 둘 필요는 없다. 전부 갖췄는지는 `doctor` 가 답한다.

> **이 표의 숫자는 손으로 관리하지 않는다.** `tools/readme-parity.test.ts` 가 매 커밋마다
> 이 표·경로·서브커맨드·포트를 위 기계 SoT 와 대조해 어긋나면 red 를 낸다.

### 서브커맨드

| 명령 | 하는 일 |
|---|---|
| `bash scripts/local-stack.sh doctor` | 전제(Node·JDK·claude CLI)와 포트만 점검하고 종료 |
| `bash scripts/local-stack.sh smoke` | 스택 기동 → 가입·덱·경기 완주를 자동 판정 → 정리 (웹 없음) |
| `bash scripts/local-stack.sh up` | 스택 + 웹 개발서버 기동, 브라우저 접속 대기 |
| `bash scripts/local-stack.sh e2e` | 스택 기동 → **실서버** 브라우저 E2E 3스펙 → 정리 (목킹 0) |

`e2e` 는 이 스택을 상시 회귀 테스트로 쓰는 자리다(목킹이 아니라 **실제 서버**를 때린다).
판정은 통과 여부만이 아니라 **스킵 0** 이다 — 이 스펙들은 서버가 없으면 스스로 건너뛰므로,
스킵을 세지 않으면 "아무것도 안 돌았다"가 green 으로 보인다.

### AI 모드 — 클로드에 로그인돼 있으면 라이브

AI 실행기는 호스트의 `claude` CLI 를 **구독 세션 그대로** 쓴다.

- **로그인 O** → 프롬프트가 실제로 전술 파라미터를 만든다(라이브).
- **로그인 X / CLI 없음** → 기동 프리플라이트가 **스텁 엔진으로 자동 강등**한다. 게임은 그대로
  끝까지 돌아가고, 웹이 시작 화면에서 "지금은 스텁 AI" 를 안내한다.

⚠️ `ANTHROPIC_API_KEY` 를 **넣지 마라.** 있으면 정액제 구독이 아니라 종량 과금으로 새고,
실행기는 기동 시 이 변수를 강제로 지운다.

### 포트를 바꾸고 싶으면

기본값은 `31080`(서버) · `31790`(러너) · `31173`(웹)이고 전부 env 로 덮어쓴다. 데모(`8080`/`8790`)와
배포(`18080`/`18790`) 포트는 **건드리지 않는다** — 같은 머신에서 돌고 있을 수 있다.

```bash
HMB_LOCAL_JAVA_PORT=32080 HMB_LOCAL_WEB_PORT=32173 bash scripts/local-stack.sh up
```

| env | 기본 | 뜻 |
|---|---|---|
| `HMB_LOCAL_JAVA_PORT` | 31080 | 권위 서버 |
| `HMB_LOCAL_RUNNER_PORT` | 31790 | 엔진 러너 |
| `HMB_LOCAL_WEB_PORT` | 31173 | 웹(vite) |
| `HMB_LOCAL_E2E_WEB_PORT` | 31199 | `e2e` 가 띄우는 vite(플레이 중에도 돌릴 수 있게 분리) |
| `HMB_LOCAL_AI` | `up`=claude-code / `smoke`=stub | AI 실행기 모드 희망값(강등은 프리플라이트가 판단) |
| `HMB_LOCAL_STATE_DIR` | 임시 디렉토리 | DB·로그 위치. 지정하면 재시작해도 진행이 남는다 |

---

## 테스트

```bash
npm test        # 엔진 결정론·계약·리얼리즘 (기본 티어 T1)
npm run e2e     # 뷰어 이벤트↔연출 E2E (Playwright)
```

엔진 QA 규율(기계검증 → E2E-TDD → 실화면 캡처 → 결정론 가드 → 독립 QA)은
[`CLAUDE.md`](CLAUDE.md) §2.5 가 SoT 다.

---

## 산출물
- 📄 **[docs/PRD.md](docs/PRD.md)** — 기능 관점 PRD (v1)
- 🔬 조사: [매치엔진](research/match-engine.md) · [전술/지시](research/tactics-instructions.md) · [렌더링](research/rendering.md) · [라이브개입 UX](research/live-intervention-ux.md) · [합성노트](research/_synthesis.md)

## 핵심 결정
- **AI 아키텍처**: 방식1(프롬프트→AI가 시뮬 인풋 사전생성→서버 결정론 시뮬). AI 개입은 경기전 + 하프타임 2곳.
- **로드맵**: Phase 1 싱글(vs AI 감독) PoC → Phase 2 실시간 PvP. PoC부터 PvP-ready 경계 유지.
- **매치엔진**: Tier B 축소 공간 에이전트(선수가 좌표를 갖고 1초 틱마다 판단). 위치·침투·오버랩 지시가 실제 움직임으로. Tier C(0.25초 물리)는 Backlog.
- **렌더링**: 2D 실좌표 재생 PoC (PixiJS), 3D는 Backlog.
- **플랫폼**: 웹(폰+데스크탑) → Capacitor 앱 래핑.
