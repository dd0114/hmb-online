# PRD v2 — HMB 온라인 전체 게임 시스템 (A-to-Z PoC)

> **목적**: 엔진+렌더링(QA 도메인, 완성도 트랙 진행 중)을 제외한 **나머지 게임 시스템 전부**를
> 최소 스펙으로 — 목업일지언정 — **끝까지 동작하게** 만든다. 이후 모듈별 별도 세션에서 QA·심화.
> **이 문서가 요구사항의 SoT**다. 구현 상세는 `ERD.md` + `LLD-*.md` 참조. 상태 추적은 epic-flow(GitHub 이슈).

- 작성: 2026-07-18, hero 확정 사항 반영(스택·저장소·AI실행·선수풀·타이머·경제·에픽구조)
- 관련: 기존 `docs/PRD.md`(v1.1, 컨셉·엔진)는 유효. 본 문서는 **게임 시스템 레이어**를 추가 정의.

---

## 0. 확정 결정 (hero 승인, 2026-07-18)

| # | 결정 | 내용 |
|---|---|---|
| D1 | 서버 스택 | **Java Spring 지금 도입** (ADR-1 실행). Java 21 + Spring Boot 3.x + Gradle + SQLite(JDBC+Flyway) |
| D2 | 저장소 | **SQLite** 단일 파일. ERD 그대로 반영, 추후 Postgres 전환 가능 구조 |
| D3 | AI 실행 | **라이브(claude CLI 구독)+stub 토글**. 상대팀(봇)도 AI 생성(프리셋 지시문, promptHash 캐시로 절감) |
| D4 | 선수 풀 | **100명+ · 5등급**. ~~가상 이름~~ → **v2(#84): 실선수 전량 교체**(유럽 빅클럽 현역+역대 레전드 150명, 고유 ID `P###`). 등급 매핑=`grade-mapping-v2.md`. ⚠️ **상용화 전 실명/초상권 라이선스 해결 필수**(백로그, §7 비범위 정합) |
| D5 | 입력 타이머 | **표시만, 강제 안 함** (config 플래그로 강제 전환 가능하게) |
| D6 | 경제 수치 | 초기 3,000 / 단뽑 300 / 10연뽑 3,000에 11개 / 승 +500 · 무 +200 · 패 +100 — **전부 config** |
| D7 | 에픽 구조 | **모듈별 에픽** = 세션 = owned-glob 1:1 + 상위 트래킹 이슈 |
| D8 | 로그인 | 목업(닉네임 로그인). 실연동(OAuth) 교체를 염두한 인터페이스 |
| D9 | 하프타임 교체 | 최대 3명(config). 엔진 resume 로스터 교체는 QA 도메인 요청 이슈 — 지원 전 fallback은 LLD-server-java §5.4 |
| D10 | 멀티모드 | 선택 화면에 노출하되 "준비중"만. 개발 안 함 |

## 0.5 운영 모델 (도메인 분할 — 반드시 준수)

- 모듈 = 에픽 = 세션 = owned-glob. 각 모듈은 **독립 개발·버전업**하고, 소비 측은 **발행된 버전/계약만** 가져다 쓴다.
- **경계 넘어 재발명 금지.** 다른 도메인 산출물이 소비 불가면 → 왜인지 분석해 **이슈 레이즈** (memory: domain-split 원칙, 이슈 #57).
- 엔진(`packages/engine/**`)·뷰어(`dev-viewer/**`)는 **QA 도메인(에픽 #25) 소유** — 본 계획에서는 소비만 한다.
- 계약 프리즈 대상: `packages/shared/**`(TS 내부 계약) + `docs/plan-v2/api/openapi.yaml`(Java↔웹/서번트 계약). 변경은 관련 에픽 간 조율 후.

---

## 1. 모듈 맵

```
apps/web          [에픽 web]         React+Vite SPA — 로그인→로비→덱→매치→상점→도감
server-java       [에픽 server-java] Spring Boot 권위 서버 — auth·메타·상점·매치플로우·AI잡큐 (게임 상태의 SoT)
packages/server   [에픽 ts-servants] TS 서번트 2개 — ①엔진러너 RPC ②AI실행기(Java 폴링, claude CLI)
data/players      [에픽 data]        선수 110명 시드 + 등급·확률·경제 config 의 데이터 SoT
packages/engine   [QA 도메인 #25]    소비만 (simulate/resume)
dev-viewer        [QA 도메인 #25]    소비만 (MatchLog 재생) — 소비 계약 요청 이슈 R1
packages/shared   [계약 — 프리즈]    zod 계약 (PlayerCard·TacticalInput·MatchLog)
```

의존 방향: `web → server-java → (ts-servants → engine)`, 데이터는 `data → server-java`. 웹은 Java API만 안다.

---

## 2. 유저 여정 (해피 패스)

1. **로그인**(닉네임) → 신규면 스타터 팩(선수 14명+포인트 3,000) 지급 → **로비**
2. 로비: [게임 시작] [덱 구성] [상점] [도감] + 내 포인트·전적 표시
3. **덱 구성**: 보유 풀에서 선발 11 + 교체(≤7) 선택, 포메이션, 선수별 사전 프롬프트, 프리셋 저장/일괄 적용
4. **게임 시작** → 싱글/멀티 선택(멀티=준비중) → 싱글: 봇 매칭 → **상대 분석 공개**(상대 덱·성향)
5. **경기 전 브리핑**: 팀 전체 프롬프트 + 선수별 프롬프트 입력(사전 프롬프트가 기본값, 타이머 표시) → [킥오프]
6. AI가 양팀 인풋 생성 → **전반 시뮬** → 전반 재생(뷰어) + 스코어/스탯
7. **하프타임**: 추가 프롬프트 + 선수 교체(≤3) → [후반 시작] → 현재 상태+프롬프트 반영 인풋 재생성 → **후반 시뮬** → 재생
8. **결과 화면**: 스코어·팀/선수 스탯·리포트, 승패 전적 기록 + 포인트 보상 → 로비 복귀
9. **상점**: 단뽑/10연뽑(11개, 골드↑ 1개 보장) → 보유 풀에 추가
10. **도감**: 전체 110명 카탈로그(등급·능력치) + 보유 여부 표시

---

## 3. 모듈별 요구사항 + AC

### 3.1 [data] 선수 데이터·경제 시드

- R: 선수 풀, 5등급(BRONZE/SILVER/GOLD/DIA/LEGEND), 등급→능력치 밴드, 고유 ID(`P001`~). 시드 고정 생성 스크립트로 재생성 결정론.
  - **v1(이력)**: 가상 이름 110명(GK12/DF36/MF36/FW26), 실선수 금지.
  - **v2(#84, 현행)**: **실선수 150명**(GK19/DF47/MF48/FW36) 전량 교체 — 큐레이션 로스터(`data/players/roster.ts`)로 등급 매핑, 능력치 9종만 시드 RNG로 밴드 내 파생. 등급 기준=`grade-mapping-v2.md`. ⚠️ **상용화 전 실명 라이선스 해결 필수**(백로그, §7).
- R: 뽑기 확률표·경제 수치·스타터 팩 구성의 데이터 SoT(현행 `data/players/economy.v2.json`).
- **AC-D1**: `players.<ver>.json`에 명세 인원(v1=110 / **v2=150**), 포지션·등급 분포가 명세(LLD-data / grade-mapping-v2.md)와 일치, ID 유일, 능력치가 등급 밴드 내.
- **AC-D2**: 생성 스크립트 2회 실행 결과 바이트 동일(시드 고정).
- **AC-D3**: 검증 테스트(vitest)가 스키마(zod PlayerCard 확장)·분포·밴드를 기계 검증.
- **AC-D4**: 파일 버전으로 발행 — 소비자(server-java)는 버전 파일만 읽는다. 교체 시 새 버전 발행(현행 **v2**).

### 3.2 [server-java] 권위 서버 — auth·메타

- R: 닉네임 로그인(목업) → 세션 토큰. `AuthProvider` 인터페이스 뒤에 Mock 구현(추후 OAuth 구현체 추가 지점 주석).
- R: 신규 유저 스타터 팩: 포지션 커버 가능한 고정 14명(GK1/DF5/MF5/FW3, 브론즈~실버) + 3,000pt.
- R: 덱: 유저당 활성 덱 1개 — 포메이션, 선발 11(포지션 슬롯 매핑), 벤치 ≤7, 선수별 사전 프롬프트(≤500자).
- R: 프리셋: 유저별 프롬프트 프리셋 CRUD(이름+본문), 덱 화면에서 선수(들)에 일괄 적용은 웹이 수행(서버는 저장만).
- R: 도감: 전체 카탈로그 + 보유 플래그. 지갑/원장: 포인트 잔액 + 변동 사유 원장.
- **AC-S1**: `POST /api/auth/login {nickname}` 신규→유저 생성+스타터 팩(원장 기록), 기존→로그인. 토큰으로 `GET /api/me` 인증.
- **AC-S2**: `PUT /api/deck` — 보유하지 않은 선수/11명 미만/중복 선수/GK 0명이면 400과 사유. 유효 덱 저장·재조회 일치.
- **AC-S3**: `GET /api/players` — 110명 전원 + `owned` 플래그 정확(도감 데이터).
- **AC-S4**: 프리셋 CRUD 왕복. 삭제해도 이미 덱에 들어간 프롬프트 본문은 유지(복사 저장).
- **AC-S5**: 모든 경제 수치가 config(application.yml)에서만 온다 — 코드 하드코딩 grep 0.

### 3.3 [server-java] 상점·뽑기

- R: 단뽑 300pt/1명, 10연뽑 3,000pt/11명(골드 이상 최소 1 보장). 확률표는 `economy.v1.json`. 중복 획득 허용(PoC: 중복은 그냥 보유 수량 증가 대신 **중복 표시만** — 능력엔 영향 없음).
- **AC-S6**: 잔액 부족 시 402/400 + 사유, 원장 무변동(트랜잭션).
- **AC-S7**: 10연뽑 결과 11명, 골드↑ ≥1. 시드 고정 테스트로 확률표 로딩 검증(통계 검정은 QA 단계).
- **AC-S8**: 뽑기 결과가 보유 풀·원장에 반영되고 `GET /api/me` 잔액 일치.

### 3.4 [server-java] 매치플로우 상태머신 (핵심)

- R: 상태: `BRIEFING → GEN1 → H1_BREAK → GEN2 → FINISHED` (+`FAILED`, 재시도 액션). 상세 = LLD-server-java §5.
- R: 싱글 매칭: 봇(bots 시드 3종: 공격형/수비형/밸런스) 중 선택 또는 랜덤. 상대 분석 = 봇 덱 11명(이름·포지션·등급) + 성향 요약 문구.
- R: 브리핑: 팀 프롬프트 + 선수별 프롬프트(덱의 사전 프롬프트가 기본값). 타이머는 표시용(강제 off, config).
- R: 킥오프 → 양팀 AI 잡 생성(내 팀=유저 프롬프트, 봇=페르소나 지시문) → 완료 시 엔진러너 RPC로 전반 시뮬 → MatchLog(전반) 저장.
- R: 하프타임: 추가 프롬프트 + 교체 ≤3(벤치에서만) → 후반 인풋 재생성(전반 요약 컨텍스트 포함) → 후반 시뮬 → 최종 스코어.
- R: 종료 시 전적 기록 + 보상 지급(승500/무200/패100) — 멱등(중복 지급 금지).
- R: 재현 번들: half별 `(seed, selectData, homeInput, awayInput, engineVersion)` 저장 → 언제든 동일 MatchLog 재생성.
- **AC-M1**: 상태 전이가 명세 외 액션을 409로 거부(예: GEN1 중 halftime 호출).
- **AC-M2**: stub 실행기로 전 과정 E2E(로그인→덱→매치→결과) 통과 — AI·네트워크 0 의존.
- **AC-M3**: `GET /halves/{n}/log` 가 zod `MatchLog` 스키마 유효(ts-servants 계약 테스트로 검증).
- **AC-M4**: 교체 규칙 위반(3명 초과·벤치 외 선수·GK 퇴장 후 GK 0) 400.
- **AC-M5**: 동일 매치 재현: 저장 번들로 half 재시뮬 → 지문(final hash·스코어) 동일.
- **AC-M6**: FINISHED 시 전적·보상 정확히 1회 반영(결과 API 재호출에도 멱등).
- **AC-M7**: AI 잡 실패/타임아웃 → `FAILED` + 재시도 액션으로 복구 가능.

### 3.5 [server-java] AI 잡 큐 (ADR-1: Java가 큐 소유)

- R: SQLite 테이블 큐(`ai_jobs`) — 서번트가 long-poll로 가져가고 결과 POST. promptHash 멱등(동일 요청 재사용). usage(토큰·캐시·비용) 기록.
- **AC-Q1**: 잡 lease(가시성 타임아웃) — 워커 죽으면 잡이 재배포된다.
- **AC-Q2**: 동일 promptHash 재요청은 기존 결과 재사용(L1 캐시 — 기존 packages/server W3 의미론 승계).
- **AC-Q3**: `/internal/*`는 서번트 토큰 인증(고정 shared secret, config).

### 3.6 [ts-servants] 엔진러너 + AI실행기

- R: 엔진러너: 무상태 HTTP RPC `POST /simulate`(half 1/2, resume 포함) — 엔진 재작성 금지, `@hmb/engine` 소스 의존(현행 소비 방식, #57 결론 나오면 갱신).
- R: AI실행기: Java `/internal/ai-jobs` 폴링 → 기존 executor 추상화(claude CLI 라이브/stub, resilience/metrics 재사용) → 결과 POST. 파일 큐(W1)는 퇴역.
- **AC-T1**: `/simulate` 왕복이 zod 계약(`SimulateRequest/Response`, shared에 추가) 파싱 통과. 같은 요청 2회 → 동일 MatchLog(결정론).
- **AC-T2**: stub 토글(`AI_EXECUTOR=stub|claude-code`)로 Java 큐 E2E가 오프라인 통과.
- **AC-T3**: 라이브 스모크 1회(구독 CLI): 팀 프롬프트가 TacticalInput 파라미터에 방향대로 반영(기존 compare 프로브 재사용).
- **AC-T4**: 기존 vitest 스위트(metrics/resilience/replay 등) 재편 후에도 전부 green.

### 3.7 [web] React SPA

- R: 화면: `/login /lobby /deck /shop /codex /match/:id`(브리핑→전반재생→하프타임→후반재생→결과). 모바일 우선 반응형.
- R: 매치 재생 = **QA 뷰어 소비**(요청 이슈 R1: MatchLog 주입 가능한 standalone 번들). R1 전 임시: 스코어·이벤트 타임라인·스탯 텍스트 표시(자체 캔버스 렌더 재발명 금지 — #57 원칙).
- R: 멀티 선택 시 "준비중" 표시.
- **AC-W1**: 신규 닉네임으로 로그인→로비→덱 저장→매치 완주→결과→전적 반영이 브라우저에서 끝까지 동작(stub AI, Playwright E2E).
- **AC-W2**: 덱 화면 — 프리셋 만들기→선수 다중 선택→일괄 적용 동작. 유효성 오류(11명 미만 등)가 인라인 표시.
- **AC-W3**: 상점 — 10연뽑 연출(11장 카드 공개), 잔액 실시간 갱신, 부족 시 안내.
- **AC-W4**: 매치 — 상태 폴링으로 GEN1/GEN2 대기 표시(진행 스피너+단계 문구), 하프타임 교체 UI(벤치 드래그/선택), 결과 화면에 팀·선수 스탯.
- **AC-W5**: 뷰어 통합(R1 이후 웨이브): 전·후반 MatchLog가 뷰어에서 재생.

### 3.8 비범위 (명시적으로 안 함)

실 OAuth/결제·멀티(PvP) 실구현·선수 성장/훈련·리그/시즌·피로도/부상·실선수 라이선스 데이터·모바일 앱 패키징(Capacitor)·Postgres 운영 배포.

---

## 4. 에픽 분할·순서 (epic-flow)

| 에픽 | owned-glob | 웨이브 요약 |
|---|---|---|
| **data** | `data/**` | 단일 웨이브: 생성 스크립트+players.v1+economy.v1+검증 |
| **server-java** | `server-java/**` | W0 스캐폴드(Gradle·Flyway·OpenAPI) → W1 auth+메타 → W2 상점·도감 → W3 매치플로우 → W4 AI큐+러너 연동 |
| **ts-servants** | `packages/server/**` | W0 러너 RPC → W1 실행기 Java폴링 전환(파일큐 퇴역) |
| **web** | `apps/web/**` | W0 스캐폴드+로그인+로비 → W1 덱·상점·도감 → W2 매치플로우 UI → W3 뷰어 통합(R1 의존) |

- 착수 순서: **data + server-java W0**(계약 확정) 먼저 → ts-servants·web 병렬. OpenAPI(`docs/plan-v2/api/openapi.yaml`)는 server-java W0 산출물이자 web/ts-servants의 입력.
- QA 도메인 요청 이슈: **R1** 뷰어 소비 번들(MatchLog 주입 훅), **R2** 엔진 resume 로스터 교체. → 에픽 #25에 레이즈.
- 통합 게이트(트래킹 이슈에서 판정): AC-M2(stub 풀 E2E) → AC-W1(브라우저 E2E) → 라이브 AI 스모크(AC-T3) → 데모.
