# QA 콘솔 설계안 (#191) — 세션별 QA 탭 + 게임 관전 + 피드백 왕복

> 상태: **웨이브1 설계 확정(2026-07-26 hero) — D1 코드/데이터 분리 · D4 순수이동 승인 · D9 자유문장=프롬프트+얇은 규약 · D10 요청/컨펌 후 생성. → 웨이브2 구현 착수.** SoT = 이슈 #191. owned-glob = `apps/web/**` + `tools/**` + 레지스트리.
> base = main `019612d` (v6). 엔진(`packages/engine/**`) 무접촉.

---

## 0. 한 줄 요약

**한 브라우저 탭**(`http://127.0.0.1:8300/qa/console`) 안에 좌측 탭 목록이 있고, 워커 세션들이 CLI 로 자기 탭을 등록한다.
hero 는 탭을 눌러 **① 뭘 봐야 하는지 읽고 ② 그 시점의 게임을 보고 ③ 그 자리에서 승인/거부/코멘트**를 남긴다.
세션은 `qa-tab.mjs wait` 를 백그라운드로 걸어두고, **피드백이 오면 그 프로세스가 종료되면서 세션이 자동으로 깨어나** 이어서 진행한다.

---

## 1. 문제 (지금 왜 안 되나)

실측 상태 — 지금 이 머신에서 동시에 도는 QA 하니스 포트:

```
8131/8132   design:preview (S1 관전 화면 디자인)
8161/8162   (다른 세션)
8231/8232   gameqa
8241/8242   (또 다른 세션)
```

1. **뭘 봐야 하는지 화면에 없다.** 하니스는 그냥 경기를 재생한다. "#182 코너에서 잔류 인원을 12'34" 에 봐라"는 맥락이 tmux 대화에만 있다.
2. **포트가 세션 수만큼 늘어난다.** hero 가 어느 포트가 누구 것인지 외워야 한다.
3. **컨펌 왕복이 tmux 창 순회다.** 세션 창을 찾아가 타이핑해야 하고, 그 피드백은 대화에만 남아 **세션 재시작 시 유실**된다.
4. **세션 쪽 폴링 수단이 없다.** 지금은 hero 가 창에 와서 말해줄 때까지 세션이 그냥 멈춰 있다.

체크아웃이 **16개로 물리적으로 분리**돼 있다는 점이 설계를 지배한다(git worktree 아님 — 각각 독립 클론):

```
/Users/peter.park/spider6/hmb-online   bug/176
/Users/peter.park/spider9/hmb-online   bug/181
/Users/peter.park/spider12/hmb-online  bug/182
/Users/peter.park/spider16/hmb-online  qa-console/base   ← 콘솔 호스트
```

→ **각 체크아웃의 `.qa-console/` 는 서로 안 보인다.** 레지스트리는 **모든 세션이 같은 파일을 보는 한 경로**여야 하고,
동시에 **git 밑**이어야 한다(hero 요구: 히스토리 · 환경 이동). 그 둘을 같이 만족시키는 형태 = §3.1.

---

## 2. 아키텍처

```
  워커 세션 A (spider6, bug/176)          워커 세션 B (spider12, bug/182)
  node tools/qa-tab.mjs register …        node tools/qa-tab.mjs register …
  node tools/qa-tab.mjs wait  --id 176-…  node tools/qa-tab.mjs wait --id 182-…
         │  파일 쓰기/폴링                        │
         └───────────────┬───────────────────────┘
                         ▼
        ~/hmb-qa-console/                  ← 고정 경로 · 자체 git 리포(§3.1)
          tabs/<tabId>.json                  탭 메타      (writer = 세션)
          feedback/<tabId>.jsonl             hero 피드백  (writer = 콘솔 서버, append-only)
          acks/<tabId>.json                  수신·처리상태 (writer = 세션)
          ↑ 변경마다 자동 커밋 → 히스토리·환경 이동 확보
                         ▲
                         │  읽기 + 피드백 append
      ┌──────────────────┴───────────────────┐
      │  콘솔 (spider16 = 호스트 체크아웃)     │
      │  tools/qa-console.mjs start           │
      │   ├─ API  127.0.0.1:8301  (/qa-api/*) │
      │   └─ vite 127.0.0.1:8300  (/qa/console)
      └──────────────────┬───────────────────┘
                         ▼
              hero: 브라우저 탭 1개
```

