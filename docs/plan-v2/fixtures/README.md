# 엔진러너 fixture (server-java WireMock 재생용)

`matchlog-h1.json` / `matchlog-h2.json` = 엔진러너 `POST /simulate` 의 **{request, response} 쌍**.
server-java 에픽의 WireMock 테스트가 양쪽(요청 스텁 매칭 + 응답 재생)을 그대로 사용한다
(LLD-ts-servants §4, LLD-server-java §8).

## ⚠️ SHORT-MATCH 샘플 — 게임플레이 비현실적

git 에 영구 커밋되는 파일을 가볍게 유지하기 위해 **단축 EngineConfig**(`matchMinutes: 4` →
하프당 120틱, version 태그 `engine@0.9.0-fixture-short`)로 생성했다. 스키마·계약 형태 검증용
(shape-valid)이지 실경기 밸런스/스탯 증빙이 아니다 — 그 용도는 `tools/qa-match.mjs` ·
`tools/perceptibility.mjs`. **러너 운영 경로는 항상 defaultEngineConfig(90분)를 쓴다** —
단축 config 는 생성 스크립트에서만 주입된다.

같은 이유로, h2 request 의 `resumeState`(configVersion=`…-fixture-short`)를 **실행 중인 실제
러너에 보내면 버전 가드가 400 으로 거부**한다(의도된 오용 방지). WireMock 재생(러너 미개입)
에는 영향 없다.

## 내용 보장

- `request`/`response` 모두 `@hmb/shared` 의 zod `SimulateRequest`/`SimulateResponse` 파싱 통과.
- h1: `half:1` → 전반 MatchLog + `resumeState` + `lastHash`.
- h2: `half:2` + **h1 응답의 resumeState 그대로** → 후반 MatchLog + `lastHash` (resumeState 없음 = 매치 종료).
- 데이터 실물: `data/players/bots.v1.json` 의 BOT_ATK(홈) vs BOT_DEF(어웨이) 덱 + `players.v1.json`
  능력치, 고정 시드 `990011223344`. 결정론 — 재생성해도 바이트 동일.

## 재생성

```bash
npx tsx packages/server/scripts/generate-runner-fixtures.ts
# 또는: npm run fixtures:runner --workspace=@hmb/server
```
