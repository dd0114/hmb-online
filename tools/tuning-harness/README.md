# 무리빌드 튜닝 하네스 (#377 M0-1)

> 계수를 바꾸면 **리빌드 0회로** 그 경기 여러 판을 눈으로 본다.

```bash
npm run harness            # http://127.0.0.1:8310
npm run harness -- --port 8399
```

## 왜 있나

엔진은 이미 무상태다 — `runMatch(seed, home, away, select, config)` 이고 `config` 는 순수 데이터다.
그런데 계수를 하나 만지려면 이걸 매번 돌았다:

```
config.ts 편집 → TS 컴파일 → vitest 재기동 → 전체 로드 → 시뮬 → 텍스트 결과
```

그 왕복이 밸런스 웨이브를 시간 단위로 만든 정체다(#377 §4 — 한 웨이브 1.6~1.8시간 × 5).
하네스는 **엔진을 프로세스에 1회 로드**해 두고 config 를 HTTP 요청 본문으로 받는다.
재시뮬 → 재생까지 **4경기 기준 약 1초**.

## 화면

| | |
|---|---|
| **좌 · 입력** | 입력 소스(벤치마크 덱 / 실덱 픽스처 10종) · 경기 수 · 시드 · 재생 배속 |
| **좌 · 계수** | 주요 노브 12개(기본값 프리필, 바뀐 것만 노랗게) + 자유 오버라이드 JSON(점 경로 가능) |
| **우 · 요약표** | 경기별 home/away 지표 + 팀-경기 평균 + **직전 런 대비 델타** + ⚠️ **최악 케이스 팀 슛** |
| **우 · 타일** | 경기들이 나란히. 각 타일에 캔버스·스코어·재생·상황 핀 스트립 |
| **확대** | 큰 화면 + 스크럽 + **상황 점프 버튼**(골/PK/선방/슛/파울/카드/오프사이드/프리킥/코너) + 이벤트 목록 |

요약표의 **최악 케이스 행**이 이 도구의 요점이다 — #370 은 평균이 멀쩡한 채로 특정 덱에서만
붕괴했고, 라이브 24하프 **평균**으로 "붕괴 없음"이라 오판한 적이 있다(#374).

## 계약과 경계

- **엔진은 읽기만 한다.** 하네스는 도구다 — 골든·해시가 움직이면 그건 버그다.
- **여기서 나온 계수는 커밋하지 않는다.** 확정값 커밋은 트랙 T 소관(#377 P v3).
- **로컬 전용.** 127.0.0.1 바인드 고정, 외부 호스팅 금지.
- **결정론 불변.** 같은 (시드 + 입력 + 오버라이드) 는 항상 같은 경기다. config 는 재현 3종세트의 일부다.
- **오타는 던진다.** 없는 경로·타입이 바뀌는 값은 400 이다. 조용한 no-op 이 되면
  "노브를 돌렸는데 그대로다" 를 "그 노브는 레버가 아니다" 로 오독한다(#338 이 그 부류였다).

## 산출물

런마다 `~/hmb-harness-runs/<runId>/` 에 `match-NN.json`(MatchLog) + `run.json`(매니페스트).
`HMB_HARNESS_HOME` 로 위치 변경. **리포 밖**이라 커밋 대상이 아니고, QA 콘솔 탭(#191)이
`--log <경로>` 로 그대로 가리킬 수 있다(콘솔 allowlist 가 `$HOME` 을 허용).

```bash
node tools/qa-tab.mjs register --id 377-harness --title "..." \
  --log ~/hmb-harness-runs/run-001-1234/match-01.json@m1:"기본 config" \
  --log ~/hmb-harness-runs/run-002-1234/match-01.json@m2:"goalValue 12"
```

## API (직접 호출)

| | |
|---|---|
| `GET /api/meta` | 엔진 버전 · 노브 목록 · config 리프 경로 전량 · 입력 소스 목록 |
| `GET /api/config` | `defaultEngineConfig` 전문 |
| `POST /api/run` | `{overrides, source, count, seeds}` → 경기별 요약 + 핀 + 로그 URL |
| `GET /api/log/:runId/:idx` | 그 경기의 MatchLog |
| `GET /api/runs` | 최근 런 목록(A/B 대조용) |

```bash
curl -s -X POST http://127.0.0.1:8310/api/run -H 'content-type: application/json' \
  -d '{"source":"real:collapse-370","count":5,"overrides":{"contest.shootXgThreshold":0.07}}'
```

## 구조

```
tools/tuning-harness/server.mjs   HTTP + 엔진 1회 로드 + 측정(게이트와 같은 함수)
tools/tuning-harness/ui/          정적 UI (프레임워크·빌드 없음)
packages/engine/src/realism/config-override.ts   config 주입(점 경로·중첩·오타 검출)
packages/engine/src/realism/real-decks.ts        실덱 픽스처 로더(#374)
```

렌더는 **@hmb/viewer-core 가 소유**한다(SoT). UI 는 캔버스에 아무것도 그리지 않고 코어를
마운트만 한다 — dev-viewer 셸·게임화면과 같은 렌더러다. viewer-core 런타임(`.mjs`)은
브라우저 안전한 순수 ESM 이라 서버가 `/vendor/` 로 **빌드 없이** 그대로 서빙한다.