**match-log 는 복사하지 않는다.** 탭은 등록한 세션 체크아웃 안의 **절대경로**를 가리키고, API 가 그 파일을 읽어 서빙한다(경로 allowlist = `/Users/peter.park/spider*/hmb-online/**` + 스크래치패드). 세션이 로그를 재생성하면 콘솔은 다음 로드에서 자동으로 새 것을 본다.

---

## 3. 레지스트리 스키마

### 3.1 위치 — 버전 계약이 본질, 저장소는 수단 (hero 확정 2026-07-26)

모듈 분리의 본질은 **버전 계약**이다(hero): **QA 관리버전 ≥ main 버전**이 항상 성립하고, QA 는 자기 버전을
올리며 진행하다 "이 버전을 올린다"고 명시할 때 main 이 그 버전을 흡수(싱크)한다 → 그 시점에 같아지고 QA 는 다시 앞선다.
git 브랜치는 그걸 구현하는 **수단 중 하나**이고 필수가 아니다.

그래서 레지스트리에 필요한 조건은 딱 셋이다.

1. **한 경로** — 16 체크아웃이 같은 파일을 본다(라이브 전송 = 파일시스템, git 아님)
2. **git 기록** — 히스토리 · 다른 환경 복원
3. **main 의 브랜치 전환에 휩쓸리지 않음** — 워킹트리 안에 있으면 `git checkout` 한 번에 살아있는 탭·피드백이 디스크에서 사라진다

```
~/hmb-qa-console/            ← 그 자체가 작은 git 리포(git init). 고정 경로, 브랜치 전환 없음
  tabs/<tabId>.json
  feedback/<tabId>.jsonl
  acks/<tabId>.json
  console.pid / console.log  ← gitignore(런타임 산출물)
```

- **CLI 가 변경마다 자동 커밋**: `qa(182-corner-stay): register` · `… feedback #2 reject` · `… ack #2 working`
  → `git log --follow feedback/182-corner-stay.jsonl` = 그 탭의 QA 대화 전체 이력(조건 2)
- **원격은 나중에 붙일 수 있게 설정 가능**(`qa-tab.mjs sync`). 로컬 git 만으로도 히스토리는 성립하고,
  다른 환경 이동이 필요해지면 remote 를 지정해 push 한다 — hmb-online 의 ref 든 별도 리포든 **저장소는 수단**이다.
- 읽기는 파일 직접 → 라이브성 즉시. git 은 **기록 계층**이지 전송 계층이 아니다(커밋/푸시/풀 왕복을 전송에 쓰면 초 단위 지연 + 네트워크 의존).
- 경로 오버라이드 `$HMB_QA_CONSOLE_HOME`(E2E 는 tmp 로 격리 → 실 기록 오염 0).

**버전 계약의 구체형**

| 축 | 값 | 어디에 |
|---|---|---|
| QA 콘솔 관리버전 | `qaConsole@x.y.z` | `tools/qa-console/version.mjs` (SoT) |
| 레코드 producer | 각 탭·피드백에 `producer: "qaConsole@x.y.z"` | 레지스트리 레코드 |
| main 흡수 지점 | 릴리스 태그 + `docs/plan-v5/qa-console.md` 이력표 | 리포 |

레코드에 producer 를 박아두면 QA 버전이 올라가도 **구버전 기록이 계속 읽힌다**(스키마 진화 시 마이그레이션 기준).

**코드 / 데이터**

| | 무엇 | main 으로 |
|---|---|---|
| 코드 | `apps/web/src/qa/**` · `tools/qa-*.mjs` · 문서 | **버전 올릴 때만**(hero 모델). 릴리스 태그 후보 |
| 데이터 | tabs · feedback · acks | 안 간다(main 무접촉) |

