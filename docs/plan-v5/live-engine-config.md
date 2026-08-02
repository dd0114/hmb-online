# 라이브 계수 무배포 변경 — W0 설계 (#383)

> SoT = 이슈 **#383** + 에픽 **#377** "계획 갱신 — 배포 우선 재편"(2026-08-02).
> 검사자 = **main**(hero 아님 — 이건 엔지니어링 방법 결정이다).
> 소유 글롭 = `packages/shared/**`(계약 additive) · `packages/server/**`(러너) · `server-java/**`(스냅샷·운영 API).
> **엔진 코드 무접촉**(`packages/engine/**` = QA #25 도메인).

---

## 0. 한 문장

hero 가 하네스에서 확정한 **엔진 계수**를 러너 이미지 재빌드 없이 반영하되, **이미 시작한 경기는
자기가 시작할 때의 계수만 본다** — 그래서 리플레이·재개가 깨지지 않는다.

## 1. 지금 사실 (코드 근거)

| 사실 | 근거 |
|---|---|
| 러너는 **컴파일된 기본값**으로만 시뮬한다 | `packages/server/src/runner/runner-main.ts:62` → `simulate(parsed.data)` — 2번째 인자 미전달 → `simulate.ts:315` 기본값 `defaultEngineConfig` |
| "비기본 config 는 픽스처 생성 전용"이 **명문 운영 계약** | `simulate.ts:310` 주석 |
| 계수 하나를 바꾸려면 = 엔진 소스 수정 → 러너 이미지 재빌드 → 컨테이너 전환 | `infra/` 배포 경로 |
| 매치는 이미 **재현 번들**을 저장한다 | `match_halves(select_data_json, home/away_input_json, half_seed, match_log_json, resume_state_json, last_hash)` (V1) |
| 그런데 **config 만 그 번들에 없다** — `matches.engine_version` 문자열 하나뿐 | V1 `matches.engine_version`, `MatchOrchestrator.java:535` |
| 재개는 **버전 문자열 동일성**만 본다 | `simulate.ts:244` `s.configVersion !== config.version` → throw → 400 → `failMatch` |
| 그래서 **#241**: 버전 범프 배포가 진행 중 매치를 FAILED 로 밀었다 | `MatchOrchestrator.java:497-501` |

**결론**: 재현 계약은 `(seed + selectData + inputLog + EngineConfig)` 인데, 지금 그 네 번째 항은
**"러너 이미지에 뭐가 구워져 있냐"** 라는 저장되지 않는 값이다. 계수를 런타임 입력으로 여는 순간
이 구멍이 곧 사고가 된다 — 그래서 이 웨이브의 절반은 주입이고 절반은 **그 구멍 메우기**다.

## 2. 설계 — 네 조각

### ① 러너: 오버레이를 런타임 입력으로 받는다 (additive)

`SimulateRequest` 에 **optional** `configOverrides` 추가. 없으면 오늘과 **bit-identical**.

```ts
// packages/shared/src/simulate.ts (additive)
export const EngineConfigOverrides = z.record(
  z.string(),                       // 점경로: "contest.shootXgThreshold"
  z.union([z.number(), z.boolean()]),
);
export const SimulateRequest = z.object({
  …기존 그대로,
  /** 계수 오버레이(#383). 없음 = 러너 기본값 = 이 필드 이전 동작. */
  configOverrides: EngineConfigOverrides.optional(),
});
```

**왜 중첩 JSON 이 아니라 평평한 점경로 맵인가** (이 설계의 핵심 선택):

1. **오타가 조용히 죽지 않는다.** 중첩 deep-merge 는 `{"contest":{"shootXgThreshhold":0.07}}` 를
   받아도 성공하고, 아무 일도 안 일어난다. 이 리포가 **세 번 빠진 함정**이 정확히 그것이다
   (#321·#337·#338 "필드가 있다 ≠ 엔진이 읽는다", #377 트랙 D blocker 5건 중 3건). 평평한
   경로는 `defaultEngineConfig` 리프 전수와 **집합 대조**가 되므로 미지 경로 = 400 이다.
2. **객체 통째 교체 사고가 원천 봉쇄**된다. deep-merge 구현체마다 "객체 vs 스칼라" 규칙이 다르고,
   실수로 `contest: {shootRange: 19}` 를 보내면 `contest` 의 나머지 40개 노브가 사라진다.
3. **정규화가 자명**하다 — 키 정렬 = 정본 직렬화 = 안정 해시. 중첩은 키 순서·`undefined`·
   프로토타입 오염까지 다뤄야 한다.
4. **감사 원장이 읽힌다** — `{"decisionWeights.shoot": 0.34}` 는 사람이 보는 그대로 diff 다.

**허용 리프 = number | boolean 뿐.** `EngineConfig` 의 비수치 리프는 **넷**이다:
`version`(string) · `coordMode`(union) · `formations`(`Record<string, Vec2[]>`) — 여기까지는 구조 —
그리고 **`chain.mode`(string)**. 마지막 것은 구조가 아니라 **결정 코어 롤백 스위치**이고, 이 엔진에서
파급이 가장 큰 레버다. 문자열이라 오버레이가 불가능하며 배포로만 바뀐다. ⚠️ 그래서 에러 메시지가
"경로가 없습니다"라고 하면 **거짓말**이다(운영자가 오타를 찾아 소스를 뒤진다) — 실재하지만 못 만지는
경로는 별도 문구로 답한다.

**무효 노브(#338)는 거부한다 — 단, 작성할 때만.** 엔진은 `realism/dead-knobs.test.ts` 의 `INERT`
레지스트리에 "사슬 기본에서 실행 경로가 없어 값을 바꿔도 bit-identical" 인 노브 **17개**를 계약으로
박제해 두고 있다(`decisionWeights.*` 8개 전부 · `softCap` · `variety.decisionTemperature` ·
`ball.shotSpeed` …). 이걸 통과시키면 운영자는 **①200 ②`changed` diff ③새 지문 ④원장 리비전
⑤하프 번들 지문 변경**까지 "적용됐다"는 신호를 다섯 개 받는데 경기는 한 비트도 안 바뀐다 — 그게
정확히 이 문서가 위험 근거로 인용한 #338 그 자체다. 러너는 이 목록을 복사본으로 들고(엔진은
QA #25 도메인이라 수정하지 않는다), **드리프트는 계약이 엔진 레지스트리 파일을 직접 읽어 집합
대조로** 막는다.

⚠️ **이 판정이 놓이는 계층이 중요하다**(독립검증 B2 — 초판 수습이 여기서 틀렸다). 무효 판정은
**작성 게이트**(`config-validate.ts:validateOverrides`, PUT·validate 가 부른다) 에만 둔다.
**병합 함수 `applyOverrides` = 재생 경로**이고 그 입력은 운영자가 방금 친 값이 아니라 **매치 생성
시점에 박제된 오버레이**다. 무효 여부는 **엔진 버전에 따라 변하는 잣대**이고(0.24.0 이 17개를 한
번에 LIVE→INERT 로 옮겼다 — 가정이 아니라 전례다), 변하는 잣대를 과거 데이터에 소급하면 엔진
업그레이드 한 번이 ①그 오버레이가 박힌 진행 중 매치 전부와 ②원장의 현재 리비전이 그 키를 담고
있는 한 이후 모든 신규 매치를 h1 에서 죽인다 = **#241 의 정확한 형태**. 그리고 막아서 **얻는 것이
0** 이다 — 값이 무효라 경기는 어차피 동일하고, 신규 작성은 작성 게이트가 이미 막는다. 계약도 둘로
나눠 박는다: "PUT/validate 는 INERT 를 거부한다" + **"이미 박힌 오버레이의 재생은 INERT 여부와
무관하게 성공한다"**.

⚠️⚠️ **같은 계층 오류가 한 겹 더 있었다 — 경로 실재 판정**(독립검증 B3). 위 수습은 INERT 만 옮겼는데,
"이 경로가 지금 `EngineConfig` 에 있는가" 역시 **엔진 배포마다 답이 바뀐다**. 엔진 0.26.0 이
`ball.settleSpeed` 를 **지웠다** — 그 오버레이가 박힌 매치를 재생하면 `applyOverrides` 가 "없는
경로"로 throw 하고, 러너 400 → `failMatch` 다. 이쪽이 INERT 보다 나쁘다: 원장의 현재 리비전이 그
키를 든 한 `pinForNewMatch()` 가 계속 박아 **이후 생성되는 모든 매치**가 h1 에서 죽고, 부팅·러너
교체 시 현재 리비전을 재검증하는 코드가 없어 **자동 복구 경로가 0** 이다(운영자가 유저 신고로
알아채야 끝난다).

**노브 삭제·개명은 사고가 아니라 엔진 열차의 정상 활동**이다(그래서 엔진에 죽은-노브 스냅샷
게이트가 있다 — 루트 §2.5). 정상 활동이 게임 루프를 멈추면 안 된다. 그래서 재생에서는
**거절하지 않고 버린다** — 다만 **조용히 버리지 않는다**:

| | 작성(`assertAuthorable`) | 재생(`applyOverrides`) |
|---|---|---|
| 미지·삭제된 경로 | **400** | **버리고 `droppedOverrides` 로 보고** |
| 타입 불일치 | **400** | 〃 |
| 구조 경로 | **400** | 〃 |
| 무효 노브(#338) | **400** | 통과(값이 무효라 경기가 어차피 같다) |
| 런타임 비용 상한 | **400** | **400** (성질이 다르다 — 아래) |

버린 사실은 러너 응답 → `match_halves.dropped_overrides_json` → 서버 WARN 세 곳에 남는다. 재현
계약은 `effectiveConfigHash`(실제로 돈 config **전체**의 지문)가 계속 완결시킨다 — 버린 경로가
있어도 "무엇으로 돌았나"의 답은 정확하다.

⚠️ 함수 이름을 `assertAuthorable` / `applyOverrides` 로 **갈라 둔 것 자체가 방어**다. 함수가 하나면
"여기 검사 하나 더 넣자"가 자연스러워 보이고 그 한 줄이 진행 중 매치를 죽인다 — 두 라운드 연속으로
그렇게 됐다(B2·B3). 이제 그러려면 **이름이 authoring 인 함수**를 골라야 한다.

**`matchMinutes` 는 거부 목록이다 — 상한이 아니라 노브 자체를 포기했다**(main 확정, W0 부록 2항).
이 값은 오버레이 중 **유일하게 런타임 비용을 정한다**: 러너는 단일 프로세스라
`{"matchMinutes":100000}` 한 줄이 스모크와 이후 모든 `/simulate` 를 분 단위로 붙잡아 **진행 중인
전 매치의 하프를 같이 세운다**(실측 8분+ 미완). 처음엔 틱 상한으로 막았는데, 그 상한이
`matchMinutes × 60000 / msPerTick` 이고 `msPerTick` 은 **구조값**(배포에서 온다)이라
**어제 통과한 값이 오늘 무효가 되는** 축을 새로 만들었다(독립검증 M-A — Tier C 0.25초 물리로 가면
허용 상한이 900분→225분). 노브 하나를 포기해 그 축을 통째로 없앴다: 경기 길이를 무배포로 실험할
일은 없고, 계수 튜닝이라는 이 기능의 목적과도 무관하다. **덤으로 러너를 재우는 표면과 그 상한을
지키던 코드·계약이 전부 사라졌다.**

**거부 경로(구조 가드 — 델리게이션 ③)**: `version` · **`matchMinutes`**(위 참조) · `msPerTick` · `fixedScale` · `coordMode` ·
`gridSize` · `pitch.*` · `formations.*`. 이들은 좌표계·직렬화·골든·IFAB 계약의 전제이지 계수가
아니다. **`config.version` 이 지키라고 있는 것이 바로 이 축**이므로, 오버레이가 여기를 만지면
"버전은 같은데 구조가 다른 매치"가 생겨 버전 가드가 거짓말이 된다.

러너 병합은 `packages/server/src/runner/config-overlay.ts` 신설(엔진 무접촉):

```ts
applyOverrides(defaultEngineConfig, overrides) → { config, hash, changed[] }
```

`hash` = `sha256(정본JSON(effective config))` 앞 16자. **오버레이가 아니라 유효 config 전체의
해시**다 — 러너 이미지가 바뀌어도(= 기본값이 바뀌어도) 값이 달라져야 하기 때문이다.

`SimulateResponse` 에 **optional** `effectiveConfigHash` 추가(구 러너 = 없음 = 서버가 관대 처리).

### ② server-java: 매치 생성 시점에 스냅샷을 **매치에 박는다**

이게 #241 재발 방지의 전부다. **런타임 조회가 아니라 값 복사**다.

```
매치 생성(BRIEFING) ── LiveEngineConfigService.current() ──▶ matches.config_overrides_json (값 복사)
                                                             matches.config_revision_id  (추적용)
      │
      ├─ h1 시뮬 ──▶ runner(configOverrides = 그 매치의 값)
      └─ h2 시뮬 ──▶ runner(configOverrides = 그 매치의 **같은** 값)   ← 라이브가 그 사이 바뀌어도 무관
```

`user_deck_json`(=매치 시점 덱 스냅샷, V1)과 **완전히 같은 관용구**다 — 이 리포는 이미 "진행 중
매치는 자기 스냅샷만 본다"를 덱에 대해 하고 있고, config 를 그 목록에 한 줄 더 넣는 것뿐이다.

**INSERT 지점은 셋**(`MatchService.createPracticeMatch` · `createLeagueMatch` · `createAwayMatch`
— `MatchService.java:255/286/333`). 세 곳 모두 한 헬퍼(`liveConfig.pinForNewMatch()`)를 쓰고,
**"세 곳"이라는 사실 자체를 계약으로 박는다**(아래 §7 T-J4) — 네 번째 모드가 생겼을 때 조용히
빠지면 그 모드만 계수가 안 먹는다.

### ③ 재현 계약: 하프 번들에 유효 config 를 기록한다

`match_halves` 에 `config_overrides_json`(그 하프에 실제로 보낸 오버레이) +
`effective_config_hash`(러너가 계산한 유효 config 지문) 추가.

- `matches.*` 는 **의도**(이 매치는 이걸로 돌기로 했다), `match_halves.*` 는 **실적**(실제로 이걸로
  돌았다). 두 축을 나누는 이유 = 구 러너·경합·재시도에서 둘이 갈라질 수 있고, 갈라진 사실이
  보여야 고칠 수 있다.
- **MatchLog(zod) 는 안 건드린다.** `configVersion` 그대로. 오버레이를 MatchLog 에 넣으면 엔진
  골든·뷰어·`packages/shared` 계약이 전부 움직이는데, 재현에 필요한 정보는 서버 번들에 있으면
  충분하다(재현 주체 = 서버).

**재개 무음 desync 가드**: `serializeCarry` 가 **오버레이 지문**(`overridesHash`)을 **optional 로**
싣고, `deserializeCarry` 는 **있을 때만** 이번 요청의 오버레이 지문과 대조한다.

⚠️ **비교 대상이 "병합된 config 전체"가 아니라 "오버레이"인 것이 핵심이다**(독립검증 B4 — 초판이
여기서 틀렸다). 유효 config 전체를 비교하면 **러너 이미지가 재배포되며 기본값이 한 글자만 달라져도**
지문이 바뀌므로, `config.version` 이 안 오르는 배포가 **오버레이를 한 번도 쓴 적 없는 진행 중 매치
전부**의 h2 를 죽인다 — 이 웨이브가 최우선 계약으로 내건 "아무도 안 보내면 오늘과 bit-identical"이
재배포 경계에서 거짓이 되고, 폭발 반경이 이 기능 사용자가 아니라 **전 유저**다. 게다가 그 민감도는
**과하다**: 무효 노브(#338) 하나를 지우는 배포는 경기가 bit-identical 이라 범프 사유가 없는데 유효
config 지문은 달라진다 — **경기가 같은 변화에 매치가 죽으면 그건 가드가 아니라 결함이다**. 그리고
그 방아쇠는 이미 큐에 있다(#393 의 처방이 정확히 "무효 노브를 정리하라"다).

가드가 물어야 하는 것은 하나다 — **h2 가 h1 과 같은 오버레이를 받았는가**. 그건 서버가 매치별로
통제하는 값이고 엔진 배포와 무관하다. 러너 기본값이 **진짜로 경기를 바꾸는** 변화는 `configVersion`
대조가 이미 잡는다(그 축은 그대로 남는다).

- 있는데 다르면 → throw(400 → 매치 FAILED). 진짜 버그일 때만 발화하며, **조용한 desync 보다
  시끄러운 실패가 낫다**(무음 desync 는 #154·#279·#306·#320 이 반복해 물린 함정이다).
- **없으면 통과**(구 resumeState = 배포 순간 비행 중이던 매치). 이 `.optional()` 한 글자가 #241
  재발 방지의 마지막 조각이다 — 이 웨이브 자체가 진행 중 매치를 죽이면 안 된다.

**재생 경로에는 오버레이 때문에 죽는 throw 가 하나도 없다.** 마지막까지 남아 있던 것은 런타임
비용 상한이었고, 초판은 그것을 *"이 값이 러너를 재우는가는 시간이 지나도 답이 안 바뀐다"* 는 근거로
재생에 남겼다 — **그 전제가 거짓이었다**(M-A, 위 §2). 재생에서 버리는 것으로 고칠 수도 있었지만
결국 **노브 자체를 거부 목록으로** 올려(W0 부록 2항) 그 축을 없앴다. 남은 코드가 그만큼 적다.

> **오버레이 때문에 죽는 throw 는 재생 경로에 0 개다.** 오버레이 판정은 전부 **작성 게이트**로
> 갔거나 **버린다**.
>
> ⚠️ 초판은 여기에 *"재생에 남는 throw = `configVersion` 불일치 하나"* 라고 썼는데 **그건 거짓이다**
> (독립검증 5차). `simulate()` 전 호출경로에는 넷이 있다: ①`resumeState` **zod 파싱 실패**
> ②`configVersion` 불일치 ③오버레이 지문 불일치 ④빈 스냅샷(`lastHashOf`). ②는 설계된 선존 #241 축,
> ③은 서버가 매치별로 통제하는 값이라 배포와 무관, ④는 **오버레이로 도달 불가**다 — 그 유일한
> 입력이던 `{"matchMinutes":0}` 이 이제 구조 경로로 **버려지기** 때문이다(W0 부록 2항). 6차가 지적한
> m-A("도달 가능한데 작성 게이트가 막을 뿐")가 그래서 **코드 없이 닫혔다** — 작성 게이트에 기대는
> 논거는 이 웨이브에서 세 번 뒤집혔으므로(B2·B3·M-A) 애초에 기대지 않는 편이 낫다.

### ④ 운영: 원장 + 멱등 + 검증 게이트

**표 하나 신설**(V37) — append-only 리비전 원장. "현재 값" = 최신 행.

```sql
CREATE TABLE engine_config_revisions (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,  -- 삽입 순서 = "최신 = 현재"의 유일한 기준
  id            TEXT NOT NULL UNIQUE,    -- ULID (매치가 config_revision_id 로 가리킨다)
  overrides_json TEXT NOT NULL,          -- 정본(키 정렬) 오버레이 전체 — 델타가 아니라 스냅샷
  effective_hash TEXT NOT NULL,          -- 러너가 계산해 준 유효 config 지문
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  reason        TEXT NOT NULL,           -- 운영 사유(필수)
  idem_key      TEXT,
  request_hash  TEXT NOT NULL,           -- 요청 원문 해시 — 멱등 판정의 유일 기준
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_engine_config_rev_idem ON engine_config_revisions(idem_key)
  WHERE idem_key IS NOT NULL;
```

⚠️ **PK 가 `seq` 이고 ULID 가 UNIQUE 인 것은 오타가 아니다.** 이 표는 **정렬이 곧 동작**이다 —
최신 행 하나가 다음 매치에 박히는 값이라, 동률이 나면 잘못된 계수가 남은 채 **롤백이 무시된다**.
후보 둘 다 동률에서 깨진다: `created_at` 은 `Instant.toString()` 이 나노초 0 이면 소수부를 생략해
사전순이 뒤집히고(m2), **ULID 는 48bit ms + 80bit 난수라 같은 밀리초 안에서는 난수가 순서를
정한다**(3차 게이트에서 실제로 발화 — 연달아 친 롤백이 반반 확률로 무시됐다). SQLite `rowid` 로도
되지만 그건 문서화된 보장이 아니라 구현 세부이고 `VACUUM` 이 재배치할 수 있다(m10).
`(created_at, id)` 인덱스는 **두지 않는다**(m9) — 어느 쿼리도 안 쓸뿐더러 **코드가 의도적으로 기각한
정렬을 스키마가 광고하면** 다음 사람이 그걸 근거로 되돌린다.

- **왜 override 파일이 아니라 DB 인가**: economy(#209)가 파일을 쓴 이유는 **base 가 이미지에 구워진
  발행물**이라 "리로드만으로는 아무 일도 안 일어나기" 때문이다. 여기 base 는 컴파일된 상수이고
  오버레이는 순수 서버 상태다 — DB 가 정본이면 이력·멱등·트랜잭션이 공짜로 따라온다.
- **append-only 인 이유**: 매치가 `config_revision_id` 로 리비전을 가리키므로 UPDATE 가 있으면
  과거 매치의 근거가 소급으로 바뀐다. 롤백 = **직전 내용을 새 리비전으로 다시 쓰는 것**(원장에
  롤백 사실이 남는다). "빈 오버레이 리비전" = 기본값 복귀.
- **감사 원장은 신설하지 않는다** — 시도·실패는 기존 `admin_ops_audit`(V18, 범용으로 열어 둔 표)에
  `action='engine_config_set' | 'engine_config_validate'`, `result='ok'|'failed'` 로 append.
  성공 내용의 정본은 리비전 표, "무슨 시도가 있었나"는 감사 원장 — economy 와 같은 분담이다.
- **멱등 판정 = `request_hash` 하나**(우편함 #323 의 교훈: 필드별 비교는 빠뜨린 필드가 곧 구멍).
  같은 키 + 같은 내용 → **200 + 기존 리비전**(새 행 없음). 같은 키 + 다른 내용 → **409**.
  DB 유니크 인덱스가 최종 백스톱(앱의 check-then-act 는 경합을 못 막는다 — V6·V14 의 교훈).

**검증 게이트 — `POST /config/validate`(러너 신설)**. Java 는 엔진을 못 돌리므로, 판정은 엔진을
가진 쪽이 한다.

```
PUT /api/admin/engine-config
  → 러너 POST /config/validate {overrides}
      ├─ 400: 미지 경로 / 타입 불일치 / 거부 경로 / 비유한수(NaN·Inf)  → 리비전 안 만든다(+감사 failed)
      └─ 200: {effectiveConfigHash, changed:[{path,from,to}], smoke:{…}}
  → 리비전 INSERT → 200
```

`smoke` = **후보 config 로 실제 짧은 시뮬을 돌린 구조 불변식 검사**(2 시드 × 전반):
예외 없음 · `tickSnapshots>0` · `events>0` · **양 팀** 패스 이벤트 ≥1 · 소유 전환 >0.
**밸런스 밴드는 보지 않는다** — 밴드를 맞추는 것이 hero 가 이 기능으로 하려는 일이므로, 여기서
밴드를 강제하면 기능이 자기 목적을 막는다. 여기서 막는 것은 **"경기가 성립하지 않는 값"** 뿐이다.

이 게이트가 없으면 오타 한 번이 **그 이후 생성되는 모든 매치**를 죽인다(진행 중 매치는 스냅샷이
보호하지만 신규는 아니다). 배포 게이트를 없앤 대가로 반드시 있어야 하는 대체 게이트다.

## 3. API (admin, 전부 `/api/admin/**` = `AdminInterceptor` 뒤)

| 메서드 | 경로 | 용도 |
|---|---|---|
| `GET` | `/api/admin/engine-config` | 현재 유효 오버레이 + 리비전 id + `effectiveHash` + 러너 `engineVersion` |
| `GET` | `/api/admin/engine-config/history?limit=` | 리비전 이력(누가·언제·왜·무엇을) |
| `GET` | `/api/admin/engine-config/knobs` | 오버레이 가능한 리프 경로 전수 + 현재 기본값 + 타입 (러너 위임) |
| `PUT` | `/api/admin/engine-config` | 오버레이 교체(전체 스냅샷). `Idempotency-Key` 헤더. body `{overrides, reason}` |
| `POST` | `/api/admin/engine-config/validate` | 드라이런 — 리비전 안 만들고 검증·스모크 결과만 |

- **PUT 은 전체 교체(PATCH 아님)**. 부분 병합은 "지금 뭐가 걸려 있나"를 운영자가 머릿속으로
  추적하게 만든다. `GET` → 수정 → `PUT` 이 유일한 루프고, 그래서 리비전 행이 항상 완결 스냅샷이다.
- `knobs` 를 여는 이유: hero 가 하네스에서 고른 경로 이름을 **추측 없이** 확인할 수 있어야 한다.
  이게 없으면 오타 → 400 → 사람이 소스를 뒤지는 왕복이 생긴다.
- `openapi.yaml` 에 admin 섹션(§847~)이 있으므로 **거기에 additive 로 추가**한다.
- **UI 없음** — curl 운영(우편함 #323 §8 선례). 운영 절차는 §9.

## 4. 데이터 모델 변경 요약

| 대상 | 변경 | 성격 |
|---|---|---|
| `packages/shared` | `SimulateRequest.configOverrides?` · `SimulateResponse.effectiveConfigHash?` | **additive optional** — 구 러너/구 서버 조합 전부 통과 |
| V37 | `engine_config_revisions` 표 신설 | additive |
| V37 | `matches` + `config_overrides_json`, `config_revision_id` | `ALTER TABLE ADD COLUMN`(테이블 재작성 없음 — CHECK 무변경) |
| V37 | `match_halves` + `config_overrides_json`, `effective_config_hash` | 동상 |
| 러너 resumeState | `overridesHash?` (internal) | optional — 구 상태 통과. ⚠️ **오버레이의** 지문이다(병합 config 아님, B4) |

⚠️ **마이그레이션 번호 경합**: main 최신은 `V36__league_daily_reward.sql`. `V37` 을 잡되, 병렬
세션이 선점하면 #319→#323 때처럼 리넘버 커밋으로 양보한다(머지 직전 재확인이 체크리스트).

## 5. 재현 계약이 유지되는 이유 (경로별 증명)

| 경로 | config 출처 | 오버레이가 바뀌면? |
|---|---|---|
| 신규 매치 h1 | `matches.config_overrides_json`(생성 시 복사) | 다음 매치부터 적용 |
| 같은 매치 h2 (승계) | **같은 컬럼** | 무영향 — 값 복사라 조회하지 않는다 |
| 같은 매치 h2 (교체 → 독립 시뮬) | **같은 컬럼** | 무영향 |
| 재시도(`retry`) | **같은 컬럼** | 무영향 |
| 리플레이/관전 | `match_halves.match_log_json`(이미 저장된 로그) | **재시뮬 자체가 없다** |
| 정산·전적·랭킹 | 저장된 스코어 | 무영향 |

**진행 중 매치가 오버레이 변경에 노출되는 경로가 0개**임은 "런타임 조회를 하지 않는다"는 **구조**로
보장된다 — 잊지 않기로 한 약속이 아니라, 읽을 곳이 그 매치의 행 하나뿐이라서다.

## 6. 기각한 대안

| 대안 | 기각 이유 |
|---|---|
| **매치에 유효 config 전문(全文)을 저장** | 매치당 수십 KB × 두 하프. 그리고 **거짓 안전감**을 준다 — 엔진 *코드* 가 바뀌면 같은 config 로도 재현이 안 되므로, config 전문은 재현을 보장하지 못한다. 그 축을 지키는 것은 `config.version` 이고 그건 그대로 둔다. 지문(해시)이면 드리프트 검출에 충분하다. |
| **러너를 stateful 하게(러너가 라이브 오버레이를 보유)** | 러너는 무상태 RPC 라는 것이 ADR-1 의 계약이다. 상태를 주면 "h1 과 h2 사이에 러너가 재기동" = 재개 불능이 된다. 권위는 Java 하나다. |
| **env var 로 계수 주입 + 컨테이너 재시작** | 재시작이 곧 진행 중 매치의 in-flight 요청을 끊고, "언제 누가 왜"가 남지 않는다. 무배포가 아니라 **짧은 배포**다. |
| **`config.version` 을 오버레이마다 범프** | 그 순간 진행 중 매치의 resumeState 가 전부 거부된다 = **#241 을 기능으로 재현**하는 것. 오버레이는 데이터로 취급한다(델리게이션 ③). |
| **중첩 JSON deep-merge** | §2① 의 네 가지 — 특히 오타가 조용히 무시되는 것이 이 리포의 재발 함정이다. |
| **PATCH(부분 병합) API** | 리비전 행이 완결 스냅샷이 아니게 되고, 롤백이 "역연산 계산"이 된다. |

## 7. 게이트 · E2E-TDD 계약 (구현 전에 박는다)

**shared**
- `T-S1` `configOverrides` 미지정 요청이 기존 스키마와 동일 통과(구 요청 호환).
- `T-S2` 값 타입 위반(string/객체/배열)은 zod 거부.

**러너(packages/server)** — `npx vitest run packages/server`
- `T-R1` **등가 계약(최우선)**: 같은 요청을 ①`configOverrides` 없음 ②`{}` ③`undefined` 로 보내면
  `lastHash`·`matchLog`·`resumeState` 가 **전부 동일**(현행 bit-identical).
- `T-R2` 알려진 경로 하나를 바꾸면 `lastHash` 가 **달라진다**(= 주입이 실제로 먹는다 —
  "선언만 하고 미소비"를 잡는 #377 트랙 D 교훈의 기계화).
- `T-R3` 미지 경로·타입 불일치·거부 경로(`version`/`pitch.*`/`formations.*`/`fixedScale`)·NaN/Inf → 400.
- `T-R4` **오버레이 왕복 재개 동일성**: 오버레이 X 로 (h1→h2 분할) == 오버레이 X 로 (통짜) —
  기존 resume 계약을 오버레이 축에서 재확인.
- `T-R5` 해시 가드: h1 을 오버레이 X 로, h2 를 오버레이 Y 로 보내면 **throw**(무음 desync 금지).
- `T-R6` 지문(`overridesHash`) 없는 구 resumeState 는 **통과**(#241 재발 방지).
  ⚠️ 이 계약은 한 번 **통째로 공허했다**(5차 blocker): B4 가 필드를 개명했는데 테스트의
  `delete` 가 옛 이름을 지워 no-op 이었고, 가드를 필수로 굳혀도 전 스위트가 통과했다.
  지금은 **키 존재를 먼저 단언**해 개명이 여기서 먼저 깨진다.
- `T-R7` `/config/validate` 가 정상값에 200+`changed` diff. ⚠️ **발화 쪽은 판정 함수**(`smokeIssues`)를
  직접 태운다 — `matchMinutes` 거부 후 **게이트를 발화시킬 오버레이 입력이 사라졌다**(엔진이 견고해
  극단값에도 이벤트·패스·소유 전환을 계속 만든다: `speed.maxPerTick:0`·`ball.passSpeed:0`·
  `contest.passBase:0` 전부 ev≈200~450 실측). 발화 계약이 없으면 M4 로 되돌아가므로 판정을
  순수 함수로 분리해 결과를 지어내 태운다. 원문: **파괴적 값(`matchMinutes:1` — 경로도
  타입도 멀쩡하지만 돌려 보면 경기가 안 된다)에 400**. 이 스모크는 배포 게이트를 없앤 대가로 존재하는
  **유일한 대체 게이트**라 발화 경로에 계약이 없으면 조용히 죽는다.
- `T-R8` **무효 노브(#338) 전량 거부**(작성 게이트 `validateOverrides`) + 엔진 레지스트리와의 집합
  대조(드리프트 시 이름을 짚어 깨진다).
- `T-R8b` **그 거부가 재생 경로에는 없다** — `applyOverrides` 는 INERT 17개를 전부 받아들이고,
  그 오버레이는 실제로 경기를 바꾸지 않는다(둘 다 단언). 독립검증 B2 의 계약이고, **이게 없으면
  같은 실수가 재발한다**(작성 게이트를 병합 함수에 넣는 것은 자연스러워 보인다).
- `T-R9` **`matchMinutes` 는 구조 경로다** — 작성에서 거부(사유가 '구조 경로'다) · 상식적인 값도
  거부(상한이 아니라 축 자체를 없앴다) · `knobs` 목록에 아예 없음 · 같이 보낸 다른 노브는 산다.
  W0 부록 2항. 초판의 "비용 상한" 계약(구 T-R9/T-R13)을 **대체한다**.
- `T-R10` `/config/knobs` 응답에 **"목록이 실효를 보장하지 않는다"는 단서**(`caveat`)가 실린다
  (독립검증 M5 — 문서에만 두면 API 소비자는 목록을 전수로 믿는다).
- `T-R11` **엔진이 지운 노브가 박혀 있어도 재생은 성공**하고, 버린 경로가 `droppedOverrides` 로
  보고되며, 그 하프는 **오버레이 없이 돈 하프와 비트 동일**하다(버린 값이 몰래 새지 않는다).
  같은 값이 **작성에서는 여전히 400** 이라는 것도 같이 박는다 — 버리기가 작성 게이트를 무르게
  하면 안 된다. 독립검증 B3.
- `T-J9` 그 매치가 **FAILED 로 가지 않고**, `match_halves.dropped_overrides_json` 에 사실이 남고,
  같은 오버레이의 **살아 있는 노브는 그대로 적용**된다(하나가 죽어도 나머지는 산다).
  정상 경로에서는 그 컬럼이 NULL 이다(이 기록이 소음이 되면 아무도 안 본다).
- `T-R12` **오버레이 0건 매치는 러너 기본값이 달라져도 h2 가 산다** + `config.version` 이 오르면
  여전히 거부 + **오버레이가 달라지면 여전히 죽는다**(가드가 무르지 않았다). 독립검증 B4.
- `T-J10` **같은 밀리초에 들어온 리비전도 삽입 순서대로다** — 20회 루프 + "같은 ms 가 실제로
  발생했는지"의 전제 단언(전제가 사라지면 계약이 조용히 공허해진다).

**server-java** — `./gradlew test --rerun-tasks`(절대경로, memory `server-java-rerun-tasks-gate`)
- `T-J1` 오버레이 설정 → **그 전에 생성된** BRIEFING 매치의 h1·h2 요청에 **옛 값**이 실린다(#241 핵심).
- `T-J2` 오버레이 설정 후 생성된 매치는 **새 값**이 실린다.
- `T-J3` 매치 생성 후 오버레이를 두 번 더 바꿔도 그 매치의 h2 요청 오버레이는 **h1 과 동일**.
- `T-J3b` **하프 번들의 실적 지문이 실제로 저장된다** — 가짜 러너가 `effectiveConfigHash` 를 안 주면
  그 파싱·저장 경로가 한 번도 안 돌아 null 기록 변이체가 전 테스트를 통과한다(#385 와 같은 형태).
- `T-J4` **INSERT 지점 전수**: 세 생성 경로(practice·league·away) 모두 스냅샷이 채워진다 —
  판정은 코드 목록이 아니라 **`INSERT INTO matches` 를 소스에서 세어** 대조한다(구현과 검증이
  같은 목록을 공유하면 둘 다 틀려도 통과한다 — `AdminUnitPurgeTest` 선례).
- `T-J5` 멱등: 같은 키+같은 내용 → 200·행 1개 / 같은 키+**다른 내용** → 409.
- `T-J6` 검증 실패(러너 400)면 **리비전이 생기지 않고** 감사에 `failed` 가 남는다.
- `T-J7` 게이트: 비admin 토큰 403 / 미인증 401(경로가 `/api/admin/` 안 → `AdminRouteGuard` 자동).
- `T-J8` 오버레이 무설정(기본) 상태에서 러너 요청 본문에 `configOverrides` 키가 **아예 없다**
  (= 기존 배포와 완전 동일한 와이어).

**게이트 종합**: `npm test`(루트) · `npm run typecheck -w @hmb/server`(#235 — 루트 밖) ·
`./gradlew test --rerun-tasks` · **독립검증 module-verifier PASS(blocker 0)**.

## 8. 파급 · 경계 · 남는 갭 (과장 금지)

- **되는 것**: `EngineConfig` 의 number/boolean 리프 중 구조가 아닌 것. `contest.*`·`foul.*`·
  `vision.*`·`chain.*`(수치)·`clearance.maxProgress|minPressers` 등이 그 예다.
- ⚠️ **`decisionWeights.*` 는 되지 않는다** — 8개 전부 #338 INERT 다(사슬 기본에서 실행 경로 없음).
  이 문서 초판이 "사실상 전부"라고 쓴 것은 **틀렸다**(독립검증 B1). 지금 무엇이 무효인지는
  `GET /api/admin/engine-config/knobs` 의 `inertKnobs` 가 사유와 함께 답한다.
- ⚠️⚠️ **"설정 가능하다"와 "경기가 달라진다"는 다르다 — 이 문서는 후자를 약속하지 않는다.**
  초판이 "사실상 전부"라 썼고(B1), 2판이 "272개 중 17개 제외"라 썼다 — **같은 과장이 숫자만 작아진
  것**이다(독립검증 M5). `knobs` 목록이 거르는 것은 엔진 #338 레지스트리 **등재분뿐**이고, 독립검증
  전수 스윕(255개 × 8시드 × 극단섭동 → `matchLog` 전문 대조)은 등재 밖에서 **완전 무변화 노브 15개**를
  더 찾았다(`movement.pressRange`·`ball.passSpeed`·`fatiguePerTick`·`vision.markTargetBias` 등 —
  전체 목록·근거는 **#393**). 러너가 자체 판정하지 않는 이유는 무효의 SoT 가 엔진이고
  (흉내내면 두 진실이 갈라진다) 얕은 섭동은 조건부 LIVE 를 무효로 오분류하기 때문이다.
  **그러므로 적용 확인은 `changed` diff·새 지문이 아니라 실제 경기 관측으로 한다** — 이 기능이
  인용한 사고(#321·#337·#338)는 전부 "신호는 넷이나 왔는데 경기는 그대로"였다. 이 단서는 문서에만
  있으면 안 되므로 `/config/knobs` **응답의 `caveat` 필드로도 나간다**(계약 = `config-http.test.ts`).
  레지스트리가 #393 에서 교정되면 드리프트 가드가 러너를 **자동으로 따라오게** 만든다.
- **여전히 배포가 필요**: 엔진 **코드** 변경 · 새 노브 신설 · 포메이션/피치 기하 · `config.version`.
  그리고 **봇전 간이결과 모델(`power-divisor`)은 엔진 config 가 아니라 server-java 소유**라 이
  기능의 사정거리 밖이다(#252 참조) — "계수는 다 무배포"라고 말하면 거짓말이 된다.
- **여전히 남는 #241 축**: 엔진 코드 배포로 `config.version` 이 오르면 진행 중 매치의 resumeState 는
  여전히 거부된다. 이 웨이브는 그 **빈도를 낮출** 뿐 그 축을 고치지 않는다(별건 — #241).
- ⚠️ **resumeState 스키마에 필수 필드가 추가되면 진행 중 매치가 조용히 쓸려간다**(선존, **#395**).
  이 웨이브 소관은 아니지만 §8 이 "남는 갭"을 자처하는 이상 열거해야 한다 — 관측 가능성도 없다
  (배포 후 h2 들이 400 으로 죽을 뿐 원인이 로그에 안 뜬다).
- ⚠️ **러너를 롤백하면 무음 desync 다**(**#396**). h1 을 이 러너로 돌린 뒤 구 러너로 되돌리면,
  구 러너는 `SimulateRequest` 에 `configOverrides` 가 없어 zod 가 **조용히 버리고**(미선언 키 strip)
  `overridesHash` 도 안 본다 → **h2 가 오버레이 없이 돈다.** 앞으로 굴리는 배포는 `.optional()` 로
  안전하지만 되돌리는 배포는 아니다. 절차 = §9(오버레이를 `{}` 로 되돌린 뒤 롤백).
- ⚠️ **`POST /config/validate` 는 무인증이고 최대 14.3초 걸린다**(6차 m-B). 실측: `matchMinutes`
  45 → 0.37s · 300 → 2.40s · 899(상한 바로 아래) → **14.32s**. 원장에 아무것도 안 남기는 드라이런이라
  LAN 호출자가 **무제한 반복**할 수 있고, 러너는 단일 프로세스라 그동안 **진행 중 전 매치의 하프가
  뒤에 선다**. `matchMinutes` 거부는 *박히는* 값을 막지 이 표면을 막지 않는다(스모크는 기본 45분으로 돈다). 러너의 노출 등급은
  기존 `/simulate` 와 같지만(LAN), **비용 표면은 이 기능이 새로 만든 것**이다.
- ⚠️ **작성 게이트의 커버리지 = 2시드 × 전반뿐이다.** 배포 게이트를 없앤 대가로 둔 것이 이 스모크
  하나이고, 라이브 시드에서만 터지는 값은 못 잡는다. 그때 그 매치는 FAILED 로 죽고 **원장은 그대로
  남아 이후 매치도 같은 길**을 간다(자동 복구 0 — 운영자의 PUT 이 유일한 출구). 스모크에 밴드를
  강제하지 않는 판단은 옳지만(밴드를 맞추는 것이 이 기능의 목적이다), **이 커버리지를 과신하면 안 된다**.
- ⚠️ **이 웨이브는 오버레이를 안 쓰는 매치에 대해 진짜로 no-op 이다** — 그 사실이 계약이다
  (`B4` describe). 초판은 재개 지문을 무조건 싣고 무조건 대조해 **러너 재배포가 전 유저의 h2 를
  죽이는** 실패 모드를 새로 만들었다. 지금은 오버레이 지문만 비교하므로, 오버레이가 0건인 매치의
  재개는 `origin/main` 과 같은 판정을 받는다.
- ⚠️ **엔진이 노브를 지우면 박힌 오버레이의 그 항목은 소리 없이가 아니라 "소리를 내며" 사라진다.**
  경기는 그 노브만 기본값으로 돌고, 사실은 `match_halves.dropped_overrides_json` + 서버 WARN 에
  남는다. **자동 복구는 아니다** — 원장의 현재 리비전은 여전히 죽은 키를 들고 있고, 그걸 치우는
  것은 운영자의 `PUT` 이다(§9 런북에 단계로 넣었다). 부팅·러너 교체 시점에 현재 리비전을 자동
  재검증하는 장치는 **이 웨이브 범위 밖**이다(별건). 이 축이 §8 에 없었던 것이 독립검증 B3 의
  절반이었다 — 실패 모드가 문서에도 계약에도 런북에도 없으면 "구조로 막았다"고 말할 수 없다.
- **web 무변경**. 운영은 curl.
- **AI 실행기 무영향** — 오버레이는 `TacticalInput` 이 아니라 엔진 config 다. 프롬프트 광고
  필드(`advertised-fields.test.ts`)와 무관.
- ⚠️ **러너에는 인증이 없다**(`runner-main.ts` 에 인증 코드 0줄, `SERVANT_TOKEN` 참조 0건 — 초판이
  "SERVANT_TOKEN 경계 안"이라고 쓴 것은 **틀렸다**, 독립검증 M3). 러너는 `infra/docker-compose.yml`
  이 호스트 `18790` 으로 퍼블리시하고 CF 터널은 `18080`(java)만 노출하므로 **LAN 스코프**다.
  신설 `GET /config/knobs` 는 그 범위에서 **무인증으로 튜닝값 전량을 노출**한다 — 노출 등급 자체는
  기존 `/simulate` 와 같지만, 다음 사람이 틀린 전제 위에 얹지 않도록 사실대로 적어 둔다.
  러너에 인증을 넣는 것은 이 웨이브 범위 밖(별건).
- ⚠️ **`matchMinutes` 는 무배포로 못 바꾼다**(W0 부록 2항). 경기 길이 변경은 배포다 — 이 노브만
  런타임 비용을 정해서 상한을 두려다 M-A 축을 만들었고, 노브를 포기하는 쪽이 쌌다.

## 9. 운영 절차 (배포 후 hero 루프)

```bash
# 0) 지금 뭐가 걸려 있나 + 만질 수 있는 경로 목록
curl -s $API/api/admin/engine-config           -H "$ADMIN"
curl -s $API/api/admin/engine-config/knobs     -H "$ADMIN" | jq '.knobs[] | select(.path|test("shoot"))'

# 1) 드라이런(리비전 안 생김) — 오타·파괴적 값이면 여기서 400
curl -s -X POST $API/api/admin/engine-config/validate -H "$ADMIN" -H 'content-type: application/json' \
  -d '{"overrides":{"contest.shootXgThreshold":0.07,"contest.shootRange":22}}' | jq
#    ⚠️ 예제에 `decisionWeights.*` 를 쓰지 마라 — 8개 전부 #338 INERT 라 **400** 이다(1차 B1).
#       만질 수 있는 경로는 위 0단계의 `knobs` 가, 못 만지는 경로는 `inertKnobs` 가 사유와 함께 답한다.

#    ⚠️ **엔진을 배포한 뒤에는 이 0~1단계를 한 번 돌려라** — 그 배포가 노브를 지웠거나 이름을
#       바꿨으면 지금 걸린 리비전의 그 항목이 조용히 무효가 된다(재생은 죽지 않고 버린다, B3).
#       이미 그런 하프가 있었는지는 아래로 본다:
#         sqlite3 $DB "SELECT match_id, half, dropped_overrides_json FROM match_halves
#                      WHERE dropped_overrides_json IS NOT NULL ORDER BY rowid DESC LIMIT 20;"
#       나오면 그 경로를 뺀 오버레이로 PUT 해서 원장을 정리한다(원장은 자동으로 안 고쳐진다).

#    ⚠️ **러너를 롤백하기 전에는 오버레이를 `{}` 로 되돌려라**(#396). 구 러너는 `configOverrides`
#       를 조용히 버리므로(zod 가 미선언 키를 strip 한다) 전반은 오버레이로, 후반은 기본값으로
#       도는 **무음 desync** 가 된다 — 어디에도 신호가 안 남는다.

# 2) 적용 — Idempotency-Key 를 항상 붙인다(재전송 안전)
curl -s -X PUT $API/api/admin/engine-config -H "$ADMIN" -H 'content-type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"overrides":{…}, "reason":"하네스 확정 계수 반영 — 슛 임계"}' | jq

# 3) 이력 / 롤백(= 직전 내용을 새 리비전으로 다시 쓴다. 기본값 복귀는 overrides:{})
curl -s "$API/api/admin/engine-config/history?limit=20" -H "$ADMIN" | jq
```

**적용 시점 = 이 호출 이후 생성되는 매치부터.** 진행 중 매치는 끝날 때까지 옛 값으로 돈다 —
운영자가 "왜 아직 안 바뀌었나"를 묻지 않도록 `PUT` 응답에 그 문장을 담는다.

## 10. 웨이브 분해

| 웨이브 | 범위 | 게이트 |
|---|---|---|
| **W0** | 이 문서 | **main 검사** ← 지금 |
| **W1** | shared 계약 additive + 러너 오버레이/검증/스모크 + `T-S*`·`T-R*` | vitest + typecheck(-w) |
| **W2** | V37 + `LiveEngineConfigService` + 세 INSERT 스냅샷 + `T-J1~J4,J8` | gradle `--rerun-tasks` |
| **W3** | admin API 5종 + 멱등 + 감사 + openapi additive + `T-J5~J7` | gradle + openapi diff |
| **W4** | 독립검증(module-verifier) → merge-ready 보고(SHA·게이트 수치 콜드 재실행) | blocker 0 |

W1 은 W2/W3 과 독립적으로 머지 가능하다(오버레이를 아무도 안 보내면 no-op) — 계약 프리즈 조율이
길어지면 이 순서가 완충이 된다.

---

## 부록: main 검사 항목 (동의/이견을 이 항목으로 달아 주면 된다)

1. **평평한 점경로 맵 vs 중첩 JSON** — §2①. 오타 무시 방지를 이유로 평평을 택했다.
2. **거부 경로 목록** — `version`·`msPerTick`·`fixedScale`·`coordMode`·`gridSize`·`pitch.*`·
   `formations.*`. 더 좁혀야 하나(예: `matchMinutes` 도 막을까)?
3. **스냅샷을 매치 생성 시점에** — 킥오프 시점이 아니라. 브리핑이 길면 그 사이 변경이 반영 안 된다.
4. **리비전 표 신설 vs `admin_ops_audit` 만으로** — 내용 정본은 별표, 시도 이력은 기존 원장(economy 분담과 동일).
5. **러너 `/config/validate` 신설** — 배포 게이트를 없앤 대체 게이트. 러너 표면이 하나 늘어난다.
6. **V37 번호 선점** — 병렬 세션 경합 시 리넘버로 양보.