**"모듈은 레포도 따로가 더 좋은가"** — 코드는 아니다. 한 리포에서 owned-glob + 버전 태그로 나누는 편이 계약
(`packages/shared`)·통합 게이트·태그 이력을 한곳에서 본다(v1~v6 이 증거). 따로 둘 값어치가 있는 건 **성격이 다른
산출물**(계속 쌓이는 로그성 데이터)뿐이고, 그건 위처럼 경로 분리로 새 리포 없이 같은 효과를 낸다.

### 3.2 `tabs/<tabId>.json` — writer = 세션, 원자적 tmp+rename

```jsonc
{
  "schemaVersion": 1,
  "tabId": "182-corner-stay",          // 사람이 읽는 id = <이슈>-<슬러그>. 파일명 = 잠금 단위
  "issue": 182,
  "title": "코너 전원 전진 → 잔류 1~3명",
  "session": "hmb:bug182",             // tmux 세션 라벨(hero 가 어느 창에 가면 되는지)
  "checkout": "/Users/peter.park/spider12/hmb-online",
  "branch": "bug/182",
  "status": "waiting",                 // draft | waiting | acked | resolved  (세션이 갱신)
  "summary": "코너킥에서 11명 전원이 박스로 올라가 잔류 0명이었다. 팀축/선수축/롤백 3층 + 잔류 지터로 1~3명 잔류.",
  "ask": "잔류 인원이 자연스러운가? 잔류 선수가 멍하니 서 있지 않은가?",
  "views": [                           // 관전 대상. 첫 항목이 기본 선택
    { "id": "after",  "label": "after (fix)",     "logPath": "/Users/peter.park/spider12/hmb-online/packages/engine/dev-viewer/e2e/fixture-real.json" },
    { "id": "before", "label": "before (0.19.0)", "logPath": "/Users/peter.park/spider12/hmb-online/.qa/before-182.json" }
  ],
  "watch": [                           // 확인 포인트 = 시점 + 무엇을 볼지 (콘솔에서 클릭 → 그 초로 seek)
    { "label": "첫 코너 — 수비 진영 잔류 확인", "tick": 754,  "view": "after" },
    { "label": "같은 장면 before",              "tick": 754,  "view": "before" },
    { "label": "두 번째 코너",                  "tick": 2042 }
  ],
  "createdAt": "2026-07-26T04:00:00Z",
  "updatedAt": "2026-07-26T04:31:12Z"
}
```

- `watch[].tick` 은 CLI 에서 `--seek 12:34` 로도 받는다(기존 `parseClockInput` 재사용 — `12:34` · `12'34"` · `754` 다 허용).
- `views[].logPath` 는 등록 시 **존재 검증**한다(없으면 register 실패 → 세션이 즉시 안다. "빈 화면인데 왜?" 방지).

### 3.3 `feedback/<tabId>.jsonl` — writer = 콘솔 서버만, append-only

```jsonl
{"seq":1,"at":"2026-07-26T04:20:03Z","verdict":"comment","body":"잔류는 되는데 3명 다 GK 옆에 뭉쳐 있다","view":"after","tick":760,"clock":"12'40\""}
{"seq":2,"at":"2026-07-26T04:31:44Z","verdict":"reject","body":"뭉침 먼저 고쳐라","view":"after","tick":760,"clock":"12'40\""}
```

- **`body` 는 그대로 세션 프롬프트가 된다**(hero 확정 ③): 세션은 `wait` 로 깨어나 이 문장을 *사용자 지시*로 받아 그대로 작업한다. 자연어가 1급 채널이고 버튼은 그 위에 얹힌 **선택 태그**다.
- `verdict` = `comment`(기본 = 전달) | `approve` | `reject`. **규약은 얇게 하나만**:
  `approve` = "다음 단계 진행해라" · `reject` = "고치고 다시 올려라"(body 필수).
  왜 두 태그를 두는가 — 자유문장만 오면 세션이 *진행/재작업* 갈림길을 문장 해석으로 추측해야 한다. 태그가 있으면 그 갈림길만 확정되고 나머지 뉘앙스는 전부 문장이 결정한다. 태그를 안 눌러도 동작한다(= `comment`, 문장대로 판단).
- `tick`/`clock`/`view` = "지금 보고 있는 장면 첨부"(기본 on). 세션이 그 초를 바로 재현할 수 있다.
- writer 가 하나(콘솔 서버 단일 프로세스)라 append 경합이 없다.

### 3.4 `acks/<tabId>.json` — writer = 세션만

```jsonc
{ "cursor": 2,                                    // seq 2 까지 수신
  "items": { "1": { "state": "done",     "note": "뭉침은 markGap 로 분리", "at": "…" },
             "2": { "state": "working",  "note": "재현 중",                "at": "…" } },
  "updatedAt": "…" }
```

writer 를 파일별로 하나로 못 박은 것이 **AC4(동시 다중 세션 충돌 없음)의 핵심**이다 — 두 프로세스가 같은 파일을 쓰는 경우가 설계상 없다.

---

## 4. CLI — `tools/qa-tab.mjs` (다른 세션이 쓰는 표면)

```bash
# ── 등록 (세션 시작 시 1회) ────────────────────────────────────────────
node tools/qa-tab.mjs register \
  --id 182-corner-stay --issue 182 \
  --title "코너 전원 전진 → 잔류 1~3명" \
  --summary-file .qa/182-summary.md          `# 또는 --summary "…"` \
  --ask "잔류 인원이 자연스러운가?" \
  --log  fixture-real.json@after:"after (fix)" \
  --log  .qa/before-182.json@before:"before (0.19.0)" \
  --point "12:34 첫 코너 — 잔류 확인" \
  --point "34:02 두 번째 코너"
# → 탭 URL 을 stdout 으로 출력: http://127.0.0.1:8300/qa/console?tab=182-corner-stay

node tools/qa-tab.mjs update  --id 182-corner-stay --summary-file …   # 부분 갱신(준 필드만)
node tools/qa-tab.mjs status  --id 182-corner-stay --set resolved
node tools/qa-tab.mjs list    [--json] [--mine]
node tools/qa-tab.mjs show    --id 182-corner-stay [--json]
node tools/qa-tab.mjs remove  --id 182-corner-stay

# ── 피드백 수신 ────────────────────────────────────────────────────────
node tools/qa-tab.mjs feedback --id 182-corner-stay [--unread] [--json]
node tools/qa-tab.mjs ack      --id 182-corner-stay --seq 2 --state working --note "재현 중"

# ── 폴링 (핵심) ────────────────────────────────────────────────────────
node tools/qa-tab.mjs wait --id 182-corner-stay --timeout 900
#   새 피드백이 있으면 즉시, 없으면 fs.watch + 1s 백업 폴링으로 대기.
#   피드백 도착 → JSON 을 stdout 에 쓰고 exit 0 / 타임아웃 → exit 3 / 탭 없음 → exit 4
```

**`wait` 가 왜 중요한가**: 세션이 이걸 `run_in_background: true` 로 걸면, **프로세스가 종료될 때 하네스가 세션을 자동으로 재호출**한다. `ScheduleWakeup` 으로 무조건 깨우는 폴링(비싸다 — 메모리 `patrol-static-not-claude`)이 필요 없다. 세션은 자기 차례가 올 때만 토큰을 쓴다.

권장 세션 루프(문서에 그대로 박아 다른 세션이 복붙):

```
0. hero 가 요청했거나 "탭 만들까요?" 컨펌을 받았을 때만 등록한다(D10 — 자율 생성 금지)
1. register  → 탭 URL 을 hero 에게 한 줄로 알린다
2. status --set waiting
3. wait --timeout 900  (백그라운드)  ← 여기서 세션은 잠든다
4. 깨어나면 feedback --unread → 처리 → ack --state working|done
5. **body 를 사용자 지시로 그대로 수행**한다. 태그가 approve 면 다음 단계, reject 면 고치고 update 후 2번으로,
   태그가 없으면(comment) 문장대로 판단해 진행
6. 끝나면 status --set resolved
```

---

## 5. 콘솔 서버 — `tools/qa-console.mjs`

```bash
node tools/qa-console.mjs start    # nohup 분리기동, pid 파일 기록, 8300/8301 고정
node tools/qa-console.mjs status   # 두 포트 health + pid 생존 + 탭 수
node tools/qa-console.mjs stop     # pid 파일의 PID 만 kill (pkill -f 패턴 금지 — 다른 세션 보호)
node tools/qa-console.mjs restart
```

- **127.0.0.1 고정 바인딩**(0.0.0.0 금지), 인증 없음 → 로컬 전용. **아티팩트/외부 호스팅 절대 금지**(메모리 `no-artifacts-for-hmb`).
- 재부팅/재시작 복구: 레지스트리가 파일이라 **`start` 한 번이면 탭·피드백·ack 전부 그대로 복원**된다. 세션은 `wait` 를 다시 걸면 `--since cursor` 로 놓친 피드백부터 받는다(유실 0).

### API (`127.0.0.1:8301/qa-api/*`)

| 메서드 | 경로 | 용도 |
|---|---|---|
| GET | `/qa-api/tabs` | 목록 + 피드백 수 + unread + ack 상태 + stale 판정 |
| GET | `/qa-api/tabs/:id` | 탭 전문 |
| GET | `/qa-api/tabs/:id/log/:viewId` | 그 뷰의 match-log JSON 스트림(gzip, allowlist 검증) |
| GET | `/qa-api/tabs/:id/feedback` | 피드백 이력 + ack |
| POST | `/qa-api/tabs/:id/feedback` | `{verdict, body, view, tick}` → seq 반환 |

UI 는 **2초 폴링**으로 목록/피드백을 갱신한다(SSE 대신 — 서버 재시작에도 알아서 붙고 부품이 적다).

---

## 6. 콘솔 UI (`apps/web`, dev 전용 라우트 `/qa/console`)

```
┌───────────────────────────────────────────────────────────────────────────┐
│ HMB QA 콘솔        탭 4 · 대기중 2 · 내 확인 필요 2          ⟳ 2s 자동갱신 │
├──────────────┬────────────────────────────────────────────────────────────┤
│ ● #176 데드볼 │ #182 코너 전원 전진 → 잔류 1~3명                [대기중]   │
│    대기중 💬1 │ hmb:bug182 · bug/182 · spider12 · 3분 전 갱신              │
│ ● #182 코너   │ ─────────────────────────────────────────────────────────  │
│    대기중 ←   │ 무엇을 고쳤나  코너킥에서 11명 전원이 박스로…               │
│ ○ #181 공휨   │ 봐줄 것        잔류 인원이 자연스러운가?                    │
│    완료 ✓     │ 확인 포인트   [12'34" 첫 코너 잔류] [34'02" 두 번째] ← 클릭 │
│ ⚠ #188 픽스처 │ ─────────────────────────────────────────────────────────  │
│    stale 6h   │  ( after (fix) ) ( before (0.19.0) )        ← 뷰 전환      │
│              │ ┌────────────────────────────────────────────────────────┐ │
│  [완료 접기]  │ │                    경기 캔버스                          │ │
│              │ │              (viewer-core 직접 마운트)                  │ │
│              │ └────────────────────────────────────────────────────────┘ │
│              │ ⏮ ◀5s ◀1s ▶ 1s▶ 5s▶ ⏭  12'34"  [===○=======]  0.1x…       │
│              │                                     ↑ #180 초/프레임 컨트롤 │
│              │ ─────────────────────────────────────────────────────────  │
│              │ 피드백  ☑ 지금 장면 첨부 (after · 12'34")                   │
│              │ ┌────────────────────────────────────────────────────────┐ │
│              │ │ 잔류는 되는데 3명 다 GK 옆에 뭉쳐 있다                   │ │
│              │ └────────────────────────────────────────────────────────┘ │
│              │ [✅ 승인]  [❌ 거부]  [💬 코멘트]                            │
│              │ ─────────────────────────────────────────────────────────  │
│              │ #2 04:31 ❌거부 "뭉침 먼저" — 세션 수신✓ 처리중             │
│              │ #1 04:20 💬코멘트 "…"      — 세션 수신✓ 완료               │
└──────────────┴────────────────────────────────────────────────────────────┘
```

- 좌측 = 탭 목록(상태 배지 · 미확인 피드백 수 · stale ⚠). `?tab=<id>` 딥링크 → 세션이 register 출력 URL 로 hero 를 정확한 탭에 보낸다.
- 확인 포인트 칩 클릭 = `hooks.seek(tick)`(정확히 그 초 — `jumpToTick` 은 3스냅샷 되감기라 안 쓴다. `qa-time-controls.ts` 주석 계약).
- 재생 컨트롤은 **#180 을 그대로 재사용**한다(`PlaybackControls` full 모드 + `qa-time-controls.ts`). 새로 만들지 않는다.

**세로 예산 = 경기 화면 우선**(hero 지시, 목업 v1 조정). 관전이 주인공이라 화면 크롬은 최소로 깎는다:
설명/확인포인트 패널은 3줄 고정 · 피드백 입력창은 1줄 높이(필요하면 드래그로 늘림) · **피드백 이력은 최신 1건만 펼치고 나머지는 접기**(`이전 피드백 N건 더 보기`). 캔버스 박스는 폭 전체를 쓰고 그 안에서 피치를 중앙 레터박스(폭을 좁히면 옆에 빈 구역이 생겨 오히려 작아 보인다). 1512×900 기준 피치 면적 **+30%**.

### 재사용 방식 (재발명 금지)

`MatchViewer.tsx` 안의 `VisualPlayback` 은 이미 `log: unknown` 을 받고 API 를 모른다 — 즉 **그대로 재사용 가능한 부품**이 프로덕션 파일 안에 갇혀 있다. 이걸 `src/match/VisualPlayback.tsx` 로 **순수 이동**(코드 무변경)하고 `MatchViewer` 는 import 만 바꾼다. 콘솔은 `clock={null}`(라이브 게이트 off)로 마운트한다.
→ QA 콘솔 = 게임 화면 = QA 뷰어가 **같은 코어**를 계속 공유한다(v6 의 "뷰어 SoT 수렴" 유지).

---

## 7. 옵션과 트레이드오프 (hero 판단이 필요한 지점)

| # | 결정 | 선택지 | 권장 | 근거·대가 |
|---|---|---|---|---|
| D1 | 레지스트리 위치 | (a) 리포 밖 전역(비-git) (b) main 워킹트리의 `.qa-console/` (c) **고정 경로 + 자체 git 리포 `~/hmb-qa-console/`** | **(c)** | 한 경로·git 기록·브랜치 전환 무영향 3조건 충족. (b)는 머지정책으로 충돌은 피해도 `git checkout` 에 살아있는 데이터가 날아간다. (a)는 이력이 안 남는다 |
| D2 | 픽스 PR 에도 QA 기록 남기기 | (a) 안 함 (b) `export` 로 `issues/qa-<tab>.md` (c) 이슈 코멘트 미러 | **(b) + `resolved` 시 이슈 요약 1건** | D1 로 이미 git 이력이 확보됐으므로 (c)는 보조. (b)는 QA 대화가 **고친 코드와 같은 PR**에 실려 main 히스토리에 남는다 |
| D3 | 콘솔 프로세스 구성 | (a) vite dev(8300) + API(8301), 2프로세스 (b) 정적 빌드 단일 프로세스 | **(a)** | 리포에 이미 검증된 패턴(`design-preview.mjs`) + 워커 세션이 콘솔 UI 를 고치면 HMR 로 즉시 반영. 대가: 프로세스 2개 감시 → `status` 동사로 커버 |
| D4 | `VisualPlayback` 재사용 | (a) 파일로 순수 이동 후 공유 (b) 콘솔에 별도 마운트 코드 | **(a) — hero 확정** | "게임을 매번 건드리는 게 아니다 — 게임 버전에서 브랜치를 따 QA 가 버전을 올리고, 버전 올릴 때 싱크하면 다시 같아진다"(hero). 즉 1회성 이동이고 싱크 지점에서 수렴한다. (b)는 배선 150줄 중복 → 영구 드리프트 |
| D5 | 세션 폴링 | (a) `wait` 블로킹 CLI + 백그라운드 (b) `ScheduleWakeup` 주기 폴링 | **(a)** | (b)는 조용할 때도 토큰을 태운다(메모리 `patrol-static-not-claude`). (a)는 피드백 도착 = 프로세스 종료 = 세션 자동 재진입 |
| D6 | before/after 비교 | (a) 뷰 전환 버튼 (b) 좌우 동시 재생 | **(a)** | (b)는 캔버스 2개 + 동기화 = 코드/성능 부담. 확인 포인트 칩이 `view` 를 지정하므로 "같은 초의 before" 를 두 클릭으로 왕복 가능 |
| D7 | 탭 정리 규약 | (a) `resolved` 후 48h 자동 아카이브 (b) 수동 `remove` 만 | **(a)+(b)** | 방치돼도 목록이 안 썩는다. `updatedAt` 6h 초과 + unread 있음 = `stale ⚠` 배지(세션 죽음 신호 → hero 가 안다) |
| D8 | 포트 | 8300(UI)/8301(API) 고정 | — | 실측 사용중 포트(8131·8161·8231·8241·8790대·18080대) 와 안 겹침. 고정이라 hero 가 하나만 외운다 |
| D9 | 피드백 성격 | (a) 정형 verdict 위주 (b) **자유문장 = 프롬프트, 태그는 선택** | **(b) — hero 확정** | hero 가 적은 문장이 그대로 세션 지시. `approve`/`reject` 는 *진행/재작업* 갈림길만 확정하는 얇은 규약(안 눌러도 동작) |
| D10 | 탭 생성 시점 | (a) 세션이 자율로 (b) **hero 요청 또는 컨펌 후** | **(b) — hero 확정** | 세션이 알아서 탭을 만들면 hero 화면이 안 본 탭으로 찬다. 기본은 "탭 만들까요?" 를 묻고, hero 가 요청하면 즉시 |

---

## 8. 테스트 계획 (웨이브2, E2E-TDD 먼저)

| 층 | 대상 | 파일 |
|---|---|---|
| 단위(vitest) | 탭 id 검증·부분 갱신 머지·`--seek` 파싱·경로 allowlist·ack 커서·stale 판정 | `tools/qa-console/registry.test.ts` 등 |
| 단위 | `wait` 의 since/타임아웃/exit code | `tools/qa-console/wait.test.ts` |
| E2E(playwright) | **AC1** CLI register → 콘솔에 즉시 표시 | `apps/web/e2e/qa-console-tab.spec.ts` |
| E2E | **AC2** 탭 선택 → 로그 로드 → 확인포인트 칩 클릭 → 시계가 그 초 | 동일 |
| E2E | **AC3** 피드백 입력 → jsonl → CLI `feedback --unread` 가 받음 → `ack` → 콘솔에 수신✓ 배지 | `qa-console-feedback.spec.ts` |
| E2E | **AC4** 3개 탭 동시 등록·각기 다른 로그·피드백 교차 → 섞이지 않음 | `qa-console-multi.spec.ts` |
| 게이트 | `npx vitest run` · `npm run typecheck` · `cd apps/web && npx playwright test e2e/qa-console-*.spec.ts` | 메모리 `web-e2e-live-specs-hit-demo` — **스펙 지정 + 대체 포트 + 전면 목킹**, 전체 e2e 금지 |
| 판정 | hero 시각 리뷰(콘솔 자체를 콘솔로 볼 수 없으니 이건 hero 직접) | — |

E2E 는 `HMB_QA_CONSOLE_HOME=<tmpdir>` 로 레지스트리를 격리해 **실제 hero 탭을 오염시키지 않는다**.

## 9. 스코프 밖 (이번에 안 함)

- 원격 접속·인증·멀티유저(로컬 전용).
- 세션 스폰/오케스트레이션(= QA 매니저 세션 소관, #191 운영구조).
- 콘솔에서 코드/커밋 보기, PR 조작.
- 엔진·뷰어 코어 수정.

## 10. 한 곳에서 볼 문서 (웨이브2 산출)

`docs/plan-v5/qa-console-playbook.md` — 다른 세션이 복붙하는 5줄 레시피 + 기동/복구/디버깅. 루트 CLAUDE.md §2.5 에 "QA 컨펌 채널 = QA 콘솔" 한 줄 추가.
